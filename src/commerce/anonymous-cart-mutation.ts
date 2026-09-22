import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  createAnonymousCartCookieSession,
  type AnonymousCartCookieWrite,
} from "./anonymous-cart-cookie.ts";
import {
  createAnonymousCartService,
  type CartLineAuthorityResolver,
} from "./anonymous-cart.ts";

type WritableCartCookieStore = {
  get(name: string): { value: string } | undefined;
  set(cookie: AnonymousCartCookieWrite): void;
};

type MutationOptions = {
  production?: boolean;
};

type SetMutationResult =
  | {
      ok: true;
      cartId: string;
      expiresAt?: Date;
      item: { variantId: string; quantity: number };
    }
  | {
      ok: false;
      reason: "INVALID_QUANTITY" | "VARIANT_UNAVAILABLE" | "CART_LINE_LIMIT";
    };

type UpdateExistingMutationResult<TSnapshot> =
  | {
      ok: true;
      item: { variantId: string; quantity: number };
      previousQuantity: number;
      snapshot: TSnapshot | null;
    }
  | {
      ok: false;
      reason:
        | "INVALID_QUANTITY"
        | "CART_UNAVAILABLE"
        | "VARIANT_UNAVAILABLE"
        | "CART_ITEM_UNAVAILABLE";
    };

type AddUnitMutationResult<TSnapshot> =
  | {
      ok: true;
      cartId: string;
      expiresAt?: Date;
      previousQuantity: number;
      quantity: number;
      addedQuantity: 1;
      snapshot: TSnapshot | null;
    }
  | {
      ok: false;
      reason: "INVALID_QUANTITY" | "VARIANT_UNAVAILABLE" | "CART_LINE_LIMIT";
    };

type RemoveMutationResult<TSnapshot> =
  | { ok: true; removedQuantity: number; snapshot: TSnapshot | null }
  | { ok: false; reason: "CART_UNAVAILABLE" };

export function createAnonymousCartMutationService(
  client: PrismaClient,
  store: WritableCartCookieStore,
  options: MutationOptions = {},
) {
  const carts = createAnonymousCartService(client);
  const cookie = createAnonymousCartCookieSession(store, options);

  async function setItemQuantity({
    variantId,
    quantity,
    now,
  }: {
    variantId: string;
    quantity: number;
    now: Date;
  }): Promise<SetMutationResult> {
    const currentCartId = cookie.read();
    if (currentCartId) {
      const existingResult = await carts.setItemQuantity({
        cartId: currentCartId,
        variantId,
        quantity,
        now,
      });

      if (existingResult.ok) {
        return { ok: true, cartId: currentCartId, item: existingResult.item };
      }
      if (existingResult.reason !== "CART_UNAVAILABLE") {
        return existingResult;
      }
    }

    const createdResult = await carts.createWithItem({ variantId, quantity, now });
    if (!createdResult.ok) {
      return createdResult;
    }

    cookie.write({
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
    });

    return {
      ok: true,
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
      item: createdResult.item,
    };
  }

  /**
   * Adds exactly one unit, creating the anonymous cart only when the shopper has none.
   *
   * An expired or foreign cart id in the cookie behaves the same way it does for the absolute
   * mutation: the increment falls through to a fresh cart rather than failing, so the transition
   * reported is `0 → 1` for a cart that genuinely started empty.
   */
  async function addItemUnit<TSnapshot>({
    variantId,
    now,
    resolveLine,
  }: {
    variantId: string;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<AddUnitMutationResult<TSnapshot>> {
    const currentCartId = cookie.read();
    if (currentCartId) {
      const existingResult = await carts.addItemUnit({
        cartId: currentCartId,
        variantId,
        now,
        resolveLine,
      });

      if (existingResult.ok) {
        return {
          ok: true,
          cartId: currentCartId,
          previousQuantity: existingResult.previousQuantity,
          quantity: existingResult.quantity,
          addedQuantity: 1,
          snapshot: existingResult.snapshot,
        };
      }
      if (existingResult.reason !== "CART_UNAVAILABLE") {
        return existingResult;
      }
    }

    const createdResult = await carts.createWithUnit({ variantId, now, resolveLine });
    if (!createdResult.ok) {
      return createdResult;
    }

    cookie.write({
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
    });

    return {
      ok: true,
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
      previousQuantity: 0,
      quantity: 1,
      addedQuantity: 1,
      snapshot: createdResult.snapshot,
    };
  }

  /**
   * Adds the requested quantity delta atomically, preserving any units already in the cart.
   */
  async function addItemQuantity<TSnapshot>({
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
    const currentCartId = cookie.read();
    if (currentCartId) {
      const existingResult = await carts.addItemQuantity({
        cartId: currentCartId,
        variantId,
        addedQuantity,
        now,
        resolveLine,
      });

      if (existingResult.ok) {
        return {
          ok: true as const,
          cartId: currentCartId,
          previousQuantity: existingResult.previousQuantity,
          quantity: existingResult.quantity,
          addedQuantity: existingResult.addedQuantity,
          snapshot: existingResult.snapshot,
        };
      }
      if (existingResult.reason !== "CART_UNAVAILABLE") {
        return existingResult;
      }
    }

    const createdResult = await carts.createWithQuantity({
      variantId,
      addedQuantity,
      now,
      resolveLine,
    });
    if (!createdResult.ok) {
      return createdResult;
    }

    cookie.write({
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
    });

    return {
      ok: true as const,
      cartId: createdResult.cart.id,
      expiresAt: createdResult.cart.expiresAt,
      previousQuantity: 0,
      quantity: createdResult.quantity,
      addedQuantity: createdResult.addedQuantity,
      snapshot: createdResult.snapshot,
    };
  }

  async function updateExistingItemQuantity<TSnapshot>({
    variantId,
    quantity,
    now,
    resolveLine,
  }: {
    variantId: string;
    quantity: number;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<UpdateExistingMutationResult<TSnapshot>> {
    const cartId = cookie.read();
    if (!cartId) {
      return { ok: false, reason: "CART_UNAVAILABLE" };
    }

    const result = await carts.updateExistingItemQuantity({
      cartId,
      variantId,
      quantity,
      now,
      resolveLine,
    });

    if (!result.ok && result.reason === "CART_UNAVAILABLE") {
      cookie.clear();
    }

    return result;
  }

  async function removeItem<TSnapshot>({
    variantId,
    now,
    resolveLine,
  }: {
    variantId: string;
    now: Date;
    resolveLine: CartLineAuthorityResolver<TSnapshot>;
  }): Promise<RemoveMutationResult<TSnapshot>> {
    const cartId = cookie.read();
    if (!cartId) {
      return { ok: false, reason: "CART_UNAVAILABLE" };
    }

    const result = await carts.removeItem({ cartId, variantId, now, resolveLine });
    if (!result.ok) {
      cookie.clear();
    }
    return result;
  }

  return { setItemQuantity, addItemUnit, addItemQuantity, updateExistingItemQuantity, removeItem };
}
