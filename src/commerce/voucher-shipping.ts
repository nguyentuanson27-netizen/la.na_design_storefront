import type { VoucherAllocation, VoucherPaidLine } from "./voucher-allocation.ts";
import type { VoucherScopeResolver } from "./voucher-scope.ts";

/**
 * Voucher v1 (V03): how vouchers and the existing shipping campaign interact (spec §4.1 steps 5-6).
 *
 * Pure helpers over facts the caller owns. The shipping campaign engine (`shipping-campaign.ts`) stays
 * the authority on the campaign fee; this module only decides which `hasOtherPromotions` it is asked
 * with for a given merchandise candidate (TG-10 B) and what a SHIPPING_FREE voucher then waives.
 */

/**
 * TG-10 B: a merchandise voucher that really lowers the price is one more "other promotion" for the
 * campaign guard `hasOtherPromotions AND NOT stackingEnabled`. A SHIPPING_FREE voucher is never counted
 * when its own fee is evaluated -- that would make it depend on itself.
 */
export function hasOtherPromotionsForCandidate(input: Readonly<{
  existingOtherPromotions: boolean;
  merchandiseDiscountVnd: number;
}>): boolean {
  return input.existingOtherPromotions || input.merchandiseDiscountVnd > 0;
}

/**
 * The paid subtotal a SHIPPING_FREE voucher's threshold is judged on: the in-scope paid lines AFTER the
 * chosen merchandise voucher (so a 600K minimum can be missed once a discount pulls the scope to 570K).
 * Gifts and shipping are never part of it.
 */
export function shippingScopeSubtotalAfterMerchandise(input: Readonly<{
  lines: readonly VoucherPaidLine[];
  resolver: VoucherScopeResolver;
  merchandise: VoucherAllocation | null;
}>): number {
  const deductions = new Map<string, number>(input.merchandise?.lines.map((entry) => [entry.lineId, entry.deductionVnd]) ?? []);
  let subtotal = 0;
  for (const line of input.lines) {
    if (!input.resolver(line.product)) continue;
    subtotal += line.quantity * line.unitPriceVnd - (deductions.get(line.lineId) ?? 0);
  }
  return subtotal;
}

export type ShippingVoucherOutcome =
  | Readonly<{ applies: true; waivedFeeVnd: number; feeAfterVnd: number }>
  | Readonly<{ applies: false; reason: "FEE_ALREADY_ZERO" | "BELOW_MINIMUM"; shortfallVnd: number | null; feeAfterVnd: number }>;

/**
 * SHIPPING_FREE waives 100% of the fee that is still payable. A voucher that would save 0đ (the campaign
 * already made shipping free) does not apply, so it is never selected, held or consumed (AC-10, EX-04).
 */
export function applyShippingVoucher(input: Readonly<{
  feeVnd: number;
  scopeSubtotalAfterVnd: number;
  minEligibleSubtotalVnd: number | null;
}>): ShippingVoucherOutcome {
  const { feeVnd, scopeSubtotalAfterVnd, minEligibleSubtotalVnd } = input;
  if (!Number.isSafeInteger(feeVnd) || feeVnd < 0 || !Number.isSafeInteger(scopeSubtotalAfterVnd) || scopeSubtotalAfterVnd < 0) {
    throw new RangeError("Invalid shipping voucher input");
  }
  if (feeVnd === 0) return { applies: false, reason: "FEE_ALREADY_ZERO", shortfallVnd: null, feeAfterVnd: 0 };
  if (minEligibleSubtotalVnd !== null && scopeSubtotalAfterVnd < minEligibleSubtotalVnd) {
    return { applies: false, reason: "BELOW_MINIMUM", shortfallVnd: minEligibleSubtotalVnd - scopeSubtotalAfterVnd, feeAfterVnd: feeVnd };
  }
  return { applies: true, waivedFeeVnd: feeVnd, feeAfterVnd: 0 };
}
