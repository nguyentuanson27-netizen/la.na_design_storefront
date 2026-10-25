import type { VoucherAllocation, VoucherPaidLine } from "./voucher-allocation.ts";
import { canGrantVoucher, voucherRemaining, type VoucherCampaign } from "./voucher-campaign.ts";
import { quoteMerchandiseVoucher, type MerchandiseIneligibleReason, type MerchandiseVoucherQuote } from "./voucher-money.ts";
import {
  AUTO_SELECTION,
  createCombinationEvaluator,
  optimizeVouchers,
  type CombinationEvaluator,
  type EvaluatedCombination,
  type GiftOutcome,
  type MerchandiseOption,
  type OptimizerNotice,
  type ShippingOption,
  type VoucherCombination,
  type VoucherSelectionIntent,
} from "./voucher-optimizer.ts";
import { buildVoucherScopeResolver, type VoucherScopeResolver } from "./voucher-scope.ts";
import { shippingScopeSubtotalAfterMerchandise } from "./voucher-shipping.ts";

/**
 * Voucher v1 (V08): the canonical PREVIEW quote of vouchers on one cart.
 *
 * One pure function from (post-tier paid lines, active candidate campaigns, the shopper's selection intent, the
 * existing shipping/gift authorities) to the whole picture the picker, cart and checkout summary show: which
 * voucher of each group is chosen, why each other card is or is not available, the exact per-line allocation, the
 * shipping fee, the gift consequence and the total. Every number is computed once, on one snapshot, from the
 * same optimizer, so the surfaces cannot disagree.
 *
 * It is a PREVIEW by construction: `held` is always false and nothing here grants, reserves or signs anything.
 * A submit-capable quote needs the verified POS predicate and a hold (V09/V12); until then `isFeasible` is only
 * the seam. The browser never supplies money -- only the selection intent.
 */

export type VoucherCardReason =
  | "BELOW_MINIMUM"
  | "NOT_APPLICABLE"
  | "EXHAUSTED"
  | "FEE_ALREADY_ZERO"
  | "POS_INFEASIBLE"
  | "NOT_SELECTABLE";

export type VoucherCardState = Readonly<{
  campaignId: string;
  kind: VoucherCampaign["kind"];
  state: "SELECTED" | "AVAILABLE" | "UNAVAILABLE";
  reason: VoucherCardReason | null;
  /** "Đặt thêm Xđ": the in-scope spend still missing, from the server's own subtotal. */
  shortfallVnd: number | null;
  /** What choosing this card would save on the current snapshot. */
  savingVnd: number | null;
}>;

export type VoucherQuoteInput = Readonly<{
  /** Paid lines after legacy sale, quantity tiers and the order-value ladder (ADR 0016 D-12 / TG-11 A). */
  lines: readonly VoucherPaidLine[];
  /** Active campaigns the shopper may use: public ones plus any private one they entered. */
  campaigns: readonly VoucherCampaign[];
  selection?: VoucherSelectionIntent;
  /** The existing authority's "other promotion" flag (legacy, tier, gifts), without any voucher. */
  existingOtherPromotions: boolean;
  /** The shipping campaign engine's fee for a given `hasOtherPromotions` (TG-10 B is applied per candidate). */
  campaignShippingFeeVnd: (hasOtherPromotions: boolean) => number;
  /** Gift entitlement and the survival of saved choices on the lines AFTER the voucher (Q05). */
  giftOutcome: (linesAfterVoucher: readonly VoucherPaidLine[]) => GiftOutcome;
  /** Campaigns the attempt already holds: their own quota is not counted against them (spec §5.1). */
  heldCampaignIds?: ReadonlySet<string>;
  /** Injected POS exact-money predicate (V09). Absent means not wired: the quote stays preview-only. */
  isFeasible?: (evaluation: EvaluatedCombination) => boolean;
}>;

export type VoucherQuote =
  | Readonly<{
      ok: true;
      /** Always a preview: no hold, no timer, no submit-capable proof. */
      held: false;
      selection: VoucherCombination;
      paidBeforeVnd: number;
      merchandiseDiscountVnd: number;
      paidAfterVnd: number;
      shippingFeeBeforeVoucherVnd: number;
      shippingDiscountVnd: number;
      shippingFeeVnd: number;
      totalPayableVnd: number;
      /** NONE/NONE on the same snapshot. */
      baselineTotalVnd: number;
      voucherCount: number;
      /** Exact per-line deduction of the chosen merchandise voucher, or null. */
      allocation: VoucherAllocation | null;
      gifts: GiftOutcome;
      giftLoss: Readonly<{ entitledSlotsLost: number; selectedSlotsLost: number }> | null;
      confirmation: Readonly<{ totalIncreaseVnd: number; shippingFeeIncreaseVnd: number }> | null;
      notices: readonly OptimizerNotice[];
      cards: readonly VoucherCardState[];
    }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "BASELINE_UNAVAILABLE" | "NO_FEASIBLE_COMBINATION" }>;

