import { applyShippingVoucher, hasOtherPromotionsForCandidate } from "./voucher-shipping.ts";

/**
 * Voucher v1 (V03): choose the voucher combination (spec §4.2), one MERCHANDISE and one SHIPPING_FREE at
 * most, on a single pre-voucher snapshot.
 *
 * Pure and storage-free. It does not price anything itself: it searches the (NONE + candidates) x
 * (NONE + candidates) grid through an injected evaluator (see `createCombinationEvaluator`), so the same
 * cart facts, clock and price authority are used for every cell. Ranking is exactly the owner's:
 *
 *   1. lowest total payable (NONE/NONE is a candidate, so AUTO can never be dearer than no voucher);
 *   2. TG-09: keep more of the gifts the shopper already chose, then more valid gift slots, then fewer
 *      vouchers consumed, then stable ids. Gifts are never priced in VND;
 *   3. manual locks win when they stay valid; a lock that no longer works is dropped with a notice and
 *      its group is optimized again. A manual NONE is a lock too.
 *
 * `isFeasible` is the POS seam: a combination the vendor cannot represent to the VND is excluded from AUTO
 * and a manual lock on it is reported unavailable, before any hold is considered (AC-20). The optimizer
 * never grants anything; it only recommends.
 */

export type VoucherCombination = Readonly<{ merchandiseId: string | null; shippingId: string | null }>;

export type MerchandiseOption = Readonly<{ id: string; discountVnd: number }>;
export type ShippingOption = Readonly<{ id: string; minEligibleSubtotalVnd: number | null }>;

export type GiftOutcome = Readonly<{
  /** Gift slots the cart is entitled to at this paid total. */
  entitledSlots: number;
  /** How many of the gifts the shopper has already chosen stay valid at this paid total. */
  retainedSelectedSlots: number;
}>;

export type CombinationFailureReason = "NO_BENEFIT" | "BELOW_MINIMUM" | "INVALID";

export type CombinationOutcome =
  | Readonly<{
      ok: true;
      paidAfterVnd: number;
      merchandiseDiscountVnd: number;
      /** Campaign-adjusted fee before any SHIPPING_FREE voucher. */
      shippingFeeBeforeVoucherVnd: number;
      shippingDiscountVnd: number;
      shippingFeeVnd: number;
      totalPayableVnd: number;
      gifts: GiftOutcome;
      voucherCount: number;
    }>
  | Readonly<{ ok: false; reason: CombinationFailureReason }>;

export type CombinationEvaluator = (merchandise: MerchandiseOption | null, shipping: ShippingOption | null) => CombinationOutcome;

export type EvaluatorContext = Readonly<{
  /** `P`: paid goods after legacy/tier/ladder, before any voucher and before shipping. */
  paidSubtotalVnd: number;
  /** The existing-authority "other promotion" flag (legacy, tier, gifts), without any voucher. */
  existingOtherPromotions: boolean;
  /** The shipping campaign fee for a given `hasOtherPromotions`; the existing engine owns the answer. */
  campaignShippingFeeVnd: (hasOtherPromotions: boolean) => number;
  /** In-scope paid subtotal of a shipping voucher after the chosen merchandise voucher. */
  shippingScopeSubtotalAfterVnd: (shippingId: string, merchandiseId: string | null) => number;
  /** Gift entitlement and the survival of saved choices at a paid total (gifts follow the voucher, Q05). */
  giftOutcome: (paidAfterVnd: number) => GiftOutcome;
}>;

/** Builds the per-cell evaluator: merchandise first, then the shipping campaign per candidate, then shipping. */
export function createCombinationEvaluator(context: EvaluatorContext): CombinationEvaluator {
  return (merchandise, shipping) => {
    const merchandiseDiscountVnd = merchandise?.discountVnd ?? 0;
    const paidAfterVnd = context.paidSubtotalVnd - merchandiseDiscountVnd;
    if (!Number.isSafeInteger(merchandiseDiscountVnd) || merchandiseDiscountVnd < 0 || !Number.isSafeInteger(paidAfterVnd) || paidAfterVnd < 1) {
      return { ok: false, reason: "INVALID" };
    }
    // TG-10 B: re-evaluated for EACH candidate, never reused from another candidate's fee.
    const shippingFeeBeforeVoucherVnd = context.campaignShippingFeeVnd(
      hasOtherPromotionsForCandidate({ existingOtherPromotions: context.existingOtherPromotions, merchandiseDiscountVnd }),
    );
    let shippingDiscountVnd = 0;
    if (shipping !== null) {
      const outcome = applyShippingVoucher({
        feeVnd: shippingFeeBeforeVoucherVnd,
        scopeSubtotalAfterVnd: context.shippingScopeSubtotalAfterVnd(shipping.id, merchandise?.id ?? null),
        minEligibleSubtotalVnd: shipping.minEligibleSubtotalVnd,
      });
      // A voucher that saves nothing is never selected (AC-10); one under its threshold is ineligible (AC-09).
      if (!outcome.applies) return { ok: false, reason: outcome.reason === "FEE_ALREADY_ZERO" ? "NO_BENEFIT" : "BELOW_MINIMUM" };
      shippingDiscountVnd = outcome.waivedFeeVnd;
    }
    const shippingFeeVnd = shippingFeeBeforeVoucherVnd - shippingDiscountVnd;
    return {
      ok: true,
      paidAfterVnd,
      merchandiseDiscountVnd,
      shippingFeeBeforeVoucherVnd,
      shippingDiscountVnd,
      shippingFeeVnd,
      totalPayableVnd: paidAfterVnd + shippingFeeVnd,
      gifts: context.giftOutcome(paidAfterVnd),
      voucherCount: (merchandise === null ? 0 : 1) + (shipping === null ? 0 : 1),
    };
  };
}

