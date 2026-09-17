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
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  resolveSellingPolicy,
  type ResolvedSellingPolicy,
  type StoredSellingPolicy,
} from "./capacity-policy.ts";

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

  return { readSellingPolicy, readSellingPolicies, sumUnambiguouslyHeldQuantity };
}