/** The lines as the POS will see them: a line the voucher touched becomes at most two price segments. */
export function applyAllocationToLines(lines: readonly VoucherPaidLine[], allocation: VoucherAllocation | null): readonly VoucherPaidLine[] {
  if (allocation === null) return lines;
  const byLine = new Map(allocation.lines.map((entry) => [entry.lineId, entry]));
  const out: VoucherPaidLine[] = [];
  for (const line of lines) {
    const entry = byLine.get(line.lineId);
    if (entry === undefined || entry.deductionVnd === 0) {
      out.push(line);
      continue;
    }
    entry.segments.forEach((segment, index) =>
      out.push({ lineId: `${line.lineId}|v${index}`, product: line.product, quantity: segment.quantity, unitPriceVnd: segment.unitPriceVnd }),
    );
  }
  return out;
}

const CARD_REASON_OF: Readonly<Record<MerchandiseIneligibleReason, VoucherCardReason>> = {
  NO_ELIGIBLE_LINES: "NOT_APPLICABLE",
  BELOW_MINIMUM: "BELOW_MINIMUM",
  ZERO_DISCOUNT: "NOT_APPLICABLE",
  DISCOUNT_NOT_BELOW_SUBTOTAL: "NOT_APPLICABLE",
  UNIT_PRICE_FLOOR: "NOT_APPLICABLE",
};

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function buildVoucherQuote(input: VoucherQuoteInput): VoucherQuote {
  const { lines, existingOtherPromotions, campaignShippingFeeVnd, isFeasible } = input;
  const selectionIntent = input.selection ?? AUTO_SELECTION;
  const held = input.heldCampaignIds ?? new Set<string>();
  const campaigns = [...input.campaigns].sort(byId);
  const merchandiseCampaigns = campaigns.filter((campaign) => campaign.kind === "MERCHANDISE" && campaign.discount !== null);
  const shippingCampaigns = campaigns.filter((campaign) => campaign.kind === "SHIPPING_FREE");

  const resolverOf = new Map<string, VoucherScopeResolver>(
    campaigns.map((campaign) => [campaign.id, buildVoucherScopeResolver(campaign.scope, String(campaign.pancakeShopId))]),
  );
  const campaignOf = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  // Merchandise: each campaign alone, on the post-tier lines (TG-11 A: one shared base, never re-tiered).
  const merchandiseQuotes = new Map<string, MerchandiseVoucherQuote>();
  for (const campaign of merchandiseCampaigns) {
    merchandiseQuotes.set(
      campaign.id,
      quoteMerchandiseVoucher({
        terms: { discount: campaign.discount!, minEligibleSubtotalVnd: campaign.minEligibleSubtotalVnd },
        resolver: resolverOf.get(campaign.id)!,
        lines,
      }),
    );
  }
  const takeable = (campaign: VoucherCampaign, amountVnd: number) => held.has(campaign.id) || canGrantVoucher(campaign, amountVnd);

  const merchandiseOptions: MerchandiseOption[] = [];
  for (const campaign of merchandiseCampaigns) {
    const quote = merchandiseQuotes.get(campaign.id)!;
    if (quote.ok && takeable(campaign, quote.discountVnd)) merchandiseOptions.push({ id: campaign.id, discountVnd: quote.discountVnd });
  }
  const shippingOptions: ShippingOption[] = shippingCampaigns
    .filter((campaign) => held.has(campaign.id) || (voucherRemaining(campaign).uses ?? 1) >= 1)
    .map((campaign) => ({ id: campaign.id, minEligibleSubtotalVnd: campaign.minEligibleSubtotalVnd }));

  const allocationOf = (merchandiseId: string | null): VoucherAllocation | null => {
    if (merchandiseId === null) return null;
    const quote = merchandiseQuotes.get(merchandiseId);
    return quote !== undefined && quote.ok ? quote.allocation : null;
  };
  const scopeSubtotalAfter = (shippingId: string, merchandiseId: string | null) =>
    shippingScopeSubtotalAfterMerchandise({ lines, resolver: resolverOf.get(shippingId)!, merchandise: allocationOf(merchandiseId) });

  const paidBeforeVnd = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  const baseEvaluate = createCombinationEvaluator({
    paidSubtotalVnd: paidBeforeVnd,
    existingOtherPromotions,
    campaignShippingFeeVnd,
    shippingScopeSubtotalAfterVnd: scopeSubtotalAfter,
    giftOutcome: (_paidAfter, merchandiseId) => input.giftOutcome(applyAllocationToLines(lines, allocationOf(merchandiseId))),
  });
  // Budget is checked per combination: a shipping voucher waives 30K in one cell and 0 in another.
  const evaluate: CombinationEvaluator = (merchandise, shipping) => {
    const outcome = baseEvaluate(merchandise, shipping);
    if (!outcome.ok) return outcome;
    if (merchandise !== null && !takeable(campaignOf.get(merchandise.id)!, outcome.merchandiseDiscountVnd)) return { ok: false, reason: "EXHAUSTED" };
    if (shipping !== null && !takeable(campaignOf.get(shipping.id)!, outcome.shippingDiscountVnd)) return { ok: false, reason: "EXHAUSTED" };
    return outcome;
  };

  const optimized = optimizeVouchers({
    merchandise: merchandiseOptions,
    shipping: shippingOptions,
    evaluate,
    selection: selectionIntent,
    ...(isFeasible === undefined ? {} : { isFeasible }),
  });
  if (!optimized.ok) return { ok: false, reason: optimized.reason };

  const { selection, evaluation, baseline } = optimized;
  const chosenMerchandise = merchandiseOptions.find((option) => option.id === selection.merchandiseId) ?? null;

  const cards: VoucherCardState[] = [];
  for (const campaign of merchandiseCampaigns) {
    const quote = merchandiseQuotes.get(campaign.id)!;
    if (campaign.id === selection.merchandiseId) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "SELECTED", reason: null, shortfallVnd: null, savingVnd: evaluation.merchandiseDiscountVnd });
    } else if (!quote.ok) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "UNAVAILABLE", reason: CARD_REASON_OF[quote.reason], shortfallVnd: quote.shortfallVnd, savingVnd: null });
    } else if (!takeable(campaign, quote.discountVnd)) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "UNAVAILABLE", reason: "EXHAUSTED", shortfallVnd: null, savingVnd: null });
    } else {
      const option = { id: campaign.id, discountVnd: quote.discountVnd };
      const withIt = evaluate(option, shippingOptions.find((entry) => entry.id === selection.shippingId) ?? null);
      const infeasible = isFeasible !== undefined && withIt.ok && !isFeasible({ ...withIt, merchandiseId: campaign.id, shippingId: selection.shippingId });
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: infeasible ? "UNAVAILABLE" : "AVAILABLE", reason: infeasible ? "POS_INFEASIBLE" : null, shortfallVnd: null, savingVnd: quote.discountVnd });
    }
  }
  for (const campaign of shippingCampaigns) {
    if (campaign.id === selection.shippingId) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "SELECTED", reason: null, shortfallVnd: null, savingVnd: evaluation.shippingDiscountVnd });
      continue;
    }
    const option = shippingOptions.find((entry) => entry.id === campaign.id);
    if (option === undefined) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "UNAVAILABLE", reason: "EXHAUSTED", shortfallVnd: null, savingVnd: null });
      continue;
    }
    // Judged against the merchandise voucher actually chosen: the freeship threshold is after that discount.
    const withIt = evaluate(chosenMerchandise, option);
    if (withIt.ok) {
      const infeasible = isFeasible !== undefined && !isFeasible({ ...withIt, merchandiseId: selection.merchandiseId, shippingId: campaign.id });
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: infeasible ? "UNAVAILABLE" : "AVAILABLE", reason: infeasible ? "POS_INFEASIBLE" : null, shortfallVnd: null, savingVnd: withIt.shippingDiscountVnd });
    } else {
      const shortfall =
        withIt.reason === "BELOW_MINIMUM" && campaign.minEligibleSubtotalVnd !== null
          ? Math.max(1, campaign.minEligibleSubtotalVnd - scopeSubtotalAfter(campaign.id, selection.merchandiseId))
          : null;
      const reason: VoucherCardReason = withIt.reason === "NO_BENEFIT" ? "FEE_ALREADY_ZERO" : withIt.reason === "BELOW_MINIMUM" ? "BELOW_MINIMUM" : withIt.reason === "EXHAUSTED" ? "EXHAUSTED" : "NOT_SELECTABLE";
      cards.push({ campaignId: campaign.id, kind: campaign.kind, state: "UNAVAILABLE", reason, shortfallVnd: shortfall, savingVnd: null });
    }
  }

  return {
    ok: true,
    held: false,
    selection,
    paidBeforeVnd,
    merchandiseDiscountVnd: evaluation.merchandiseDiscountVnd,
    paidAfterVnd: evaluation.paidAfterVnd,
    shippingFeeBeforeVoucherVnd: evaluation.shippingFeeBeforeVoucherVnd,
    shippingDiscountVnd: evaluation.shippingDiscountVnd,
    shippingFeeVnd: evaluation.shippingFeeVnd,
    totalPayableVnd: evaluation.totalPayableVnd,
    baselineTotalVnd: baseline.totalPayableVnd,
    voucherCount: evaluation.voucherCount,
    allocation: allocationOf(selection.merchandiseId),
    gifts: evaluation.gifts,
    giftLoss: optimized.giftLoss,
    confirmation: optimized.confirmation,
    notices: optimized.notices,
    cards: Object.freeze(cards),
  };
}