export type GroupSelection =
  | Readonly<{ mode: "AUTO" }>
  /** `voucherId: null` is an explicit "no voucher" and stays pinned like any other manual choice. */
  | Readonly<{ mode: "MANUAL"; voucherId: string | null }>;

export type VoucherSelectionIntent = Readonly<{ merchandise: GroupSelection; shipping: GroupSelection }>;

export const AUTO_SELECTION: VoucherSelectionIntent = Object.freeze({
  merchandise: Object.freeze({ mode: "AUTO" as const }),
  shipping: Object.freeze({ mode: "AUTO" as const }),
});

export type OptimizerNotice = Readonly<{
  code: "MANUAL_SELECTION_UNAVAILABLE";
  group: "MERCHANDISE" | "SHIPPING_FREE";
  voucherId: string;
  reason: "NOT_ELIGIBLE" | CombinationFailureReason | "POS_INFEASIBLE";
}>;

export type EvaluatedCombination = Extract<CombinationOutcome, { ok: true }> & VoucherCombination;

export type VoucherOptimization =
  | Readonly<{
      ok: true;
      selection: VoucherCombination;
      evaluation: EvaluatedCombination;
      /** NONE/NONE on the same snapshot: what the shopper pays with no voucher. */
      baseline: Extract<CombinationOutcome, { ok: true }>;
      notices: readonly OptimizerNotice[];
      /** Set when the pick costs more than no voucher; the shopper must confirm the new quote. */
      confirmation: Readonly<{ totalIncreaseVnd: number; shippingFeeIncreaseVnd: number }> | null;
      /** Set when the pick loses gift slots the baseline keeps; the shopper must confirm or switch. */
      giftLoss: Readonly<{ entitledSlotsLost: number; selectedSlotsLost: number }> | null;
    }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "BASELINE_UNAVAILABLE" | "NO_FEASIBLE_COMBINATION" }>;

export const MAX_VOUCHER_CANDIDATES_PER_GROUP = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Cell = { merchandise: MerchandiseOption | null; shipping: ShippingOption | null; outcome: CombinationOutcome; feasible: boolean };
type OkCell = Cell & { outcome: Extract<CombinationOutcome, { ok: true }> };

