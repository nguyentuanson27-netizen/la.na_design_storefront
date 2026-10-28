import { applyShippingVoucher, hasOtherPromotionsForCandidate } from "./voucher-shipping.ts";

/**
 * Voucher v1 (V03, extended by ADR 0020): choose the voucher combination (spec §4.2) on a single pre-voucher
 * snapshot: at most one voucher per SLOT. A slot is the SHIPPING_FREE group, the untyped MERCHANDISE group (v1) or
 * one MERCHANDISE type (`MERCHANDISE:<typeId>`), so several merchandise vouchers of different types can stack while
 * one type still contributes exactly one tier.
 *
 * Pure and storage-free. It does not price anything itself: it searches the product over slots of
 * (NONE + that slot's candidates), times (NONE + shipping), through an injected evaluator (see `createCombinationEvaluator`), so the same
 * cart facts, clock and price authority are used for every cell. Ranking is exactly the owner's:
 *
 *   1. lowest total payable (NONE/NONE is a candidate, so AUTO can never be dearer than no voucher);
 *   2. TG-09: keep more of the gifts the shopper already chose, then more valid gift slots, then fewer
 *      vouchers consumed, then stable ids. Gifts are never priced in VND;
 *   3. manual locks win when they stay valid; a lock that no longer works is dropped with a notice and
 *      its slot is optimized again (shipping first, then merchandise slots from the lowest priority up). A manual
 *      NONE is a lock too.
 *
 * `isFeasible` is the POS seam: a combination the vendor cannot represent to the VND is excluded from AUTO
 * and a manual lock on it is reported unavailable, before any hold is considered (AC-20). The optimizer
 * never grants anything; it only recommends.
 */

export type VoucherCombination = Readonly<{
  /** The chosen merchandise vouchers in application order (type priority, then slot), at most one per slot. */
  merchandiseIds: readonly string[];
  shippingId: string | null;
}>;

/** The v1 group of untyped merchandise campaigns, and the prefix of a type's slot (`MERCHANDISE:<typeId>`). */
export const MERCHANDISE_SLOT = "MERCHANDISE";
export const SHIPPING_SLOT = "SHIPPING_FREE";

export type MerchandiseOption = Readonly<{
  id: string;
  /** The voucher's standalone discount; only checked for validity here. The stack decides the real amount. */
  discountVnd: number;
  /** The slot this voucher competes in. Absent means the untyped v1 group. */
  slot?: string;
  /** Application order across slots, smaller first. Absent means 0. */
  priority?: number;
  /**
   * A tier's own threshold. When two combinations cost the same, the one that reaches the higher rung wins, so a cart
   * that reached a type's top tier is never served (and never spends the quota) from a lower one. Absent means 0.
   */
  rank?: number;
}>;
export type ShippingOption = Readonly<{ id: string; minEligibleSubtotalVnd: number | null }>;

export type GiftOutcome = Readonly<{
  /** Gift slots the cart is entitled to at this paid total. */
  entitledSlots: number;
  /** How many of the gifts the shopper has already chosen stay valid at this paid total. */
  retainedSelectedSlots: number;
}>;

export type CombinationFailureReason = "NO_BENEFIT" | "BELOW_MINIMUM" | "EXHAUSTED" | "INVALID";

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

/** `merchandise` is in application order. */
export type CombinationEvaluator = (merchandise: readonly MerchandiseOption[], shipping: ShippingOption | null) => CombinationOutcome;

export type MerchandiseStackOutcome =
  | Readonly<{ ok: true; discountVnd: number }>
  | Readonly<{ ok: false; reason: CombinationFailureReason }>;

