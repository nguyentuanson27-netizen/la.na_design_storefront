import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const ANONYMOUS_CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ANONYMOUS_CART_MAX_DISTINCT_ITEMS = 50;

const cartSelection = {
  id: true,
  userId: true,
  expiresAt: true,
  items: {
    select: {
      variantId: true,
      quantity: true,
    },
    orderBy: {
      createdAt: "asc" as const,
    },
  },
} as const;

type ExpectedMutationFailure =
  | { ok: false; reason: "INVALID_QUANTITY" }
  | { ok: false; reason: "CART_UNAVAILABLE" }
  | { ok: false; reason: "VARIANT_UNAVAILABLE" }
  | { ok: false; reason: "CART_LINE_LIMIT" };

type SetItemResult =
  | {
      ok: true;
      item: {
        variantId: string;
        quantity: number;
      };
    }
  | ExpectedMutationFailure;

/**
 * Re-resolves current commerce truth for one requested line **inside** the mutation transaction.
 *
 * Injected rather than imported so this module keeps owning only cart rows and locking. The
 * resolver is what turns any pre-transaction availability check into advice: catalog, stock and
 * price are read again under the same lock that commits the write, so a change between render and
 * mutation cannot produce an accepted-but-stale quantity.
 *
 * `snapshot` is the bounded non-PII analytics fact set for the accepted quantity, or `null` when
 * one cannot be produced safely. It is deliberately separate from `available`: analytics
 * availability is never cart availability.
 */
export type CartLineAuthorityResolver<TSnapshot> = (
  tx: Prisma.TransactionClient,
  input: { variantId: string; quantity: number },
) => Promise<{ available: boolean; snapshot: TSnapshot | null }>;

type UpdateExistingItemResult<TSnapshot> =
  | {
      ok: true;
      item: {
        variantId: string;
        quantity: number;
      };
      /** Committed quantity before this write, read under the same lock. */
      previousQuantity: number;
      snapshot: TSnapshot | null;
    }
  | { ok: false; reason: "INVALID_QUANTITY" }
  | { ok: false; reason: "CART_UNAVAILABLE" }
  | { ok: false; reason: "VARIANT_UNAVAILABLE" }
  | { ok: false; reason: "CART_ITEM_UNAVAILABLE" };

/**
 * One accepted PDP click: exactly one additional unit, with the transition it produced.
 *
 * `addedQuantity` is the literal `1`, not a field a caller may vary. A successful add is an
 * increment by definition, so an event built from this payload cannot report a committed total as
 * if it were the amount added, and no no-op or decrease can be labelled an AddToCart.
 */
type AddItemUnitResult<TSnapshot> =
  | {
      ok: true;
      previousQuantity: number;
      quantity: number;
      addedQuantity: 1;
      snapshot: TSnapshot | null;
    }
  | ExpectedMutationFailure;

type CreateWithItemResult =
  | {
      ok: true;
      cart: {
        id: string;
        expiresAt: Date;
      };
      item: {
        variantId: string;
        quantity: number;
      };
    }
  | Exclude<ExpectedMutationFailure, { reason: "CART_UNAVAILABLE" } | { reason: "CART_LINE_LIMIT" }>;

type CreateWithUnitResult<TSnapshot> =
  | {
      ok: true;
      cart: {
        id: string;
        expiresAt: Date;
      };
      previousQuantity: 0;
      quantity: 1;
      addedQuantity: 1;
      snapshot: TSnapshot | null;
    }
  | Exclude<ExpectedMutationFailure, { reason: "CART_UNAVAILABLE" } | { reason: "CART_LINE_LIMIT" }>;

/**
 * A removal that committed, with the facts captured **before** the row was deleted.
 *
 * `removedQuantity === 0` means the line was already gone. That is not a removal, and a caller must
 * not report one: nothing left the cart.
 */
type RemoveItemResult<TSnapshot> =
  | { ok: true; removedQuantity: number; snapshot: TSnapshot | null }
  | { ok: false; reason: "CART_UNAVAILABLE" };

type RawQueryClient = Pick<PrismaClient, "$queryRaw">;
type VariantReadClient = Pick<Prisma.TransactionClient, "variantMirror">;

function isPositiveDatabaseInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_POSTGRES_INTEGER;
}

function liveAnonymousCartWhere(cartId: string, now: Date) {
  return {
    id: cartId,
    userId: null,
    expiresAt: { gt: now },
  } as const;
}

function anonymousCartExpiresAt(now: Date): Date {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) {
    throw new TypeError("Anonymous cart creation time must be a valid timestamp");
  }

  const expiresAt = new Date(nowMs + ANONYMOUS_CART_TTL_MS);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new TypeError("Anonymous cart expiry must be a valid timestamp");
  }

  return expiresAt;
}