function isOk(cell: Cell): cell is OkCell {
  return cell.outcome.ok;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validOptions(options: readonly { id: string }[]): boolean {
  if (!Array.isArray(options) || options.length > MAX_VOUCHER_CANDIDATES_PER_GROUP) return false;
  const seen = new Set<string>();
  for (const option of options) {
    if (option === null || typeof option !== "object" || typeof option.id !== "string" || !ID_PATTERN.test(option.id) || seen.has(option.id)) return false;
    seen.add(option.id);
  }
  return true;
}

/** TG-09 order. `a` before `b` means `a` is the better choice. */
function compareCells(left: OkCell, right: OkCell): number {
  const a = left.outcome;
  const b = right.outcome;
  return (
    a.totalPayableVnd - b.totalPayableVnd ||
    b.gifts.retainedSelectedSlots - a.gifts.retainedSelectedSlots ||
    b.gifts.entitledSlots - a.gifts.entitledSlots ||
    a.voucherCount - b.voucherCount ||
    compareText(left.merchandise?.id ?? "", right.merchandise?.id ?? "") ||
    compareText(left.shipping?.id ?? "", right.shipping?.id ?? "")
  );
}

export function optimizeVouchers(input: Readonly<{
  merchandise: readonly MerchandiseOption[];
  shipping: readonly ShippingOption[];
  evaluate: CombinationEvaluator;
  /** POS exact-money predicate (V09). Absent means the seam is not wired and every combination passes. */
  isFeasible?: (evaluation: EvaluatedCombination) => boolean;
  selection?: VoucherSelectionIntent;
}>): VoucherOptimization {
  const { merchandise, shipping, evaluate, isFeasible } = input;
  const intent = input.selection ?? AUTO_SELECTION;
  if (!validOptions(merchandise) || !validOptions(shipping)) return { ok: false, reason: "INVALID_INPUT" };
  if (merchandise.some((option) => !Number.isSafeInteger(option.discountVnd) || option.discountVnd < 1)) return { ok: false, reason: "INVALID_INPUT" };

  const cells: Cell[] = [];
  for (const m of [null, ...merchandise]) {
    for (const s of [null, ...shipping]) {
      const outcome = evaluate(m, s);
      const evaluated = outcome.ok ? ({ ...outcome, merchandiseId: m?.id ?? null, shippingId: s?.id ?? null } as EvaluatedCombination) : null;
      cells.push({ merchandise: m, shipping: s, outcome, feasible: evaluated !== null && (isFeasible === undefined || isFeasible(evaluated)) });
    }
  }

  const baselineCell = cells[0]!;
  if (!baselineCell.outcome.ok) return { ok: false, reason: "BASELINE_UNAVAILABLE" };
  const baseline = baselineCell.outcome;

  const lockOf = (selection: GroupSelection) => (selection.mode === "MANUAL" ? { id: selection.voucherId } : null);
  const merchandiseLock = lockOf(intent.merchandise);
  const shippingLock = lockOf(intent.shipping);

  const pick = (useMerchandiseLock: boolean, useShippingLock: boolean): OkCell | null => {
    const candidates = cells.filter(
      (cell): cell is OkCell =>
        isOk(cell) &&
        cell.feasible &&
        (!useMerchandiseLock || merchandiseLock === null || (cell.merchandise?.id ?? null) === merchandiseLock.id) &&
        (!useShippingLock || shippingLock === null || (cell.shipping?.id ?? null) === shippingLock.id),
    );
    return candidates.sort(compareCells)[0] ?? null;
  };

  // Keep as many manual locks as can be honoured, dropping the shipping lock before the merchandise lock.
  const attempts: Array<[boolean, boolean]> = [[true, true]];
  if (shippingLock !== null) attempts.push([true, false]);
  if (merchandiseLock !== null) attempts.push([false, true]);
  if (merchandiseLock !== null || shippingLock !== null) attempts.push([false, false]);
  let chosen: OkCell | null = null;
  let honoured: [boolean, boolean] = [true, true];
  for (const attempt of attempts) {
    chosen = pick(attempt[0], attempt[1]);
    if (chosen !== null) {
      honoured = attempt;
      break;
    }
  }
  if (chosen === null) return { ok: false, reason: "NO_FEASIBLE_COMBINATION" };

  const why = (group: "MERCHANDISE" | "SHIPPING_FREE", id: string): OptimizerNotice["reason"] => {
    const related = cells.filter((cell) => (group === "MERCHANDISE" ? cell.merchandise?.id : cell.shipping?.id) === id);
    if (related.length === 0) return "NOT_ELIGIBLE";
    if (related.some((cell) => isOk(cell) && !cell.feasible)) return "POS_INFEASIBLE";
    for (const cell of related) if (!cell.outcome.ok) return cell.outcome.reason;
    return "NOT_ELIGIBLE";
  };
  const notices: OptimizerNotice[] = [];
  if (merchandiseLock !== null && merchandiseLock.id !== null && !honoured[0]) {
    notices.push({ code: "MANUAL_SELECTION_UNAVAILABLE", group: "MERCHANDISE", voucherId: merchandiseLock.id, reason: why("MERCHANDISE", merchandiseLock.id) });
  }
  if (shippingLock !== null && shippingLock.id !== null && !honoured[1]) {
    notices.push({ code: "MANUAL_SELECTION_UNAVAILABLE", group: "SHIPPING_FREE", voucherId: shippingLock.id, reason: why("SHIPPING_FREE", shippingLock.id) });
  }

  const outcome = chosen.outcome;
  const merchandiseId = chosen.merchandise?.id ?? null;
  const shippingId = chosen.shipping?.id ?? null;
  const evaluation = { ...outcome, merchandiseId, shippingId } as EvaluatedCombination;
  const totalIncreaseVnd = outcome.totalPayableVnd - baseline.totalPayableVnd;
  const entitledSlotsLost = Math.max(0, baseline.gifts.entitledSlots - outcome.gifts.entitledSlots);
  const selectedSlotsLost = Math.max(0, baseline.gifts.retainedSelectedSlots - outcome.gifts.retainedSelectedSlots);
  return {
    ok: true,
    selection: Object.freeze({ merchandiseId, shippingId }),
    evaluation,
    baseline,
    notices: Object.freeze(notices),
    confirmation:
      totalIncreaseVnd > 0
        ? Object.freeze({ totalIncreaseVnd, shippingFeeIncreaseVnd: Math.max(0, outcome.shippingFeeVnd - baseline.shippingFeeVnd) })
        : null,
    giftLoss: entitledSlotsLost > 0 || selectedSlotsLost > 0 ? Object.freeze({ entitledSlotsLost, selectedSlotsLost }) : null,
  };
}
