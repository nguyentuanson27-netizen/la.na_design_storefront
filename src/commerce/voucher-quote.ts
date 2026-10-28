import { applyAllocationToLines, type VoucherAllocation, type VoucherPaidLine } from "./voucher-allocation.ts";
import { canGrantVoucher, voucherRemaining, voucherSlotOf, type VoucherCampaign } from "./voucher-campaign.ts";
import { quoteMerchandiseStack, quoteMerchandiseVoucher, sumEligibleLines, type MerchandiseIneligibleReason, type MerchandiseStackQuote, type MerchandiseVoucherQuote } from "./voucher-money.ts";
import {
  AUTO_SELECTION,
  createCombinationEvaluator,
  optimizeVouchers,
  type CombinationEvaluator,
  type CombinationFailureReason,
  type EvaluatedCombination,
  type GiftOutcome,
  type MerchandiseOption,
  type MerchandiseStackOutcome,
  type OptimizerNotice,
  type ShippingOption,
  type VoucherCombination,
  type VoucherSelectionIntent,
} from "./voucher-optimizer.ts";
import { buildVoucherScopeResolver, type VoucherScopeResolver } from "./voucher-scope.ts";

/**
 * Voucher v1 (V08, extended by ADR 0020): the canonical PREVIEW quote of vouchers on one cart.
 *
 * One pure function from (post-tier paid lines, active candidate campaigns, the shopper's selection intent, the
 * existing shipping/gift authorities) to the whole picture the picker, cart and checkout summary show: which
 * voucher of each slot is chosen, why each other card is or is not available, the exact per-line allocation of
 * every merchandise voucher in application order, the shipping fee, the gift consequence and the total. Every
 * number is computed once, on one snapshot, from the same optimizer, so the surfaces cannot disagree.
 *
 * Merchandise vouchers of different types stack in sequence (type priority): a tier's threshold is judged on the
 * pre-voucher lines, its discount on what the earlier types left (ADR 0020 D-3). Inside one type only one tier is
 * ever chosen, so AUTO picks the best reachable rung and a manual lock can pick a lower one.
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
  /** The slot this card competes in: choosing it replaces that slot's current voucher. */
  slot: string;
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
  /** Gift entitlement and the survival of saved choices on the lines AFTER the vouchers (Q05). */
  giftOutcome: (linesAfterVoucher: readonly VoucherPaidLine[]) => GiftOutcome;
  /** Campaigns the attempt already holds: their own quota is not counted against them (spec §5.1). */
  heldCampaignIds?: ReadonlySet<string>;
  /** Injected POS exact-money predicate (V09). Absent means not wired: the quote stays preview-only. */
  isFeasible?: (evaluation: EvaluatedCombination) => boolean;
  /**
   * The same predicate, handed the lines exactly as the POS would receive them for that combination (every chosen
   * voucher's allocation already applied). Prefer this over `isFeasible`: the caller cannot get the allocation
   * wrong, and the vendor check runs on the very lines the quote prices.
   */
  isFeasibleOnLines?: (args: Readonly<{ evaluation: EvaluatedCombination; linesAfterVoucher: readonly VoucherPaidLine[] }>) => boolean;
}>;

/** One chosen merchandise voucher with its exact landing, in application order. */
export type VoucherMerchandiseLine = Readonly<{
  campaignId: string;
  slot: string;
  discountVnd: number;
  /** Over the lines this voucher received, i.e. after the vouchers before it. */
  allocation: VoucherAllocation;
}>;

export type VoucherQuote =
  | Readonly<{
      ok: true;
      /** Always a preview: no hold, no timer, no submit-capable proof. */
      held: false;
      selection: VoucherCombination;
      paidBeforeVnd: number;
      /** The total of every merchandise voucher. */
      merchandiseDiscountVnd: number;
      paidAfterVnd: number;
      shippingFeeBeforeVoucherVnd: number;
      shippingDiscountVnd: number;
      shippingFeeVnd: number;
      totalPayableVnd: number;
      /** NONE/NONE on the same snapshot. */
      baselineTotalVnd: number;
      voucherCount: number;
      /** The chosen merchandise vouchers, in application order. */
      merchandise: readonly VoucherMerchandiseLine[];
      /** The paid lines as the POS will see them after every merchandise voucher. */
      linesAfter: readonly VoucherPaidLine[];
      gifts: GiftOutcome;
      giftLoss: Readonly<{ entitledSlotsLost: number; selectedSlotsLost: number }> | null;
      confirmation: Readonly<{ totalIncreaseVnd: number; shippingFeeIncreaseVnd: number }> | null;
      notices: readonly OptimizerNotice[];
      cards: readonly VoucherCardState[];
    }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "BASELINE_UNAVAILABLE" | "NO_FEASIBLE_COMBINATION" }>;