async function lockLiveAnonymousCart(
  client: RawQueryClient,
  cartId: string,
  now: Date,
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Cart"
    WHERE "id" = ${cartId}
      AND "userId" IS NULL
      AND "expiresAt" > ${now}
    FOR UPDATE
  `;

  return rows.length === 1;
}

async function isCommerceEligibleVariant(
  client: VariantReadClient,
  variantId: string,
): Promise<boolean> {
  const variant = await client.variantMirror.findFirst({
    where: {
      id: variantId,
      isPresent: true,
      isActive: true,
      OR: [
        {
          product: {
            isPresent: true,
            isActive: true,
          },
        },
        {
          compositeParents: {
            some: {
              parentVariant: {
                isPresent: true,
                isActive: true,
                product: {
                  isPresent: true,
                  isActive: true,
                },
              },
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  return variant !== null;
}

export function createAnonymousCartService(client: PrismaClient) {
  async function findLiveAnonymousCart(cartId: string, now: Date) {
    return client.cart.findFirst({
      where: liveAnonymousCartWhere(cartId, now),
      select: cartSelection,
    });
  }

  async function create({ now }: { now: Date }) {
    return client.cart.create({
      data: {
        userId: null,
        expiresAt: anonymousCartExpiresAt(now),
      },
      select: cartSelection,
    });
  }

  async function createWithItem({
    variantId,
    quantity,
    now,
  }: {
    variantId: string;
    quantity: number;
    now: Date;
  }): Promise<CreateWithItemResult> {
    if (!isPositiveDatabaseInteger(quantity)) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    return client.$transaction(async (tx): Promise<CreateWithItemResult> => {
      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const cart = await tx.cart.create({
        data: {
          userId: null,
          expiresAt: anonymousCartExpiresAt(now),
        },
        select: { id: true, expiresAt: true },
      });
      const item = await tx.cartItem.create({
        data: { cartId: cart.id, variantId, quantity },
        select: { variantId: true, quantity: true },
      });

      return { ok: true, cart, item };
    });
  }

  /**
   * Creates a fresh anonymous cart holding exactly one unit of an authorized option.
   *
   * The absent-line half of the PDP increment: there is no cart, so the transition is `0 → 1`. The
   * same in-transaction authority the existing-cart path uses decides whether that unit may be
   * committed, so a brand-new cart cannot skip the stock and price checks an existing one gets.
   */
  async function createWithUnit<TSnapshot>({
    variantId,
    now,
    resolveLine,
  }: {
    variantId: string;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<CreateWithUnitResult<TSnapshot>> {
    return client.$transaction(async (tx): Promise<CreateWithUnitResult<TSnapshot>> => {
      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const authority = await resolveLine(tx, { variantId, quantity: 1 });
      if (!authority.available) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const cart = await tx.cart.create({
        data: {
          userId: null,
          expiresAt: anonymousCartExpiresAt(now),
        },
        select: { id: true, expiresAt: true },
      });
      await tx.cartItem.create({
        data: { cartId: cart.id, variantId, quantity: 1 },
        select: { variantId: true },
      });

      return {
        ok: true,
        cart,
        previousQuantity: 0,
        quantity: 1,
        addedQuantity: 1,
        snapshot: authority.snapshot,
      };
    });
  }

  /**
   * Commits exactly one additional unit of an option into an existing live cart.
   *
   * This is deliberately not `setItemQuantity(..., 1)`. That mutation writes an absolute quantity,
   * so a line already holding four units would be reset to one while the caller still saw success —
   * a decrease reported as an add. Here the previous quantity is read under the cart lock, the
   * prospective `previous + 1` is authorized against current catalog, stock and price facts, and
   * only then committed. Every successful call therefore moved the line by exactly one.
   */
  async function addItemUnit<TSnapshot>({
    cartId,
    variantId,
    now,
    resolveLine,
  }: {
    cartId: string;
    variantId: string;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<AddItemUnitResult<TSnapshot>> {
    return client.$transaction(async (tx): Promise<AddItemUnitResult<TSnapshot>> => {
      if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
        return { ok: false, reason: "CART_UNAVAILABLE" };
      }

      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const existingItem = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { quantity: true },
      });

      if (!existingItem) {
        const distinctItemCount = await tx.cartItem.count({ where: { cartId } });
        if (distinctItemCount >= ANONYMOUS_CART_MAX_DISTINCT_ITEMS) {
          return { ok: false, reason: "CART_LINE_LIMIT" };
        }
      }

      const previousQuantity = existingItem?.quantity ?? 0;
      // A stored quantity outside the integer domain cannot be incremented into a trustworthy
      // one, and guessing a repair here would write money-bearing state from a corrupt read.
      if (!Number.isSafeInteger(previousQuantity) || previousQuantity < 0) {
        return { ok: false, reason: "INVALID_QUANTITY" };
      }

      const prospectiveQuantity = previousQuantity + 1;
      if (!isPositiveDatabaseInteger(prospectiveQuantity)) {
        return { ok: false, reason: "INVALID_QUANTITY" };
      }

      // Authorization is on the prospective total, not on the single added unit: one more unit of
      // something with one left in stock is not sellable just because the increment is small.
      const authority = await resolveLine(tx, { variantId, quantity: prospectiveQuantity });
      if (!authority.available) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId, variantId } },
        create: { cartId, variantId, quantity: prospectiveQuantity },
        update: { quantity: prospectiveQuantity },
        select: { variantId: true },
      });

      return {
        ok: true,
        previousQuantity,
        quantity: prospectiveQuantity,
        addedQuantity: 1,
        snapshot: authority.snapshot,
      };
    });
  }

  /**
   * Atomically adds a positive quantity delta to one cart line.
   *
   * Unlike an absolute set, this preserves units already in the cart. Unlike repeated one-unit
   * requests, the whole requested delta either commits or fails together after the prospective
   * total is re-authorized under the cart lock.
   */
  async function addItemQuantity<TSnapshot>({
    cartId,
    variantId,
    addedQuantity,
    now,
    resolveLine,
  }: {
    cartId: string;
    variantId: string;
    addedQuantity: number;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }) {
    if (!isPositiveDatabaseInteger(addedQuantity)) {
      return { ok: false as const, reason: "INVALID_QUANTITY" as const };
    }

    return client.$transaction(async (tx) => {
      if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
        return { ok: false as const, reason: "CART_UNAVAILABLE" as const };
      }

      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false as const, reason: "VARIANT_UNAVAILABLE" as const };
      }

      const existingItem = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { quantity: true },
      });

      if (!existingItem) {
        const distinctItemCount = await tx.cartItem.count({ where: { cartId } });
        if (distinctItemCount >= ANONYMOUS_CART_MAX_DISTINCT_ITEMS) {
          return { ok: false as const, reason: "CART_LINE_LIMIT" as const };
        }
      }

      const previousQuantity = existingItem?.quantity ?? 0;
      if (!Number.isSafeInteger(previousQuantity) || previousQuantity < 0) {
        return { ok: false as const, reason: "INVALID_QUANTITY" as const };
      }

      const prospectiveQuantity = previousQuantity + addedQuantity;
      if (!isPositiveDatabaseInteger(prospectiveQuantity)) {
        return { ok: false as const, reason: "INVALID_QUANTITY" as const };
      }

      const authority = await resolveLine(tx, { variantId, quantity: prospectiveQuantity });
      if (!authority.available) {
        return { ok: false as const, reason: "VARIANT_UNAVAILABLE" as const };
      }

      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId, variantId } },
        create: { cartId, variantId, quantity: prospectiveQuantity },
        update: { quantity: prospectiveQuantity },
        select: { variantId: true },
      });

      return {
        ok: true as const,
        previousQuantity,
        quantity: prospectiveQuantity,
        addedQuantity,
        snapshot: authority.snapshot,
      };
    });
  }

  async function createWithQuantity<TSnapshot>({
    variantId,
    addedQuantity,
    now,
    resolveLine,
  }: {
    variantId: string;
    addedQuantity: number;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }) {
    if (!isPositiveDatabaseInteger(addedQuantity)) {
      return { ok: false as const, reason: "INVALID_QUANTITY" as const };
    }

    return client.$transaction(async (tx) => {
      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false as const, reason: "VARIANT_UNAVAILABLE" as const };
      }

      const authority = await resolveLine(tx, { variantId, quantity: addedQuantity });
      if (!authority.available) {
        return { ok: false as const, reason: "VARIANT_UNAVAILABLE" as const };
      }

      const cart = await tx.cart.create({
        data: {
          userId: null,
          expiresAt: anonymousCartExpiresAt(now),
        },
        select: { id: true, expiresAt: true },
      });
      await tx.cartItem.create({
        data: { cartId: cart.id, variantId, quantity: addedQuantity },
        select: { variantId: true },
      });

      return {
        ok: true as const,
        cart,
        previousQuantity: 0,
        quantity: addedQuantity,
        addedQuantity,
        snapshot: authority.snapshot,
      };
    });
  }

  async function get({ cartId, now }: { cartId: string; now: Date }) {
    return findLiveAnonymousCart(cartId, now);
  }

  /**
   * Writes an absolute quantity for a line, creating it if absent.
   *
   * **Not a purchase path.** This is the primitive an absolute write is built from; it performs no
   * stock, price or catalog re-resolution of its own and it overwrites whatever the line held. The
   * PDP button uses `addItemUnit`, and the cart editor uses `updateExistingItemQuantity`, both of
   * which authorize the prospective quantity under the lock before committing.
   */
  async function setItemQuantity({
    cartId,
    variantId,
    quantity,
    now,
  }: {
    cartId: string;
    variantId: string;
    quantity: number;
    now: Date;
  }): Promise<SetItemResult> {
    if (!isPositiveDatabaseInteger(quantity)) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    return client.$transaction(async (tx): Promise<SetItemResult> => {
      if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
        return { ok: false, reason: "CART_UNAVAILABLE" };
      }

      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const existingItem = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { id: true },
      });

      if (!existingItem) {
        const distinctItemCount = await tx.cartItem.count({ where: { cartId } });
        if (distinctItemCount >= ANONYMOUS_CART_MAX_DISTINCT_ITEMS) {
          return { ok: false, reason: "CART_LINE_LIMIT" };
        }
      }

      const item = await tx.cartItem.upsert({
        where: {
          cartId_variantId: {
            cartId,
            variantId,
          },
        },
        create: {
          cartId,
          variantId,
          quantity,
        },
        update: {
          quantity,
        },
        select: {
          variantId: true,
          quantity: true,
        },
      });

      return { ok: true, item };
    });
  }

  /**
   * Commits an absolute requested quantity for an existing line.
   *
   * The cart editor keeps absolute-set semantics; only the PDP button is an increment. What changes
   * here is authority: whatever a rendered control or a public pre-check concluded, current
   * eligibility, stock sufficiency for the *requested* quantity and current price are re-resolved
   * under this lock before the write is accepted. `previousQuantity` is read in the same
   * transaction, so the delta a caller reports is the delta that actually committed.
   */
  async function updateExistingItemQuantity<TSnapshot>({
    cartId,
    variantId,
    quantity,
    now,
    resolveLine,
  }: {
    cartId: string;
    variantId: string;
    quantity: number;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<UpdateExistingItemResult<TSnapshot>> {
    if (!isPositiveDatabaseInteger(quantity)) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    return client.$transaction(async (tx): Promise<UpdateExistingItemResult<TSnapshot>> => {
      if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
        return { ok: false, reason: "CART_UNAVAILABLE" };
      }

      const existingItem = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { quantity: true },
      });

      if (!existingItem) {
        return { ok: false, reason: "CART_ITEM_UNAVAILABLE" };
      }

      if (!(await isCommerceEligibleVariant(tx, variantId))) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const previousQuantity = existingItem.quantity;
      if (!isPositiveDatabaseInteger(previousQuantity)) {
        return { ok: false, reason: "INVALID_QUANTITY" };
      }

      const authority = await resolveLine(tx, { variantId, quantity });
      if (!authority.available) {
        return { ok: false, reason: "VARIANT_UNAVAILABLE" };
      }

      const item = await tx.cartItem.update({
        where: { cartId_variantId: { cartId, variantId } },
        data: { quantity },
        select: { variantId: true, quantity: true },
      });

      return { ok: true, item, previousQuantity, snapshot: authority.snapshot };
    });
  }

  /**
   * Removes a line, capturing what left the cart **before** the row is gone.
   *
   * The order is the whole point: after the delete there is no quantity to report and no row to
   * resolve identity, name or price from, so a snapshot taken afterwards would either be missing or
   * reconstructed from something that is no longer the line that was removed.
   *
   * A removal is never refused for analytics reasons, and never for price or stock reasons either:
   * clearing an option that has become unavailable is exactly what a shopper needs to do. An
   * unsafe snapshot simply means no event.
   */
  async function removeItem<TSnapshot>({
    cartId,
    variantId,
    now,
    resolveLine,
  }: {
    cartId: string;
    variantId: string;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<RemoveItemResult<TSnapshot>> {
    return client.$transaction(async (tx): Promise<RemoveItemResult<TSnapshot>> => {
      if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
        return { ok: false, reason: "CART_UNAVAILABLE" };
      }

      const existingItem = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId } },
        select: { quantity: true },
      });

      // Nothing to remove is a successful no-op, not a removal. Reporting a RemoveFromCart here
      // would invent a departure from the cart that never happened.
      if (!existingItem) {
        return { ok: true, removedQuantity: 0, snapshot: null };
      }

      const removedQuantity = existingItem.quantity;
      const snapshot = isPositiveDatabaseInteger(removedQuantity)
        ? (await resolveLine(tx, { variantId, quantity: removedQuantity })).snapshot
        : null;

      await tx.cartItem.deleteMany({
        where: {
          cartId,
          variantId,
        },
      });

      return { ok: true, removedQuantity, snapshot };
    });
  }

  return {
    create,
    createWithItem,
    createWithUnit,
    createWithQuantity,
    get,
    setItemQuantity,
    addItemUnit,
    addItemQuantity,
    updateExistingItemQuantity,
    removeItem,
  };
}
