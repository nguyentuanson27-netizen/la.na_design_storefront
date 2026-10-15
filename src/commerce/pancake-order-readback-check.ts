/**
 * Whether what Pancake stored is what was sent (GQ21).
 *
 * Lines are compared as a multiset keyed by `(variation, unit price)` with quantities summed per key,
 * so a POS that re-orders lines passes while one that merged two prices into one, averaged them,
 * dropped a line or moved a unit between prices does not. The total must be the sum of the expected
 * lines, and the POS's own `total_price` must be reported and equal it too: an order total that is
 * missing or unreadable cannot be shown to include no order-level adjustment, so it confirms nothing
 * (`UNAVAILABLE`). Money is never compared "approximately": a one-đồng difference is a drift.
 */

import { PANCAKE_ORDER_CANCELED_STATUS, type PancakeOrderReadBack } from "../integrations/pancake/order-readback.ts";

export type ExpectedVendorLine = Readonly<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>;

export type ReadBackVerdict =
  | Readonly<{ kind: "MATCH" }>
  | Readonly<{ kind: "DRIFT"; detail: string }>
  | Readonly<{ kind: "UNAVAILABLE"; detail: string }>;

/** Which remote order the read-back must be about; supplied by every production caller. */
export type ReadBackIdentity = Readonly<{ orderId: string; shopId: number }>;

const keyOf = (line: ExpectedVendorLine) => `${Buffer.byteLength(line.pancakeVariationId, "utf8")}:${line.pancakeVariationId}|${line.unitPriceVnd}`;

function summed(lines: readonly ExpectedVendorLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(keyOf(line), (totals.get(keyOf(line)) ?? 0) + line.quantity);
  return totals;
}

export function compareOrderReadBack(
  expected: readonly ExpectedVendorLine[],
  readBack: PancakeOrderReadBack,
  identity?: ReadBackIdentity,
): ReadBackVerdict {
  // Money can match on an order that is not the one we mean, or one that no longer exists. The order's
  // own id and shop must be reported and be the requested ones, its status must be a known code, and a
  // canceled order (status 7) is never an order to confirm. No other status is given a meaning here: the
  // repository has no evidence for one (docs/integrations/pancake-order-status-reconciliation.md).
  if (identity !== undefined) {
    if (readBack.orderId !== identity.orderId || readBack.shopId !== identity.shopId) {
      return { kind: "UNAVAILABLE", detail: "the read-back does not identify the requested order and shop" };
    }
    if (readBack.status === null) return { kind: "UNAVAILABLE", detail: "the POS reported no readable order status" };
    if (readBack.status === PANCAKE_ORDER_CANCELED_STATUS) return { kind: "DRIFT", detail: "the POS order is canceled" };
  }
  const want = summed(expected);
  const have = summed(readBack.lines);
  if (want.size !== have.size) return { kind: "DRIFT", detail: "line set differs" };
  for (const [key, quantity] of want) if (have.get(key) !== quantity) return { kind: "DRIFT", detail: "a line was merged, moved or changed" };

  const expectedTotal = expected.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  const readBackTotal = readBack.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  if (!Number.isSafeInteger(expectedTotal) || readBackTotal !== expectedTotal) return { kind: "DRIFT", detail: "merchandise total differs" };
  if (readBack.totalPriceVnd === null || !Number.isSafeInteger(readBack.totalPriceVnd)) return { kind: "UNAVAILABLE", detail: "the POS reported no readable order total" };
  if (readBack.totalPriceVnd !== expectedTotal) return { kind: "DRIFT", detail: "order total differs" };
  return { kind: "MATCH" };
}
