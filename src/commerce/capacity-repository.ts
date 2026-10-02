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

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { observeVariantAvailabilityCycles } from "./availability-cycle-repository.ts";
import { acquireCatalogSyncLock, CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS } from "./catalog-sync-lock.ts";
import {
  resolveSellingPolicy,
  type ResolvedSellingPolicy,
  type SellingMode,
  type StoredSellingPolicy,
} from "./capacity-policy.ts";
import { SellingPolicyError } from "./capacity-policy-input.ts";
import { deriveCompositeCapacitySnapshot } from "./composite-capacity.ts";

const policySelect = { sellingMode: true, negativeStockLimit: true } as const;

export function createCapacityRepository(
  client: PrismaClient,
  /**
   * I9 — when a policy change is observed. Injectable like the rest of the repository's
   * dependencies so a test can place a cycle boundary on a chosen Vietnamese day rather than
   * whichever one the suite happens to run on.
   */
  clock: () => Date = () => new Date(),
) {
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
   * `COMMITTED` is excluded because whether it still holds is a per-resource fact — its durable
   * mirror handoff (§4.1, `CapacityReservationResource.mirroredAt`), which `resourceHoldsCapacity()`
   * reads — so this deliberately reports the unambiguous holds only, and says so rather than
   * rounding. `readAdvisoryHeldQuantities()` is the per-resource answer.
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
  /**
   * I9 — re-observe every variant of a product after its selling policy changed.
   *
   * The catalog sync sees stock; only this path sees the mode. Owner rule 3 makes the operator's
   * toggle a cycle boundary in its own right — leaving preorder and returning to it while the
   * variant is still sold out starts a NEW cycle, even though the stock never moved — so a cycle
   * driven by stock transitions alone would miss it entirely.
   *
   * In the same transaction as the policy write, so a refused save cannot leave cycles describing a
   * mode the product does not have. The instant is passed in rather than read here: the caller's
   * clock is what the rest of the transaction is stamped with.
   */
  async function observePolicyChange(
    tx: Prisma.TransactionClient,
    shopId: number,
    productId: string,
    sellingMode: SellingMode,
    observedAt: Date,
  ): Promise<void> {
    const variants = await tx.variantMirror.findMany({
      where: { productId },
      select: {
        id: true,
        warehouseStocks: { select: { quantity: true } },
        compositeComponents: {
          select: {
            quantity: true,
            componentVariant: {
              select: {
                isPresent: true,
                product: {
                  select: {
                    pancakeShopId: true,
                    isPresent: true,
                  },
                },
                warehouseStocks: { select: { quantity: true } },
              },
            },
          },
        },
      },
    });
    if (variants.length === 0) return;

    await observeVariantAvailabilityCycles(
      tx,
      variants.map((variant) => {
        let stockNonPositive: boolean;
        if (variant.compositeComponents.length > 0) {
          const readiness = deriveCompositeCapacitySnapshot({
            shopId,
            components: variant.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              componentVariant: edge.componentVariant,
            })),
            sellingMode: "STANDARD",
            negativeStockLimit: 0,
          });
          stockNonPositive =
            readiness.reason !== "invalid-stock" &&
            readiness.reason !== "invalid-limit" &&
            readiness.readyQuantity <= 0;
        } else {
          const stock = variant.warehouseStocks.reduce((total, row) => total + row.quantity, 0);
          // Same rule as the sync: an unreadable total is not evidence of a sell-out, so it must not
          // open a cycle and publish a date the catalog cannot support.
          stockNonPositive = Number.isFinite(stock) && stock <= 0;
        }
        return {
          variantId: variant.id,
          stockNonPositive,
          isPreorder: sellingMode === "PREORDER",
        };
      }),
      observedAt,
    );
  }

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
    return client.$transaction(
      async (tx) => {
        await acquireCatalogSyncLock(tx, shopId);
        await requireVisibleProduct(tx, shopId, productId);

        const stored = await tx.productSellingPolicy.upsert({
          where: { productId },
          create: { productId, sellingMode, negativeStockLimit },
          update: { sellingMode, negativeStockLimit },
          select: policySelect,
        });
        const resolved = resolveSellingPolicy(stored);
        await observePolicyChange(tx, shopId, productId, resolved.sellingMode, clock());
        return resolved;
      },
      { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
    );
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
    return client.$transaction(
      async (tx) => {
        await acquireCatalogSyncLock(tx, shopId);
        await requireVisibleProduct(tx, shopId, productId);
        await tx.productSellingPolicy.deleteMany({ where: { productId } });
        // The missing-row answer, from the one resolver that owns it.
        const resolved = resolveSellingPolicy(null);
        // Clearing the policy returns the product to STANDARD, which ends any open cycle — the same
        // boundary as switching the mode explicitly.
        await observePolicyChange(tx, shopId, productId, resolved.sellingMode, clock());
        return resolved;
      },
      { timeout: CATALOG_SYNC_LOCK_WAITER_TIMEOUT_MS },
    );
  }

  return {
    readSellingPolicy,
    readSellingPolicies,
    sumUnambiguouslyHeldQuantity,
    saveSellingPolicy,
    clearSellingPolicy,
  };
}
