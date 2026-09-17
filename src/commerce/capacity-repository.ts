/**
 * I1 — reading the website-owned selling policy (ADR 0014 §5.1, §13).
 *
 * The only job here is to get rows out of `ProductSellingPolicy` and hand them to
 * `resolveSellingPolicy()`. That indirection is the point of the module rather than an accident of
 * layering: **absence is the common case**, because §14 permits no backfill, and a column default
 * does not answer it — a default fires when a row is inserted, and a product with no row has had
 * none applied. So the missing-row answer needs exactly one producer, and every consumer has to go
 * through it or they will each invent their own and disagree.
 *
 * Reservation *writes* are deliberately absent. They need the §6.2 locking transaction — take the
 * always-present `VariantMirror` row first, then read the ledger — and the §6.4 guarded
 * compare-and-set for every state change. Both belong to I6a, and shipping a naive write here would
 * be worse than shipping none: it would look like the capacity gate while enforcing nothing.
 *
 * I2 adds the *policy* writes, which are a different kind of write entirely: one row per product,
 * no ledger, no concurrency hazard that a unique key does not already settle. They are here rather
 * than in a second module so that the resolver, the read and the write cannot disagree about what a
 * policy is.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  resolveSellingPolicy,
  type ResolvedSellingPolicy,
  type SellingMode,
  type StoredSellingPolicy,
} from "./capacity-policy.ts";
import { SellingPolicyError } from "./capacity-policy-input.ts";

const policySelect = { sellingMode: true, negativeStockLimit: true } as const;

export function createCapacityRepository(client: PrismaClient) {
  /**
   * The effective selling policy for one product.
   *
   * A product with no stored row resolves to `STANDARD` at `DEFAULT_NEGATIVE_STOCK_LIMIT`, which
   * reproduces today's behaviour exactly — that is what makes "no backfill" safe.
   */
  async function readSellingPolicy(productId: string): Promise<ResolvedSellingPolicy> {
    const stored = await client.productSellingPolicy.findUnique({
      where: { productId },
      select: policySelect,
    });
    return resolveSellingPolicy(stored satisfies StoredSellingPolicy | null);
  }

  /**
   * Effective policies for several products, keyed by product id.
   *
   * Every requested id appears in the result, including ones with no stored row: a caller iterating
   * a basket must not have to decide for itself what a missing key means, because deciding that is
   * precisely the job this module centralises. The map is built from the *requested* ids rather than
   * from the rows found, so absence can never silently drop a line.
   */
  async function readSellingPolicies(
    productIds: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedSellingPolicy>> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return new Map();

    const rows = await client.productSellingPolicy.findMany({
      where: { productId: { in: unique } },
      select: { productId: true, ...policySelect },
    });
    const storedByProductId = new Map(rows.map((row) => [row.productId, row]));

    return new Map(
      unique.map((productId) => [
        productId,
        resolveSellingPolicy(storedByProductId.get(productId) ?? null),
      ]),
    );
  }

  /**
   * Quantity currently held against a variant by reservations that still count.
   *
   * Read-only, and **not** the capacity gate: computing this outside the §6.2 locking transaction
   * tells you what was true at some past instant, not what is true at commit time. I6a recomputes it
   * inside the transaction that holds the variant lock. It is exposed here for operator views and
   * reconciliation, where an approximate answer is the right kind of answer.
   *
   * `COMMITTED` is excluded from the cheap SQL filter because whether it still holds depends on the
   * mirror catching up (§4.1), which is a per-row comparison `reservationHoldsCapacity()` owns —
   * so this deliberately reports the unambiguous holds only, and says so rather than rounding.
   */
  async function sumUnambiguouslyHeldQuantity(variantId: string): Promise<number> {
    const held = await client.variantCapacityReservation.aggregate({
      where: { variantId, state: { in: ["RESERVED", "SUBMITTING", "UNKNOWN"] } },
      _sum: { quantity: true },
    });
    return held._sum.quantity ?? 0;
  }

  /**
   * The product must be a visible product of this shop.
   *
   * The foreign key already guarantees the product *exists*; what it cannot say is whose it is.
   * `ProductSellingPolicy` carries no shop of its own — it is keyed by `productId` alone — so
   * without this check an admin of one shop could set a selling policy on another shop's product
   * and nothing in the schema would object. Matches `requireVisibleProducts()` in
   * `merchandising-repository.ts` rather than inventing a second predicate.
   */
  async function requireVisibleProduct(
    tx: Pick<PrismaClient, "productMirror">,
    shopId: number,
    productId: string,
  ): Promise<void> {
    const found = await tx.productMirror.findFirst({
      where: { id: productId, pancakeShopId: shopId, isPresent: true, isActive: true },
      select: { id: true },
    });
    if (found === null) throw new SellingPolicyError("selling-policy-invalid-product");
  }

  /**
   * ADR 0014 §11 — a composite parent may not be set to `OVERSELL` or `PREORDER`.
   *
   * The gate already refuses such a sale (`composite-oversell-unproven`) and I4 already keeps it off
   * the page, so nothing would oversell if this write were allowed. It is refused anyway, because
   * *storing* the intent would leave an operator looking at a product configured for preorder that
   * silently never preorders, with the reason living three modules away. A refusal at the boundary
   * tells them now.
   *
   * A product is a composite parent when any of its variants has components — the same predicate
   * `countProjectedCompositeParentVariations()` uses.
   */
  async function requireCompositeRestrictionSatisfied(
    tx: Pick<PrismaClient, "variantMirror">,
    productId: string,
    sellingMode: SellingMode,
  ): Promise<void> {
    if (sellingMode === "STANDARD") return;

    const compositeParent = await tx.variantMirror.findFirst({
      where: { productId, compositeComponents: { some: {} } },
      select: { id: true },
    });
    if (compositeParent !== null) {
      throw new SellingPolicyError("selling-policy-composite-restricted");
    }
  }

  /**
   * Set one product's selling policy.
   *
   * An upsert, because `productId` is unique: a second submission for the same product is the
   * operator changing their mind, not a duplicate to reject. Writing the whole row rather than
   * patching fields means a mode change can never land with the previous mode's limit still on it.
   *
   * It touches `ProductSellingPolicy` and nothing else. §5's "turning oversell off while stock is
   * negative preserves the negative value" is a property of *not writing stock*, so it is kept by
   * construction here rather than by a rule that could be forgotten.
   */
  async function saveSellingPolicy({
    shopId,
    productId,
    sellingMode,
    negativeStockLimit,
  }: {
    shopId: number;
    productId: string;
    sellingMode: SellingMode;
    negativeStockLimit: number;
  }): Promise<ResolvedSellingPolicy> {
    return client.$transaction(async (tx) => {
      await requireVisibleProduct(tx, shopId, productId);
      await requireCompositeRestrictionSatisfied(tx, productId, sellingMode);

      const stored = await tx.productSellingPolicy.upsert({
        where: { productId },
        create: { productId, sellingMode, negativeStockLimit },
        update: { sellingMode, negativeStockLimit },
        select: policySelect,
      });
      return resolveSellingPolicy(stored);
    });
  }

  /**
   * Remove a product's stored policy, returning it to **unconfigured**.
   *
   * Not the same as storing `STANDARD` at the default limit, and the difference is the point: §5.1
   * gives `isDefault` so an admin surface can show which products an operator has actually
   * reviewed. Without a clear path, a product that was configured once could never go back to
   * "not reviewed", and that distinction would decay into decoration.
   */
  async function clearSellingPolicy({
    shopId,
    productId,
  }: {
    shopId: number;
    productId: string;
  }): Promise<ResolvedSellingPolicy> {
    return client.$transaction(async (tx) => {
      await requireVisibleProduct(tx, shopId, productId);
      await tx.productSellingPolicy.deleteMany({ where: { productId } });
      // The missing-row answer, from the one resolver that owns it.
      return resolveSellingPolicy(null);
    });
  }

  return {
    readSellingPolicy,
    readSellingPolicies,
    sumUnambiguouslyHeldQuantity,
    saveSellingPolicy,
    clearSellingPolicy,
  };
}