export type EvaluatorContext = Readonly<{
  /** `P`: paid goods after legacy/tier/ladder, before any voucher and before shipping. */
  paidSubtotalVnd: number;
  /** The existing-authority "other promotion" flag (legacy, tier, gifts), without any voucher. */
  existingOtherPromotions: boolean;
  /** The shipping campaign fee for a given `hasOtherPromotions`; the existing engine owns the answer. */
  campaignShippingFeeVnd: (hasOtherPromotions: boolean) => number;
  /** In-scope paid subtotal of a shipping voucher after the chosen merchandise vouchers. */
  shippingScopeSubtotalAfterVnd: (shippingId: string, merchandiseIds: readonly string[]) => number;
  /**
   * The total merchandise discount of a stack, computed sequentially (ADR 0020 D-3) or refused. Absent means the
   * options are independent and their discounts simply add up (the v1 single-voucher case).
   */
  merchandiseStack?: (merchandise: readonly MerchandiseOption[]) => MerchandiseStackOutcome;
  /**
   * Gift entitlement and the survival of saved choices after the merchandise vouchers (gifts follow the vouchers,
   * Q05). Gets the chosen vouchers too, because a gift threshold can be scoped and only the allocation knows
   * which lines the discount landed on; a plain total is enough when it is not.
   */
  giftOutcome: (paidAfterVnd: number, merchandiseIds: readonly string[]) => GiftOutcome;
}>;

/** Builds the per-cell evaluator: merchandise stack first, then the shipping campaign per candidate, then shipping. */
export function createCombinationEvaluator(context: EvaluatorContext): CombinationEvaluator {
  return (merchandise, shipping) => {
    const stack: MerchandiseStackOutcome = context.merchandiseStack
      ? context.merchandiseStack(merchandise)
      : { ok: true, discountVnd: merchandise.reduce((sum, option) => sum + option.discountVnd, 0) };
    if (!stack.ok) return { ok: false, reason: stack.reason };
    const merchandiseDiscountVnd = stack.discountVnd;
    const merchandiseIds = merchandise.map((option) => option.id);
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
        scopeSubtotalAfterVnd: context.shippingScopeSubtotalAfterVnd(shipping.id, merchandiseIds),
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
      gifts: context.giftOutcome(paidAfterVnd, merchandiseIds),
      voucherCount: merchandise.length + (shipping === null ? 0 : 1),
    };
  };
}

export type GroupSelection =
  | Readonly<{ mode: "AUTO" }>
  /** `voucherId: null` is an explicit "no voucher" and stays pinned like any other manual choice. */
  | Readonly<{ mode: "MANUAL"; voucherId: string | null }>;

export type VoucherSelectionIntent = Readonly<{
  /** Per merchandise slot; a slot without an entry is AUTO. */
  merchandise: Readonly<Record<string, GroupSelection>>;
  shipping: GroupSelection;
  /**
   * Types this cart has unlocked with their code (ADR 0020 D-6). Server-written state, never browser input: the
   * optimizer ignores it; the preview reads it to load the tiers of a PRIVATE type.
   */
  unlockedTypeIds?: readonly string[];
  /**
   * What a merchandise slot WITHOUT an entry means. `AUTO` (the default) lets the ladder pick; `NONE` pins every such slot to
   * "no voucher". Checkout uses `NONE` so it prices exactly the held vouchers and never adds one the buyer was not shown.
   */
  unlistedMerchandise?: "AUTO" | "NONE";
}>;

export const AUTO_SELECTION: VoucherSelectionIntent = Object.freeze({
  merchandise: Object.freeze({}) as Readonly<Record<string, GroupSelection>>,
  shipping: Object.freeze({ mode: "AUTO" as const }),
});

