import type { VoucherPaidLine } from "./voucher-allocation.ts";
import type { VoucherCampaign } from "./voucher-campaign.ts";
import { voucherProofFactsFromQuote, voucherQuoteDigest, type VoucherProofFacts, type VoucherProofLine } from "./voucher-quote-proof.ts";
import { applyAllocationToLines, type VoucherQuote } from "./voucher-quote.ts";

/**
 * Voucher v1 (V12): the one place that turns a computed voucher quote into the facts a hold and a proof are bound to.
 *
 * The picker shows `digest`, the buyer's POST sends it back, and the hold flow recomputes it and compares: the
 * buyer consents to THIS quote (voucher ids and revisions, per-line prices, gift slots, shipping, total), not to a
 * total that two different quotes can share. The digest is not a secret and proves nothing by itself; the server
 * recomputes it on every POST.
 */

/** The proof binds the NUMBER of retained gift slots; the chosen gift variation stays with the checkout proof. */
export const GIFT_SLOTS_VARIATION = "gift-slots";

const stripSegment = (lineId: string) => lineId.replace(/\|v\d+$/, "");

export type VoucherQuoteFacts = Readonly<{
  paidLines: readonly Readonly<{ lineId: string; pancakeVariationId: string; quantity: number; unitPriceVnd: number }>[];
  giftSlots: number;
  proofLines: readonly VoucherProofLine[];
  /** PREVIEW facts: no hold ids. This is what every hold stores a digest of. */
  previewFacts: VoucherProofFacts;
  digest: string;
}>;

/** Null when the quote cannot be expressed as bounded, consistent proof facts. */
export function buildVoucherQuoteFacts(input: Readonly<{
  quote: Extract<VoucherQuote, { ok: true }>;
  campaigns: readonly VoucherCampaign[];
  lines: readonly VoucherPaidLine[];
  variationOfLine: ReadonlyMap<string, string>;
  paidRevision: bigint;
}>): VoucherQuoteFacts | null {
  const { quote, campaigns, lines, variationOfLine, paidRevision } = input;
  const paidLines = applyAllocationToLines(lines, quote.allocation).map((line) => ({
    lineId: line.lineId,
    pancakeVariationId: variationOfLine.get(stripSegment(line.lineId)) ?? "",
    quantity: line.quantity,
    unitPriceVnd: line.unitPriceVnd,
  }));
  if (paidLines.some((line) => line.pancakeVariationId === "")) return null;
  const giftSlots = quote.gifts.retainedSelectedSlots;
  const proofLines: VoucherProofLine[] = paidLines.map((line) => ({ pancakeVariationId: line.pancakeVariationId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd, role: "PAID" }));
  if (giftSlots > 0) proofLines.push({ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: giftSlots, unitPriceVnd: 0, role: "GIFT" });
  try {
    const previewFacts = voucherProofFactsFromQuote({ quote, campaigns, paidRevision, lines: proofLines });
    return { paidLines, giftSlots, proofLines, previewFacts, digest: voucherQuoteDigest(previewFacts) };
  } catch {
    return null;
  }
}
