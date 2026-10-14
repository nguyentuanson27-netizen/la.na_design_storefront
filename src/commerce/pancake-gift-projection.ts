/**
 * The Pancake projection of a benefit quote (ADR 0016 D-08, GQ20).
 *
 * The website quote stays exactly what the buyer proved: PAID segments at their exact prices and GIFT
 * lines at 0đ. For accounting convenience the owner wants every gift unit sent to Pancake at
 * `GIFT_VENDOR_UNIT_PRICE_VND` (1.000đ), with the same amount deducted from the paid goods so the
 * Pancake order total equals the website total exactly. This module is that outbound transformation
 * and nothing else: a pure function of the signed lines, so a retry produces the identical payload,
 * and the buyer-facing money, the proof, the analytics and the order snapshot never see the 1.000đ.
 *
 * Deduction (D-08 §2): `D = gift units x 1.000đ`. Paid units are visited from the most expensive to the
 * cheapest (then by `lineId`); each gives up `min(remaining, price - 1)` so no unit ever reaches 0đ.
 * A unit that gives up something becomes its own line and identical `(variation, price)` units are
 * grouped again. If the paid units cannot absorb `D` the projection is infeasible and the order is
 * not sent at all -- never averaged, never rounded to fit.
 *
 * Units are never enumerated: a line of `q` units at price `p` gives `c = p - 1` per unit, so the walk
 * is `floor(remaining / c)` units at price 1, at most one unit at a partial price and the rest
 * untouched. That is the same result as the unit-by-unit walk, in constant time per line.
 */

import { createHash } from "node:crypto";

/** The only place the 1.000đ lives; changing it is a code change plus an ADR amendment (D-08). */
export const GIFT_VENDOR_UNIT_PRICE_VND = 1000;

export type ProjectionLine = Readonly<{
  lineId: string;
  role: "PAID" | "GIFT";
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
}>;

export type VendorLine = Readonly<{
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
}>;

export type VendorProjection =
  | Readonly<{ ok: true; lines: readonly VendorLine[]; hash: string; paidTotalVnd: number }>
  | Readonly<{ ok: false; reason: "VENDOR_PROJECTION_INFEASIBLE" | "VENDOR_PROJECTION_INVALID" }>;

const MAX_PROJECTION_LINES = 400;

function isSafePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Deterministic text of the projected lines: what the hash covers and what is stored with the order. */
function canonicalVendorLines(lines: readonly VendorLine[]): string {
  return lines
    .map((line) => `${Buffer.byteLength(line.pancakeVariationId, "utf8")}:${line.pancakeVariationId}:${line.quantity}:${line.unitPriceVnd}`)
    .join("|");
}

export function hashVendorLines(lines: readonly VendorLine[]): string {
  return createHash("sha256").update(`pancake-projection-v1|${canonicalVendorLines(lines)}`).digest("hex");
}

export function projectBenefitQuoteForVendor(lines: readonly ProjectionLine[]): VendorProjection {
  const invalid = { ok: false as const, reason: "VENDOR_PROJECTION_INVALID" as const };
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_PROJECTION_LINES) return invalid;

  let giftUnits = 0;
  let paidTotalVnd = 0;
  const paid: ProjectionLine[] = [];
  const gifts = new Map<string, number>();
  for (const line of lines) {
    if (
      typeof line !== "object" ||
      line === null ||
      typeof line.lineId !== "string" ||
      typeof line.pancakeVariationId !== "string" ||
      line.pancakeVariationId.length === 0 ||
      !isSafePositive(line.quantity)
    ) {
      return invalid;
    }
    if (line.role === "GIFT") {
      if (line.unitPriceVnd !== 0) return invalid;
      giftUnits += line.quantity;
      gifts.set(line.pancakeVariationId, (gifts.get(line.pancakeVariationId) ?? 0) + line.quantity);
    } else if (line.role === "PAID") {
      if (!isSafePositive(line.unitPriceVnd)) return invalid;
      paidTotalVnd += line.quantity * line.unitPriceVnd;
      if (!Number.isSafeInteger(paidTotalVnd)) return invalid;
      paid.push(line);
    } else {
      return invalid;
    }
  }
  if (paid.length === 0) return invalid;

  let remaining = giftUnits * GIFT_VENDOR_UNIT_PRICE_VND;
  const ordered = [...paid].sort((left, right) =>
    right.unitPriceVnd - left.unitPriceVnd || (left.lineId < right.lineId ? -1 : left.lineId > right.lineId ? 1 : 0),
  );
  const grouped = new Map<string, { pancakeVariationId: string; unitPriceVnd: number; quantity: number }>();
  const add = (pancakeVariationId: string, unitPriceVnd: number, quantity: number) => {
    if (quantity <= 0) return;
    const key = `${pancakeVariationId.length}:${pancakeVariationId}:${unitPriceVnd}`;
    const existing = grouped.get(key);
    if (existing) existing.quantity += quantity;
    else grouped.set(key, { pancakeVariationId, unitPriceVnd, quantity });
  };
  for (const line of ordered) {
    const capacity = line.unitPriceVnd - 1; // what one unit can give up and still cost 1đ
    if (remaining === 0 || capacity === 0) {
      add(line.pancakeVariationId, line.unitPriceVnd, line.quantity);
      continue;
    }
    const full = Math.min(line.quantity, Math.floor(remaining / capacity));
    add(line.pancakeVariationId, 1, full);
    remaining -= full * capacity;
    let left = line.quantity - full;
    if (remaining > 0 && left > 0) {
      add(line.pancakeVariationId, line.unitPriceVnd - remaining, 1);
      remaining = 0;
      left -= 1;
    }
    add(line.pancakeVariationId, line.unitPriceVnd, left);
  }
  if (remaining > 0) return { ok: false, reason: "VENDOR_PROJECTION_INFEASIBLE" };
  // Gift units join the same grouping, so a gift and a deducted paid unit of one variation that land on
  // the same price become one line instead of two identical ones.
  for (const [pancakeVariationId, quantity] of gifts) add(pancakeVariationId, GIFT_VENDOR_UNIT_PRICE_VND, quantity);

  const projected: VendorLine[] = [...grouped.values()]
    .sort((left, right) =>
      left.pancakeVariationId < right.pancakeVariationId ? -1 : left.pancakeVariationId > right.pancakeVariationId ? 1 : right.unitPriceVnd - left.unitPriceVnd,
    )
    .map((entry) => ({ pancakeVariationId: entry.pancakeVariationId, quantity: entry.quantity, unitPriceVnd: entry.unitPriceVnd }));

  // The invariant that makes the projection safe to send: the vendor total is the website total.
  const projectedTotal = projected.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  if (projectedTotal !== paidTotalVnd) return invalid;
  return { ok: true, lines: projected, hash: hashVendorLines(projected), paidTotalVnd };
}