export type OptimizerNotice = Readonly<{
  code: "MANUAL_SELECTION_UNAVAILABLE";
  group: "MERCHANDISE" | "SHIPPING_FREE";
  /** The merchandise slot the lock was on; absent for shipping. */
  slot?: string;
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
/** Bounds of the grid (ADR 0020 D-4): beyond them the input is refused rather than searched partially. */
export const MAX_VOUCHER_MERCHANDISE_SLOTS = 8;
export const MAX_VOUCHER_GRID_CELLS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SLOT_PATTERN = /^MERCHANDISE(:[A-Za-z0-9_-]{1,64})?$/;

type Cell = { merchandise: readonly MerchandiseOption[]; shipping: ShippingOption | null; outcome: CombinationOutcome; feasible: boolean };
type OkCell = Cell & { outcome: Extract<CombinationOutcome, { ok: true }> };

function isOk(cell: Cell): cell is OkCell {
  return cell.outcome.ok;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validOptions(options: readonly { id: string }[], limit = MAX_VOUCHER_CANDIDATES_PER_GROUP): boolean {
  if (!Array.isArray(options) || options.length > limit) return false;
  const seen = new Set<string>();
  for (const option of options) {
    if (option === null || typeof option !== "object" || typeof option.id !== "string" || !ID_PATTERN.test(option.id) || seen.has(option.id)) return false;
    seen.add(option.id);
  }
  return true;
}

const slotOf = (option: MerchandiseOption) => option.slot ?? MERCHANDISE_SLOT;
const rankOf = (options: readonly MerchandiseOption[]) => options.reduce((sum, option) => sum + (option.rank ?? 0), 0);
const idsKey = (options: readonly MerchandiseOption[]) => options.map((option) => option.id).join(",");

/** TG-09 order. `a` before `b` means `a` is the better choice. */
function compareCells(left: OkCell, right: OkCell): number {
  const a = left.outcome;
  const b = right.outcome;
  return (
    a.totalPayableVnd - b.totalPayableVnd ||
    b.gifts.retainedSelectedSlots - a.gifts.retainedSelectedSlots ||
    b.gifts.entitledSlots - a.gifts.entitledSlots ||
    a.voucherCount - b.voucherCount ||
    rankOf(right.merchandise) - rankOf(left.merchandise) ||
    compareText(idsKey(left.merchandise), idsKey(right.merchandise)) ||
    compareText(left.shipping?.id ?? "", right.shipping?.id ?? "")
  );
}

type Slot = { key: string; priority: number; options: readonly MerchandiseOption[] };

/** Groups the candidates by slot and orders the slots by (priority, key): the order the stack is applied in. */
function toSlots(merchandise: readonly MerchandiseOption[]): Slot[] | null {
  const bySlot = new Map<string, MerchandiseOption[]>();
  for (const option of merchandise) {
    const key = slotOf(option);
    const priority = option.priority ?? 0;
    if (!SLOT_PATTERN.test(key) || !Number.isSafeInteger(priority)) return null;
    const list = bySlot.get(key);
    if (list) list.push(option);
    else bySlot.set(key, [option]);
  }
  const slots: Slot[] = [...bySlot.entries()].map(([key, options]) => ({
    key,
    priority: options[0]!.priority ?? 0,
    options: [...options].sort((x, y) => compareText(x.id, y.id)),
  }));
  // One slot has one priority: two tiers of a type that disagree are malformed input.
  for (const slot of slots) if (slot.options.some((option) => (option.priority ?? 0) !== slot.priority)) return null;
  return slots.sort((x, y) => x.priority - y.priority || compareText(x.key, y.key));
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
  const slots = toSlots(merchandise);
  if (slots === null || slots.length > MAX_VOUCHER_MERCHANDISE_SLOTS) return { ok: false, reason: "INVALID_INPUT" };
  const cellCount = slots.reduce((product, slot) => product * (slot.options.length + 1), 1) * (shipping.length + 1);
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_VOUCHER_GRID_CELLS) return { ok: false, reason: "INVALID_INPUT" };

  // The product of (NONE + candidates) over the slots, NONE first everywhere, so cells[0] is NONE/NONE.
  let stacks: MerchandiseOption[][] = [[]];
  for (const slot of slots) {
    const next: MerchandiseOption[][] = [];
    for (const stack of stacks) {
      next.push(stack);
      for (const option of slot.options) next.push([...stack, option]);
    }
    stacks = next;
  }
  const cells: Cell[] = [];
  for (const m of stacks) {
    for (const s of [null, ...shipping]) {
      const outcome = evaluate(m, s);
      const evaluated = outcome.ok ? ({ ...outcome, merchandiseIds: m.map((option) => option.id), shippingId: s?.id ?? null } as EvaluatedCombination) : null;
      cells.push({ merchandise: m, shipping: s, outcome, feasible: evaluated !== null && (isFeasible === undefined || isFeasible(evaluated)) });
    }
  }

  const baselineCell = cells[0]!;
  if (!baselineCell.outcome.ok) return { ok: false, reason: "BASELINE_UNAVAILABLE" };
  const baseline = baselineCell.outcome;

  const lockOf = (selection: GroupSelection | undefined) => (selection !== undefined && selection.mode === "MANUAL" ? { id: selection.voucherId } : null);
  const shippingLock = lockOf(intent.shipping);
  // Merchandise locks that can matter, in application order. A lock on a slot that has no candidates is still a lock.
  const explicitLocks = Object.entries(intent.merchandise).filter(([, selection]) => lockOf(selection) !== null).map(([key, selection]) => ({ key, id: (selection as Extract<GroupSelection, { mode: "MANUAL" }>).voucherId }));
  const pinnedNone = intent.unlistedMerchandise === "NONE" ? slots.filter((slot) => !(slot.key in intent.merchandise)).map((slot) => ({ key: slot.key, id: null as string | null })) : [];
  const lockedSlots = [...explicitLocks, ...pinnedNone]
    .sort((x, y) => (slots.find((s) => s.key === x.key)?.priority ?? Number.MAX_SAFE_INTEGER) - (slots.find((s) => s.key === y.key)?.priority ?? Number.MAX_SAFE_INTEGER) || compareText(x.key, y.key));

  const optionIn = (cell: Cell, slotKey: string): MerchandiseOption | null => cell.merchandise.find((option) => slotOf(option) === slotKey) ?? null;

  const pick = (keepMerchandiseLocks: number, useShippingLock: boolean): OkCell | null => {
    const active = lockedSlots.slice(0, keepMerchandiseLocks);
    const candidates = cells.filter(
      (cell): cell is OkCell =>
        isOk(cell) &&
        cell.feasible &&
        active.every((lock) => (optionIn(cell, lock.key)?.id ?? null) === lock.id) &&
        (!useShippingLock || shippingLock === null || (cell.shipping?.id ?? null) === shippingLock.id),
    );
    return candidates.sort(compareCells)[0] ?? null;
  };

  // Keep as many manual locks as can be honoured: shipping before merchandise, and among merchandise slots the
  // lowest priority goes first.
  const attempts: Array<[number, boolean]> = [];
  for (let keep = lockedSlots.length; keep >= 0; keep -= 1) {
    attempts.push([keep, true]);
    if (shippingLock !== null) attempts.push([keep, false]);
  }
  // An attempt that keeps the shipping lock is the same as one that ignores it when there is no shipping lock.
  let chosen: OkCell | null = null;
  let honoured: [number, boolean] = [lockedSlots.length, true];
  for (const attempt of attempts) {
    chosen = pick(attempt[0], attempt[1]);
    if (chosen !== null) {
      honoured = attempt;
      break;
    }
  }
  if (chosen === null) return { ok: false, reason: "NO_FEASIBLE_COMBINATION" };

  const why = (group: "MERCHANDISE" | "SHIPPING_FREE", id: string): OptimizerNotice["reason"] => {
    const related = cells.filter((cell) => (group === "MERCHANDISE" ? cell.merchandise.some((option) => option.id === id) : cell.shipping?.id === id));
    if (related.length === 0) return "NOT_ELIGIBLE";
    if (related.some((cell) => isOk(cell) && !cell.feasible)) return "POS_INFEASIBLE";
    for (const cell of related) if (!cell.outcome.ok) return cell.outcome.reason;
    return "NOT_ELIGIBLE";
  };
  const notices: OptimizerNotice[] = [];
  lockedSlots.slice(honoured[0]).forEach((lock) => {
    if (lock.id !== null) notices.push({ code: "MANUAL_SELECTION_UNAVAILABLE", group: "MERCHANDISE", slot: lock.key, voucherId: lock.id, reason: why("MERCHANDISE", lock.id) });
  });
  if (shippingLock !== null && shippingLock.id !== null && !honoured[1]) {
    notices.push({ code: "MANUAL_SELECTION_UNAVAILABLE", group: "SHIPPING_FREE", voucherId: shippingLock.id, reason: why("SHIPPING_FREE", shippingLock.id) });
  }

  const outcome = chosen.outcome;
  const merchandiseIds = chosen.merchandise.map((option) => option.id);
  const shippingId = chosen.shipping?.id ?? null;
  const evaluation = { ...outcome, merchandiseIds, shippingId } as EvaluatedCombination;
  const totalIncreaseVnd = outcome.totalPayableVnd - baseline.totalPayableVnd;
  const entitledSlotsLost = Math.max(0, baseline.gifts.entitledSlots - outcome.gifts.entitledSlots);
  const selectedSlotsLost = Math.max(0, baseline.gifts.retainedSelectedSlots - outcome.gifts.retainedSelectedSlots);
  return {
    ok: true,
    selection: Object.freeze({ merchandiseIds: Object.freeze(merchandiseIds), shippingId }),
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
