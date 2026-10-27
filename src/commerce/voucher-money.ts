import {
  allocateMerchandiseDiscount,
  validateVoucherPaidLines,
  type VoucherAllocation,
  type VoucherPaidLine,
} from "./voucher-allocation.ts";
import type { VoucherDiscount } from "./voucher-rule-validation.ts";
import type { VoucherScopeResolver } from "./voucher-scope.ts";

/**
 * Voucher v1 (V02): the merchandise discount `D` of one voucher on one cart (spec §4.1 steps 1-3).
 *
 * The input is the cart AFTER the legacy sale/tier engine, including the ORDER_SUBTOTAL ladder
 * (ADR 0016 D-12 / TG-11 A), and BEFORE shipping and gifts. This module never sees tier configuration
 * and never re-runs the ladder: the threshold `E` and the discount are measured on the post-tier price,
 * so a voucher that pulls the total under a ladder rung does not undo the rung (EX-09/EX-10).
 *
 * Pure; whole VND; BigInt for the percentage intermediate. A refusal is a typed reason, never a clamp.
 */

export type MerchandiseTerms = Readonly<{
  discount: VoucherDiscount;
  minEligibleSubtotalVnd: number | null;
}>;

export type MerchandiseIneligibleReason =
  | "NO_ELIGIBLE_LINES"
  | "BELOW_MINIMUM"
  | "ZERO_DISCOUNT"
  | "DISCOUNT_NOT_BELOW_SUBTOTAL"
  | "UNIT_PRICE_FLOOR";

export type MerchandiseDiscountResult =
  | Readonly<{ ok: true; discountVnd: number; eligibleSubtotalVnd: number }>
  | Readonly<{
      ok: false;
      reason: MerchandiseIneligibleReason;
      eligibleSubtotalVnd: number;
      /** For BELOW_MINIMUM: the in-scope spend still missing ("Đặt thêm Xđ"). */
      shortfallVnd: number | null;
    }>;

/** Sum of the in-scope paid lines (`E`) and their unit count. Shipping and gifts are never included. */
export function sumEligibleLines(
  lines: readonly VoucherPaidLine[],
  resolver: VoucherScopeResolver,
): Readonly<{ subtotalVnd: number; units: number }> {
  if (!validateVoucherPaidLines(lines)) throw new RangeError("Invalid voucher paid lines");
  let subtotalVnd = 0;
  let units = 0;
  for (const line of lines) {
    if (!resolver(line.product)) continue;
    subtotalVnd += line.quantity * line.unitPriceVnd;
    units += line.quantity;
  }
  return { subtotalVnd, units };
}

/**
 * `D` for a threshold-checked subtotal `E` of `units` paid units:
 *   FIXED       D = amount
 *   PERCENTAGE  D = round-half-up(E x percent / 100), then min(D, cap)
 * and the guard `0 < D < E` with every unit left at 1đ or more (`D <= E - units`).
 */
export function calculateMerchandiseDiscount(input: Readonly<{
  terms: MerchandiseTerms;
  eligibleSubtotalVnd: number;
  eligibleUnits: number;
}>): MerchandiseDiscountResult {
  const { terms, eligibleSubtotalVnd: subtotal, eligibleUnits: units } = input;
  const refuse = (reason: MerchandiseIneligibleReason, shortfallVnd: number | null = null): MerchandiseDiscountResult => ({
    ok: false,
    reason,
    eligibleSubtotalVnd: subtotal,
    shortfallVnd,
  });
  if (units === 0 || subtotal === 0) return refuse("NO_ELIGIBLE_LINES");
  const minimum = terms.minEligibleSubtotalVnd;
  if (minimum !== null && subtotal < minimum) return refuse("BELOW_MINIMUM", minimum - subtotal);

  let discount: number;
  if (terms.discount.type === "FIXED_AMOUNT_VND") {
    discount = terms.discount.amountVnd;
  } else {
    // round-half-up(E x p / 100) == floor((2 E p + 100) / 200)
    const half = (BigInt(2) * BigInt(subtotal) * BigInt(terms.discount.percent) + BigInt(100)) / BigInt(200);
    discount = Number(half);
    if (terms.discount.maxDiscountVnd !== null) discount = Math.min(discount, terms.discount.maxDiscountVnd);
  }
  if (discount <= 0) return refuse("ZERO_DISCOUNT");
  if (discount >= subtotal) return refuse("DISCOUNT_NOT_BELOW_SUBTOTAL");
  if (discount > subtotal - units) return refuse("UNIT_PRICE_FLOOR");
  return { ok: true, discountVnd: discount, eligibleSubtotalVnd: subtotal };
}

export type MerchandiseVoucherQuote =
  | Readonly<{
      ok: true;
      discountVnd: number;
      eligibleSubtotalVnd: number;
      /** Pre-voucher paid total `P` and the total after this voucher. */
      paidBeforeVnd: number;
      paidAfterVnd: number;
      allocation: VoucherAllocation;
    }>
  | Extract<MerchandiseDiscountResult, Readonly<{ ok: false }>>;

/** One merchandise voucher on one cart: threshold, `D`, and the exact per-line allocation. */
export function quoteMerchandiseVoucher(input: Readonly<{
  terms: MerchandiseTerms;
  resolver: VoucherScopeResolver;
  lines: readonly VoucherPaidLine[];
}>): MerchandiseVoucherQuote {
  const { terms, resolver, lines } = input;
  const eligible = sumEligibleLines(lines, resolver);
  const result = calculateMerchandiseDiscount({
    terms,
    eligibleSubtotalVnd: eligible.subtotalVnd,
    eligibleUnits: eligible.units,
  });
  if (!result.ok) return result;
  const allocated = allocateMerchandiseDiscount({ lines, resolver, discountVnd: result.discountVnd });
  if (!allocated.ok) {
    return { ok: false, reason: "UNIT_PRICE_FLOOR", eligibleSubtotalVnd: eligible.subtotalVnd, shortfallVnd: null };
  }
  const paidBeforeVnd = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  return {
    ok: true,
    discountVnd: result.discountVnd,
    eligibleSubtotalVnd: eligible.subtotalVnd,
    paidBeforeVnd,
    paidAfterVnd: paidBeforeVnd - result.discountVnd,
    allocation: allocated.allocation,
  };
}