export { applyAllocationToLines };

const CARD_REASON_OF: Readonly<Record<MerchandiseIneligibleReason, VoucherCardReason>> = {
  NO_ELIGIBLE_LINES: "NOT_APPLICABLE",
  BELOW_MINIMUM: "BELOW_MINIMUM",
  ZERO_DISCOUNT: "NOT_APPLICABLE",
  DISCOUNT_NOT_BELOW_SUBTOTAL: "NOT_APPLICABLE",
  UNIT_PRICE_FLOOR: "NOT_APPLICABLE",
};

const FAILURE_CARD_REASON: Readonly<Record<CombinationFailureReason, VoucherCardReason>> = {
  NO_BENEFIT: "NOT_SELECTABLE",
  BELOW_MINIMUM: "BELOW_MINIMUM",
  EXHAUSTED: "EXHAUSTED",
  INVALID: "NOT_APPLICABLE",
};

const compareSlot = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function buildVoucherQuote(input: VoucherQuoteInput): VoucherQuote {
  const { lines, existingOtherPromotions, campaignShippingFeeVnd } = input;
  const selectionIntent = input.selection ?? AUTO_SELECTION;
  const held = input.heldCampaignIds ?? new Set<string>();
  const campaigns = [...input.campaigns].sort(byId);
  const merchandiseCampaigns = campaigns.filter((campaign) => campaign.kind === "MERCHANDISE" && campaign.discount !== null);
  const shippingCampaigns = campaigns.filter((campaign) => campaign.kind === "SHIPPING_FREE");

  const resolverOf = new Map<string, VoucherScopeResolver>(
    campaigns.map((campaign) => [campaign.id, buildVoucherScopeResolver(campaign.scope, String(campaign.pancakeShopId))]),
  );
  const campaignOf = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const slotOfId = new Map(campaigns.map((campaign) => [campaign.id, voucherSlotOf(campaign)]));
  const priorityOf = (campaign: VoucherCampaign) => campaign.type?.priority ?? 0;

  // Merchandise: each campaign alone on the post-tier lines (TG-11 A: one shared base, never re-tiered). This is the
  // tier's eligibility (threshold on the pre-voucher base) and the number its card shows.
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
    if (quote.ok && takeable(campaign, quote.discountVnd)) {
      merchandiseOptions.push({ id: campaign.id, discountVnd: quote.discountVnd, slot: slotOfId.get(campaign.id)!, priority: priorityOf(campaign) });
    }
  }
  const shippingOptions: ShippingOption[] = shippingCampaigns
    .filter((campaign) => held.has(campaign.id) || (voucherRemaining(campaign).uses ?? 1) >= 1)
    .map((campaign) => ({ id: campaign.id, minEligibleSubtotalVnd: campaign.minEligibleSubtotalVnd }));

  // The stack of one combination, computed once: sequential in application order (ADR 0020 D-3).
  const stackCache = new Map<string, MerchandiseStackQuote>();
  const stackOf = (options: readonly MerchandiseOption[]): MerchandiseStackQuote => {
    const key = options.map((option) => option.id).join(",");
    let stack = stackCache.get(key);
    if (stack === undefined) {
      stack = quoteMerchandiseStack({
        lines,
        steps: options.map((option) => {
          const campaign = campaignOf.get(option.id)!;
          return { id: option.id, terms: { discount: campaign.discount!, minEligibleSubtotalVnd: campaign.minEligibleSubtotalVnd }, resolver: resolverOf.get(option.id)! };
        }),
      });
      stackCache.set(key, stack);
    }
    return stack;
  };
  const linesAfterOf = (merchandiseIds: readonly string[]): readonly VoucherPaidLine[] => {
    if (merchandiseIds.length === 0) return lines;
    const options = merchandiseIds.map((id) => merchandiseOptions.find((option) => option.id === id)!);
    const stack = stackOf(options);
    return stack.ok ? stack.linesAfter : lines;
  };
  const merchandiseStack = (options: readonly MerchandiseOption[]): MerchandiseStackOutcome => {
    if (options.length === 0) return { ok: true, discountVnd: 0 };
    const stack = stackOf(options);
    if (!stack.ok) return { ok: false, reason: stack.reason === "BELOW_MINIMUM" ? "BELOW_MINIMUM" : "INVALID" };
    // Budget is checked on what each voucher really takes in THIS stack (a percentage on a reduced base takes less).
    for (const step of stack.steps) if (!takeable(campaignOf.get(step.id)!, step.discountVnd)) return { ok: false, reason: "EXHAUSTED" };
    return { ok: true, discountVnd: stack.discountVnd };
  };

  const isFeasible: ((evaluation: EvaluatedCombination) => boolean) | undefined =
    input.isFeasible === undefined && input.isFeasibleOnLines === undefined
      ? undefined
      : (evaluation) =>
          (input.isFeasible?.(evaluation) ?? true) &&
          (input.isFeasibleOnLines?.({ evaluation, linesAfterVoucher: linesAfterOf(evaluation.merchandiseIds) }) ?? true);
  const scopeSubtotalAfter = (shippingId: string, merchandiseIds: readonly string[]) =>
    sumEligibleLines(linesAfterOf(merchandiseIds), resolverOf.get(shippingId)!).subtotalVnd;

  const paidBeforeVnd = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0);
  const evaluate: CombinationEvaluator = createCombinationEvaluator({
    paidSubtotalVnd: paidBeforeVnd,
    existingOtherPromotions,
    campaignShippingFeeVnd,
    shippingScopeSubtotalAfterVnd: scopeSubtotalAfter,
    merchandiseStack,
    giftOutcome: (_paidAfter, merchandiseIds) => input.giftOutcome(linesAfterOf(merchandiseIds)),
  });
  // A shipping voucher's budget is checked per combination: it waives 30K in one cell and 0 in another.
  const evaluateWithBudget: CombinationEvaluator = (merchandise, shipping) => {
    const outcome = evaluate(merchandise, shipping);
    if (!outcome.ok) return outcome;
    if (shipping !== null && !takeable(campaignOf.get(shipping.id)!, outcome.shippingDiscountVnd)) return { ok: false, reason: "EXHAUSTED" };
    return outcome;
  };

  const optimized = optimizeVouchers({
    merchandise: merchandiseOptions,
    shipping: shippingOptions,
    evaluate: evaluateWithBudget,
    selection: selectionIntent,
    ...(isFeasible === undefined ? {} : { isFeasible }),
  });
  if (!optimized.ok) return { ok: false, reason: optimized.reason };

  const { selection, evaluation, baseline } = optimized;
  const chosenOptions = selection.merchandiseIds.map((id) => merchandiseOptions.find((option) => option.id === id)!);
  const chosenStack = chosenOptions.length === 0 ? null : stackOf(chosenOptions);
  const merchandise: VoucherMerchandiseLine[] =
    chosenStack === null || !chosenStack.ok
      ? []
      : chosenStack.steps.map((step) => ({ campaignId: step.id, slot: slotOfId.get(step.id)!, discountVnd: step.discountVnd, allocation: step.allocation }));
  const chosenShipping = shippingOptions.find((entry) => entry.id === selection.shippingId) ?? null;

  const cards: VoucherCardState[] = [];
  for (const campaign of merchandiseCampaigns) {
    const slot = slotOfId.get(campaign.id)!;
    const quote = merchandiseQuotes.get(campaign.id)!;
    if (selection.merchandiseIds.includes(campaign.id)) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "SELECTED", reason: null, shortfallVnd: null, savingVnd: merchandise.find((line) => line.campaignId === campaign.id)?.discountVnd ?? null });
    } else if (!quote.ok) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "UNAVAILABLE", reason: CARD_REASON_OF[quote.reason], shortfallVnd: quote.shortfallVnd, savingVnd: null });
    } else if (!takeable(campaign, quote.discountVnd)) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "UNAVAILABLE", reason: "EXHAUSTED", shortfallVnd: null, savingVnd: null });
    } else {
      // What choosing this card would do: it takes its slot's place in the current combination.
      const option = merchandiseOptions.find((entry) => entry.id === campaign.id)!;
      const replaced = [...chosenOptions.filter((entry) => slotOfId.get(entry.id) !== slot), option].sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0) || compareSlot(x.slot ?? "MERCHANDISE", y.slot ?? "MERCHANDISE"));
      // Can this voucher be taken at all? Judged on the merchandise alone: a shipping voucher that no longer fits with it is
      // simply dropped (with a notice) when the shopper chooses it, so it does not make the card unavailable.
      const alone = evaluateWithBudget(replaced, null);
      if (!alone.ok) {
        cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "UNAVAILABLE", reason: FAILURE_CARD_REASON[alone.reason], shortfallVnd: null, savingVnd: null });
        continue;
      }
      // The POS check runs on the combination that would really result: with the chosen shipping when that still works.
      const together = evaluateWithBudget(replaced, chosenShipping);
      const probe = together.ok ? { outcome: together, shippingId: selection.shippingId } : { outcome: alone, shippingId: null };
      const infeasible = isFeasible !== undefined && !isFeasible({ ...probe.outcome, merchandiseIds: replaced.map((entry) => entry.id), shippingId: probe.shippingId });
      const replacedStack = stackOf(replaced);
      const saving = replacedStack.ok ? replacedStack.steps.find((step) => step.id === campaign.id)?.discountVnd ?? quote.discountVnd : quote.discountVnd;
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: infeasible ? "UNAVAILABLE" : "AVAILABLE", reason: infeasible ? "POS_INFEASIBLE" : null, shortfallVnd: null, savingVnd: saving });
    }
  }
  for (const campaign of shippingCampaigns) {
    const slot = slotOfId.get(campaign.id)!;
    if (campaign.id === selection.shippingId) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "SELECTED", reason: null, shortfallVnd: null, savingVnd: evaluation.shippingDiscountVnd });
      continue;
    }
    const option = shippingOptions.find((entry) => entry.id === campaign.id);
    if (option === undefined) {
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "UNAVAILABLE", reason: "EXHAUSTED", shortfallVnd: null, savingVnd: null });
      continue;
    }
    // Judged against the merchandise vouchers actually chosen: the freeship threshold is after those discounts.
    const withIt = evaluateWithBudget(chosenOptions, option);
    if (withIt.ok) {
      const infeasible = isFeasible !== undefined && !isFeasible({ ...withIt, merchandiseIds: selection.merchandiseIds, shippingId: campaign.id });
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: infeasible ? "UNAVAILABLE" : "AVAILABLE", reason: infeasible ? "POS_INFEASIBLE" : null, shortfallVnd: null, savingVnd: withIt.shippingDiscountVnd });
    } else {
      const shortfall =
        withIt.reason === "BELOW_MINIMUM" && campaign.minEligibleSubtotalVnd !== null
          ? Math.max(1, campaign.minEligibleSubtotalVnd - scopeSubtotalAfter(campaign.id, selection.merchandiseIds))
          : null;
      const reason: VoucherCardReason = withIt.reason === "NO_BENEFIT" ? "FEE_ALREADY_ZERO" : withIt.reason === "BELOW_MINIMUM" ? "BELOW_MINIMUM" : withIt.reason === "EXHAUSTED" ? "EXHAUSTED" : "NOT_SELECTABLE";
      cards.push({ campaignId: campaign.id, kind: campaign.kind, slot, state: "UNAVAILABLE", reason, shortfallVnd: shortfall, savingVnd: null });
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
    merchandise: Object.freeze(merchandise),
    linesAfter: linesAfterOf(selection.merchandiseIds),
    gifts: evaluation.gifts,
    giftLoss: optimized.giftLoss,
    confirmation: optimized.confirmation,
    notices: optimized.notices,
    cards: Object.freeze(cards),
  };
}
