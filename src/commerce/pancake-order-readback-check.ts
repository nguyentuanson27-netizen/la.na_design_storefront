/**
 * Whether what Pancake stored is what was sent (GQ21).
 *
 * Lines are compared as a multiset keyed by `(variation, unit price)` with quantities summed per key,
 * so a POS that re-orders lines passes while one that merged two prices into one, averaged them,
 * dropped a line or moved a unit between prices does not. The total must be the sum of the expected
 * lines, and the POS's own `total_price`, when it reports one, must equal it too. Money is never
 * compared "approximately": a one-đồng difference is a drift.
 */

import type { PancakeOrderReadBack } from "../integrations/pancake/order-readback.ts";

export type ExpectedVendorLine = Readonly<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>;

export type ReadBackVerdict =
  | Readonly<{ kind: "MATCH" }>
  | Readonly<{ kind: "DRIFT"; detail: string }>;

const keyOf = (line: ExpectedVendorLine) => `${Buffer.byteLength(line.pancakeVariationId, "utf8")}:${line.pancakeVariationId}|${line.unitPriceVnd}`;

function summed(lines: readonly ExpectedVendorLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(keyOf(line), (totals.get(keyOf(line)) ?? 0) + line.quantity);
  return totals;
}

export function compareOrderReadBack(expected: readonly ExpectedVendorLine[], readBack: PancakeOrderReadBack): ReadBackVerdict {
  const want = summed(expected);
  const have = summed(readBack.lines);
  if (want.size !== have.size) return { kind: "DRIFT", detail: "line set differs" };
  for (const [key, quantity] of want) if (have.get(key) !== quantity) return { kind: "DRIFT", detail: "a line was merged, moved or changed" };

  const expectedTotal = expected.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  const readBackTotal = readBack.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  if (!Number.isSafeInteger(expectedTotal) || readBackTotal !== expectedTotal) return { kind: "DRIFT", detail: "merchandise total differs" };
  if (readBack.totalPriceVnd !== null && readBack.totalPriceVnd !== expectedTotal) return { kind: "DRIFT", detail: "order total differs" };
  return { kind: "MATCH" };
}
