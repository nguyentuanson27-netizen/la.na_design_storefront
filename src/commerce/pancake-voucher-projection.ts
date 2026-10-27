import type { VoucherPaidLine } from "./voucher-allocation.ts";
import type { EvaluatedCombination } from "./voucher-optimizer.ts";
import { projectBenefitQuoteForVendor, type ProjectionLine, type VendorLine } from "./pancake-gift-projection.ts";

/**
 * Voucher v1 (V09): can Pancake be told this exact money, to the VND? (spec §4.1 step 3, TG-02, AC-20)
 *
 * Pancake takes line prices only. A merchandise voucher is a total `D` that V02 already turns into per-line
 * price segments, so by the time it reaches the vendor it is just PAID lines at exact prices -- the same shape
 * the order submit already re-derives from the order's quote snapshot. This module runs that same pure
 * projection (`projectBenefitQuoteForVendor`, ADR 0016 D-08) on the COMPLETE quote -- voucher, gift offset and
 * shipping together -- and refuses anything the vendor cannot represent. It is fail-closed and never rounds:
 * an infeasible candidate is excluded before any hold exists and before any POS call.
 *
 * What this proves is the representation. That Pancake accepts, stores and reads back those lines unchanged is
 * H1-V, a separately authorized sandbox probe; until it passes, nothing may grant a submit-capable hold.
 */

export type VoucherVendorPaidLine = Readonly<{
  lineId: string;
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
}>;

export type VoucherVendorGift = Readonly<{ pancakeVariationId: string; quantity: number }>;

export type CompleteVoucherQuote = Readonly<{
  /** PAID segments AFTER the voucher (what the order snapshot stores). */
  paidLines: readonly VoucherVendorPaidLine[];
  gifts: readonly VoucherVendorGift[];
  /** The website's own totals; the vendor lines must reproduce the paid subtotal exactly. */
  expectedPaidSubtotalVnd: number;
  shippingFeeVnd: number;
  expectedTotalVnd: number;
}>;

export type VoucherVendorVerdict =
  | Readonly<{ ok: true; lines: readonly VendorLine[]; hash: string; paidTotalVnd: number }>
  | Readonly<{ ok: false; reason: "VENDOR_PROJECTION_INFEASIBLE" | "VENDOR_PROJECTION_INVALID" | "TOTAL_MISMATCH" }>;

function isWhole(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** Deterministic and order-independent: the same quote always yields the same lines and hash. */
export function canProjectExactMoney(quote: CompleteVoucherQuote): VoucherVendorVerdict {
  const invalid = { ok: false as const, reason: "VENDOR_PROJECTION_INVALID" as const };
  if (
    quote === null || typeof quote !== "object" || !Array.isArray(quote.paidLines) || !Array.isArray(quote.gifts) ||
    !isWhole(quote.expectedPaidSubtotalVnd, 1) || !isWhole(quote.shippingFeeVnd, 0) || !isWhole(quote.expectedTotalVnd, 1)
  ) {
    return invalid;
  }
  const lines: ProjectionLine[] = [];
  for (const line of quote.paidLines) {
    if (line === null || typeof line !== "object" || typeof line.lineId !== "string") return invalid;
    lines.push({ lineId: line.lineId, role: "PAID", pancakeVariationId: line.pancakeVariationId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd });
  }
  quote.gifts.forEach((gift, index) => {
    if (gift !== null && typeof gift === "object") {
      lines.push({ lineId: `gift|${index}`, role: "GIFT", pancakeVariationId: gift.pancakeVariationId, quantity: gift.quantity, unitPriceVnd: 0 });
    }
  });
  if (lines.length !== quote.paidLines.length + quote.gifts.length) return invalid;

  const projection = projectBenefitQuoteForVendor(lines);
  if (!projection.ok) return projection;
  // Shipping is not a vendor line: it rides the order. The vendor lines carry the paid subtotal and nothing else.
  if (projection.paidTotalVnd !== quote.expectedPaidSubtotalVnd || projection.paidTotalVnd + quote.shippingFeeVnd !== quote.expectedTotalVnd) {
    return { ok: false, reason: "TOTAL_MISMATCH" };
  }
  return projection;
}

/**
 * The feasibility predicate the quote/optimizer injects: for a combination, rebuild the complete quote from the
 * lines after the voucher and the gifts that would be sent, and ask `canProjectExactMoney`.
 */
export function createVoucherPosFeasibility(input: Readonly<{
  /** Pancake variation of each cart line, by `lineId` (the lines the quote was built from). */
  variationOfLine: ReadonlyMap<string, string>;
  /** The gift units that would ride this combination. */
  giftsOf: (evaluation: EvaluatedCombination) => readonly VoucherVendorGift[];
}>): (args: Readonly<{ evaluation: EvaluatedCombination; linesAfterVoucher: readonly VoucherPaidLine[] }>) => boolean {
  return ({ evaluation, linesAfterVoucher }) => {
    const paidLines: VoucherVendorPaidLine[] = [];
    for (const line of linesAfterVoucher) {
      // A split segment `<lineId>|v<n>` belongs to its source line.
      const source = line.lineId.replace(/\|v\d+$/, "");
      const pancakeVariationId = input.variationOfLine.get(line.lineId) ?? input.variationOfLine.get(source);
      if (pancakeVariationId === undefined) return false;
      paidLines.push({ lineId: line.lineId, pancakeVariationId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd });
    }
    return canProjectExactMoney({
      paidLines,
      gifts: input.giftsOf(evaluation),
      expectedPaidSubtotalVnd: evaluation.paidAfterVnd,
      shippingFeeVnd: evaluation.shippingFeeVnd,
      expectedTotalVnd: evaluation.totalPayableVnd,
    }).ok;
  };
}
