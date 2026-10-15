import { applyPercentage } from "./promotion-pricing.ts";

/**
 * Gift & Quantity Promotions v1 (GQ06): pure quantity-tier pricing.
 *
 * Decisions this module encodes (ADR 0016):
 * - D-05: only the **highest reached tier** supplies the discount value. In `FROM_REACHED_THRESHOLD`
 *   the discounted unit count is `Q - N0 + 1` with `N0` the campaign's smallest threshold, never the
 *   winning tier's own threshold, so adding a unit can never lower the tier's total benefit.
 * - D-06: money is rounded half-up with `BigInt`, **per unit**, before units are grouped into lines.
 *   A line total is never rounded and prices are never averaged.
 * - Spec FR-07: a fixed-VND step must leave every discounted unit at >= 1 VND. If any unit that
 *   would be discounted cannot, the **whole tier** is dropped (`TIER_PRICE_INVALID`) -- never clamped
 *   to 1 VND, never partially applied to the cheaper units.
 *
 * No storage, no clock, no feature gate: the orchestrator (GQ07/GQ08) decides whether the tier runs.
 *
 * Order-value basis (owner decision, 15/10/2026): a ladder may be keyed on the paid order value instead
 * of the unit count -- "from 1.000.000 ₫ take 5 % off", "from 3.000.000 ₫ take 200.000 ₫ off". Same
 * ladder, same highest-reached-tier rule, same per-unit half-up rounding for a percentage, same
 * FR-07 all-or-nothing safety. A fixed amount is a *total*: the POS only takes line prices, so it is
 * split over the units in proportion to their price and the remainder goes, one VND at a time, to
 * the units with the largest fractional share, so the discounts add up to exactly the amount.
 */

export const MAX_TIERS_PER_CAMPAIGN = 20;
export const MAX_TIER_LINES = 200;
export const MAX_TIER_UNITS = 5_000;
const MAX_VND_DISCOUNT = 2_000_000_000;
/** The highest order value a threshold may name (the `QuantityTier.minQuantity` column is an INTEGER). */
export const MAX_ORDER_SUBTOTAL_THRESHOLD_VND = 2_000_000_000;

/** What the ladder's thresholds count: units in the basket, or the paid order value in whole VND. */
export type TierBasis = "QUANTITY" | "ORDER_SUBTOTAL";
export type TierDiscountUnit = "PERCENTAGE" | "FIXED_AMOUNT_PER_UNIT_VND" | "FIXED_AMOUNT_TOTAL_VND";
export type TierDiscountedUnits = "ALL_ELIGIBLE_UNITS" | "FROM_REACHED_THRESHOLD";
export type TierSelectionPriority = "CHEAPEST_FIRST" | "MOST_EXPENSIVE_FIRST";

/**
 * One rung. `minQuantity` is a unit count for a `QUANTITY` ladder and a VND order value for an
 * `ORDER_SUBTOTAL` one (the stored column is the same INTEGER for both).
 */
export type QuantityTierStep = Readonly<{ minQuantity: number; discountValue: number }>;

export type QuantityTierConfig = Readonly<{
  /** Absent means `QUANTITY`: every ladder written before the order-value basis existed. */
  basis?: TierBasis;
  unit: TierDiscountUnit;
  discountedUnits: TierDiscountedUnits;
  /** Required for `FROM_REACHED_THRESHOLD`, meaningless (and must be null) for `ALL_ELIGIBLE_UNITS`. */
  selectionPriority: TierSelectionPriority | null;
  tiers: readonly QuantityTierStep[];
}>;

export type TierConfigIssue =
  | "TIERS_EMPTY"
  | "TIERS_TOO_MANY"
  | "THRESHOLD_INVALID"
  | "THRESHOLD_NOT_STRICTLY_INCREASING"
  | "VALUE_INVALID"
  | "VALUE_DECREASES_WITH_THRESHOLD"
  | "SELECTION_PRIORITY_REQUIRED"
  | "SELECTION_PRIORITY_NOT_APPLICABLE"
  | "UNIT_INVALID"
  | "DISCOUNTED_UNITS_INVALID"
  | "BASIS_INVALID"
  | "DISCOUNT_NOT_BELOW_THRESHOLD";

/**
 * Validates the configuration the engine runs on. The server calls this on Draft-complete rules at
 * publish; the engine calls it again so it can never price from an unvalidated ladder.
 */
export function validateTierConfig(config: QuantityTierConfig): readonly TierConfigIssue[] {
  const issues = new Set<TierConfigIssue>();
  const basis: TierBasis = config.basis ?? "QUANTITY";
  const byOrderValue = basis === "ORDER_SUBTOTAL";

  if (basis !== "QUANTITY" && basis !== "ORDER_SUBTOTAL") issues.add("BASIS_INVALID");
  if (config.unit !== "PERCENTAGE" && config.unit !== "FIXED_AMOUNT_PER_UNIT_VND" && config.unit !== "FIXED_AMOUNT_TOTAL_VND") {
    issues.add("UNIT_INVALID");
  }
  // A per-unit amount is a quantity idea and a total is an order-value idea; the other pairing means
  // nothing ("take 200.000 ₫ off every unit from an order of 3.000.000 ₫" is a different promotion).
  if (byOrderValue && config.unit === "FIXED_AMOUNT_PER_UNIT_VND") issues.add("UNIT_INVALID");
  if (!byOrderValue && config.unit === "FIXED_AMOUNT_TOTAL_VND") issues.add("UNIT_INVALID");

  if (byOrderValue) {
    // The whole order's units are discounted; there is no "from the threshold" slice of an order value.
    if (config.discountedUnits !== "ALL_ELIGIBLE_UNITS") issues.add("DISCOUNTED_UNITS_INVALID");
    if (config.selectionPriority !== null) issues.add("SELECTION_PRIORITY_NOT_APPLICABLE");
  } else {
    if (config.discountedUnits !== "ALL_ELIGIBLE_UNITS" && config.discountedUnits !== "FROM_REACHED_THRESHOLD") {
      issues.add("DISCOUNTED_UNITS_INVALID");
    }
    if (config.discountedUnits === "FROM_REACHED_THRESHOLD") {
      if (config.selectionPriority !== "CHEAPEST_FIRST" && config.selectionPriority !== "MOST_EXPENSIVE_FIRST") {
        issues.add("SELECTION_PRIORITY_REQUIRED");
      }
    } else if (config.selectionPriority !== null) {
      issues.add("SELECTION_PRIORITY_NOT_APPLICABLE");
    }
  }

  if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
    issues.add("TIERS_EMPTY");
    return [...issues];
  }
  if (config.tiers.length > MAX_TIERS_PER_CAMPAIGN) {
    issues.add("TIERS_TOO_MANY");
    return [...issues];
  }

  const maxThreshold = byOrderValue ? MAX_ORDER_SUBTOTAL_THRESHOLD_VND : Number.MAX_SAFE_INTEGER;
  let previous: QuantityTierStep | null = null;
  for (const tier of config.tiers) {
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 1 || tier.minQuantity > maxThreshold) issues.add("THRESHOLD_INVALID");
    const valueOk =
      Number.isSafeInteger(tier.discountValue) &&
      (config.unit === "PERCENTAGE"
        ? tier.discountValue >= 1 && tier.discountValue <= 99
        : tier.discountValue >= 1 && tier.discountValue <= MAX_VND_DISCOUNT);
    if (!valueOk) issues.add("VALUE_INVALID");
    // A total taken off an order must be smaller than the order value that earns it: otherwise the
    // order could be priced at nothing or below, and no unit could stay >= 1 VND.
    if (config.unit === "FIXED_AMOUNT_TOTAL_VND" && valueOk && tier.discountValue >= tier.minQuantity) {
      issues.add("DISCOUNT_NOT_BELOW_THRESHOLD");
    }
    if (previous !== null) {
      if (tier.minQuantity <= previous.minQuantity) issues.add("THRESHOLD_NOT_STRICTLY_INCREASING");
      // Same-unit values must not fall as the threshold rises (R-05): otherwise buying more could
      // cost more per discounted unit.
      if (tier.discountValue < previous.discountValue) issues.add("VALUE_DECREASES_WITH_THRESHOLD");
    }
    previous = tier;
  }
  return [...issues];
}

/** A paid line the tier looks at. Callers pass only lines already inside the campaign scope. */
export type TierInputLine = Readonly<{
  /** Stable identity of the source line, unique within the call. Never a cart id or PII. */
  lineKey: string;
  pancakeVariationId: string;
  quantity: number;
  /** Per-unit price immediately before this step, whole VND (>= 1). */
  unitPriceVnd: number;
}>;

export type TierPriceSegment = Readonly<{
  /**
   * `${lineKey}|disc` for discounted units, `${lineKey}|full` for the rest. Stable for equal facts.
   * The separator is `|`, which the stack layer forbids in any caller-supplied line key, so a derived
   * key can never equal an original one; derived keys are injective in (parent key, suffix).
   */
  segmentKey: string;
  lineKey: string;
  pancakeVariationId: string;
  quantity: number;
  unitPriceBeforeVnd: number;
  unitPriceVnd: number;
  /** VND taken off each unit of this segment by this step; 0 for undiscounted segments. */
  stepDiscountPerUnitVnd: number;
  discounted: boolean;
  lineTotalVnd: number;
}>;

export type TierResult =
  | Readonly<{
      status: "NOT_REACHED";
      eligibleQuantity: number;
      /** `N0`, the smallest configured threshold. */
      startThreshold: number;
      segments: readonly TierPriceSegment[];
      totalDiscountVnd: 0;
      discountedUnitCount: 0;
    }>
  | Readonly<{
      status: "APPLIED";
      eligibleQuantity: number;
      startThreshold: number;
      winningTier: QuantityTierStep;
      discountedUnitCount: number;
      totalDiscountVnd: number;
      segments: readonly TierPriceSegment[];
    }>
  | Readonly<{
      status: "TIER_PRICE_INVALID";
      eligibleQuantity: number;
      startThreshold: number;
      winningTier: QuantityTierStep;
      /** Source lines holding a unit that would not stay >= 1 VND. */
      offendingLineKeys: readonly string[];
      /** Prices are returned **unchanged**: the whole tier is dropped, not part of it. */
      segments: readonly TierPriceSegment[];
      totalDiscountVnd: 0;
      discountedUnitCount: 0;
    }>
  | Readonly<{ status: "INVALID_CONFIG"; issues: readonly TierConfigIssue[] }>
  | Readonly<{ status: "INVALID_INPUT"; reason: string }>;

/** The price a unit ends at after one step, or null when the step is not valid for that price. */
export function applyTierStep(unit: TierDiscountUnit, discountValue: number, unitPriceVnd: number): number | null {
  // A fixed total is split over units by `priceOrderSubtotalTier`; it has no single per-unit answer.
  if (unit === "FIXED_AMOUNT_TOTAL_VND") return null;
  if (!Number.isSafeInteger(unitPriceVnd) || unitPriceVnd < 1) return null;
  const next =
    unit === "PERCENTAGE" ? applyPercentage(unitPriceVnd, discountValue) : unitPriceVnd - discountValue;
  // A paid unit must stay a positive whole number, and a step never raises a price. A percentage
  // that rounds back to the same price discounts that unit by 0 VND; that is valid, not an error.
  if (next === null || !Number.isSafeInteger(next) || next < 1 || next > unitPriceVnd) return null;
  return next;
}

function unchanged(lines: readonly TierInputLine[]): TierPriceSegment[] {
  return lines.map((line) => ({
    segmentKey: `${line.lineKey}|full`,
    lineKey: line.lineKey,
    pancakeVariationId: line.pancakeVariationId,
    quantity: line.quantity,
    unitPriceBeforeVnd: line.unitPriceVnd,
    unitPriceVnd: line.unitPriceVnd,
    stepDiscountPerUnitVnd: 0,
    discounted: false,
    lineTotalVnd: line.quantity * line.unitPriceVnd,
  }));
}

function compareLines(priority: TierSelectionPriority, a: TierInputLine, b: TierInputLine): number {
  const byPrice = a.unitPriceVnd - b.unitPriceVnd;
  if (byPrice !== 0) return priority === "CHEAPEST_FIRST" ? byPrice : -byPrice;
  // Deterministic, independent of the order the browser or the database returned the lines in.
  if (a.pancakeVariationId !== b.pancakeVariationId) return a.pancakeVariationId < b.pancakeVariationId ? -1 : 1;
  return a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0;
}

type TierInputs = Readonly<{ ok: true; eligibleQuantity: number; sourceSubtotalVnd: number }> | Readonly<{ ok: false; result: TierResult }>;

/** Shape-checks the lines and sums them; shared by both bases so they refuse exactly the same inputs. */
function readTierInputs(lines: readonly TierInputLine[]): TierInputs {
  if (!Array.isArray(lines) || lines.length > MAX_TIER_LINES) return { ok: false, result: { status: "INVALID_INPUT", reason: "TOO_MANY_LINES" } };
  const seenKeys = new Set<string>();
  let eligibleQuantity = 0;
  let sourceSubtotalVnd = 0;
  for (const line of lines) {
    if (typeof line.lineKey !== "string" || line.lineKey.length === 0 || seenKeys.has(line.lineKey)) {
      return { ok: false, result: { status: "INVALID_INPUT", reason: "LINE_KEY_INVALID" } };
    }
    seenKeys.add(line.lineKey);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return { ok: false, result: { status: "INVALID_INPUT", reason: "QUANTITY_INVALID" } };
    if (!Number.isSafeInteger(line.unitPriceVnd) || line.unitPriceVnd < 1) return { ok: false, result: { status: "INVALID_INPUT", reason: "PRICE_INVALID" } };
    eligibleQuantity += line.quantity;
    if (eligibleQuantity > MAX_TIER_UNITS) return { ok: false, result: { status: "INVALID_INPUT", reason: "TOO_MANY_UNITS" } };
    // Every total this module reports derives from these; refuse before any of them can wrap.
    sourceSubtotalVnd += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(sourceSubtotalVnd)) return { ok: false, result: { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" } };
  }
  return { ok: true, eligibleQuantity, sourceSubtotalVnd };
}

/** Prices a ladder on whichever basis it declares; the stacking orchestrator calls this. */
export function priceTier(config: QuantityTierConfig, lines: readonly TierInputLine[]): TierResult {
  return config.basis === "ORDER_SUBTOTAL" ? priceOrderSubtotalTier(config, lines) : priceQuantityTier(config, lines);
}

export function priceQuantityTier(config: QuantityTierConfig, lines: readonly TierInputLine[]): TierResult {
  const issues = validateTierConfig(config);
  if (issues.length > 0) return { status: "INVALID_CONFIG", issues };
  if (config.basis === "ORDER_SUBTOTAL") return { status: "INVALID_INPUT", reason: "WRONG_BASIS" };

  const inputs = readTierInputs(lines);
  if (!inputs.ok) return inputs.result;
  const { eligibleQuantity } = inputs;

  const startThreshold = config.tiers[0]!.minQuantity;
  if (eligibleQuantity < startThreshold) {
    return {
      status: "NOT_REACHED",
      eligibleQuantity,
      startThreshold,
      segments: unchanged(lines),
      totalDiscountVnd: 0,
      discountedUnitCount: 0,
    };
  }

  // Highest tier whose threshold Q reaches. Tiers are strictly increasing, so the last match wins.
  let winningTier = config.tiers[0]!;
  for (const tier of config.tiers) if (tier.minQuantity <= eligibleQuantity) winningTier = tier;

  const discountedUnitCount =
    config.discountedUnits === "ALL_ELIGIBLE_UNITS" ? eligibleQuantity : eligibleQuantity - startThreshold + 1;

  // Allocate discounted units line by line in the configured, deterministic order. Units inside one
  // line are identical, so taking them from a line in bulk is exactly the unit-by-unit ordering.
  const priority = config.selectionPriority ?? "CHEAPEST_FIRST";
  const ordered = [...lines].sort((a, b) => compareLines(priority, a, b));
  const allocation = new Map<string, number>();
  let remaining = discountedUnitCount;
  for (const line of ordered) {
    if (remaining === 0) break;
    const take = Math.min(remaining, line.quantity);
    allocation.set(line.lineKey, take);
    remaining -= take;
  }

  // Validate every discounted unit before changing any price: one invalid unit drops the whole tier.
  const offending: string[] = [];
  const discountedPrice = new Map<string, number>();
  for (const line of lines) {
    if (!allocation.has(line.lineKey)) continue;
    const next = applyTierStep(config.unit, winningTier.discountValue, line.unitPriceVnd);
    if (next === null) offending.push(line.lineKey);
    else discountedPrice.set(line.lineKey, next);
  }
  if (offending.length > 0) {
    return {
      status: "TIER_PRICE_INVALID",
      eligibleQuantity,
      startThreshold,
      winningTier,
      offendingLineKeys: offending.sort(),
      segments: unchanged(lines),
      totalDiscountVnd: 0,
      discountedUnitCount: 0,
    };
  }

  const segments: TierPriceSegment[] = [];
  let totalDiscountVnd = 0;
  for (const line of lines) {
    const discountedQuantity = allocation.get(line.lineKey) ?? 0;
    if (discountedQuantity > 0) {
      const price = discountedPrice.get(line.lineKey)!;
      const perUnit = line.unitPriceVnd - price;
      totalDiscountVnd += perUnit * discountedQuantity;
      segments.push({
        segmentKey: `${line.lineKey}|disc`,
        lineKey: line.lineKey,
        pancakeVariationId: line.pancakeVariationId,
        quantity: discountedQuantity,
        unitPriceBeforeVnd: line.unitPriceVnd,
        unitPriceVnd: price,
        stepDiscountPerUnitVnd: perUnit,
        discounted: true,
        lineTotalVnd: price * discountedQuantity,
      });
    }
    const fullQuantity = line.quantity - discountedQuantity;
    if (fullQuantity > 0) {
      segments.push({
        segmentKey: `${line.lineKey}|full`,
        lineKey: line.lineKey,
        pancakeVariationId: line.pancakeVariationId,
        quantity: fullQuantity,
        unitPriceBeforeVnd: line.unitPriceVnd,
        unitPriceVnd: line.unitPriceVnd,
        stepDiscountPerUnitVnd: 0,
        discounted: false,
        lineTotalVnd: line.unitPriceVnd * fullQuantity,
      });
    }
  }
  if (!Number.isSafeInteger(totalDiscountVnd)) return { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" };

  return {
    status: "APPLIED",
    eligibleQuantity,
    startThreshold,
    winningTier,
    discountedUnitCount,
    totalDiscountVnd,
    segments,
  };
}

/**
 * A ladder keyed on the paid order value (see the header). `lines` are the paid groups in scope at
 * the price each has *after every earlier step*, so the threshold is judged on what the shopper
 * would actually pay for goods, before shipping and never counting free gifts.
 *
 * - `PERCENTAGE`: every unit of every line takes the winning percentage off, half-up per unit
 *   (D-06), exactly like a quantity ladder over all units.
 * - `FIXED_AMOUNT_TOTAL_VND`: the winning amount `D` comes off the order once, split over units in
 *   proportion to price. Each unit's real share is `D*p/S`; every unit takes the floor of it, and the
 *   `R` VND still owed (`R < units`) go one apiece to the units with the largest fractional share
 *   (ties: dearer unit, then variation id, then line key -- never input order). The segments' discounts
 *   therefore sum to exactly `D`, and units inside one line differ by at most 1 VND, so a line splits
 *   into at most two segments.
 * - As everywhere (FR-07), if any unit would not stay >= 1 VND the **whole** tier is dropped and prices
 *   come back unchanged.
 */
export function priceOrderSubtotalTier(config: QuantityTierConfig, lines: readonly TierInputLine[]): TierResult {
  const issues = validateTierConfig(config);
  if (issues.length > 0) return { status: "INVALID_CONFIG", issues };
  if (config.basis !== "ORDER_SUBTOTAL") return { status: "INVALID_INPUT", reason: "WRONG_BASIS" };

  const inputs = readTierInputs(lines);
  if (!inputs.ok) return inputs.result;
  const { eligibleQuantity, sourceSubtotalVnd } = inputs;

  const startThreshold = config.tiers[0]!.minQuantity;
  if (sourceSubtotalVnd < startThreshold) {
    return { status: "NOT_REACHED", eligibleQuantity, startThreshold, segments: unchanged(lines), totalDiscountVnd: 0, discountedUnitCount: 0 };
  }

  // Highest rung the order value reaches. Rungs are strictly increasing, so the last match wins.
  let winningTier = config.tiers[0]!;
  for (const tier of config.tiers) if (tier.minQuantity <= sourceSubtotalVnd) winningTier = tier;

  const invalid = (offending: readonly string[]): TierResult => ({
    status: "TIER_PRICE_INVALID",
    eligibleQuantity,
    startThreshold,
    winningTier,
    offendingLineKeys: [...offending].sort(),
    segments: unchanged(lines),
    totalDiscountVnd: 0,
    discountedUnitCount: 0,
  });

  const segments: TierPriceSegment[] = [];
  let totalDiscountVnd = 0;
  const push = (line: TierInputLine, suffix: string, quantity: number, perUnit: number) => {
    totalDiscountVnd += perUnit * quantity;
    segments.push({
      segmentKey: `${line.lineKey}|${suffix}`,
      lineKey: line.lineKey,
      pancakeVariationId: line.pancakeVariationId,
      quantity,
      unitPriceBeforeVnd: line.unitPriceVnd,
      unitPriceVnd: line.unitPriceVnd - perUnit,
      stepDiscountPerUnitVnd: perUnit,
      discounted: perUnit > 0,
      lineTotalVnd: (line.unitPriceVnd - perUnit) * quantity,
    });
  };

  if (config.unit === "PERCENTAGE") {
    const offending: string[] = [];
    const perUnitOf = new Map<string, number>();
    for (const line of lines) {
      const next = applyTierStep("PERCENTAGE", winningTier.discountValue, line.unitPriceVnd);
      if (next === null) offending.push(line.lineKey);
      else perUnitOf.set(line.lineKey, line.unitPriceVnd - next);
    }
    if (offending.length > 0) return invalid(offending);
    for (const line of lines) {
      const perUnit = perUnitOf.get(line.lineKey)!;
      // Kept as a discounted segment even when rounding gives 0 VND, as a quantity ladder does.
      push(line, "disc", line.quantity, perUnit);
      segments[segments.length - 1] = { ...segments[segments.length - 1]!, discounted: true };
    }
  } else {
    const total = BigInt(winningTier.discountValue);
    const subtotal = BigInt(sourceSubtotalVnd);
    const shares = lines.map((line) => {
      const numerator = total * BigInt(line.unitPriceVnd);
      return { line, floor: numerator / subtotal, remainder: numerator % subtotal };
    });
    let owed = total;
    for (const share of shares) owed -= share.floor * BigInt(share.line.quantity);
    // `owed` is the sum over units of the fractional shares, a whole number below the unit count.
    if (owed < BigInt(0) || owed >= BigInt(eligibleQuantity)) return { status: "INVALID_INPUT", reason: "ALLOCATION_INCONSISTENT" };

    const order = [...shares].sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      if (a.line.unitPriceVnd !== b.line.unitPriceVnd) return b.line.unitPriceVnd - a.line.unitPriceVnd;
      if (a.line.pancakeVariationId !== b.line.pancakeVariationId) return a.line.pancakeVariationId < b.line.pancakeVariationId ? -1 : 1;
      return a.line.lineKey < b.line.lineKey ? -1 : a.line.lineKey > b.line.lineKey ? 1 : 0;
    });
    let remaining = Number(owed);
    const extraUnits = new Map<string, number>();
    for (const share of order) {
      if (remaining === 0) break;
      const take = Math.min(remaining, share.line.quantity);
      extraUnits.set(share.line.lineKey, take);
      remaining -= take;
    }

    const offending: string[] = [];
    for (const share of shares) {
      const floor = Number(share.floor);
      const extra = extraUnits.get(share.line.lineKey) ?? 0;
      // The dearest discount this line's units take must still leave a whole, positive price.
      if (share.line.unitPriceVnd - (extra > 0 ? floor + 1 : floor) < 1) offending.push(share.line.lineKey);
    }
    if (offending.length > 0) return invalid(offending);

    for (const share of shares) {
      const floor = Number(share.floor);
      const extra = extraUnits.get(share.line.lineKey) ?? 0;
      if (extra > 0) push(share.line, "disc", extra, floor + 1);
      const rest = share.line.quantity - extra;
      if (rest > 0) push(share.line, floor > 0 ? "discb" : "full", rest, floor);
    }
    // Defensive: the construction guarantees the segments take off exactly the amount promised.
    if (BigInt(totalDiscountVnd) !== total) return { status: "INVALID_INPUT", reason: "ALLOCATION_INCONSISTENT" };
  }
  if (!Number.isSafeInteger(totalDiscountVnd)) return { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" };

  return {
    status: "APPLIED",
    eligibleQuantity,
    startThreshold,
    winningTier,
    discountedUnitCount: eligibleQuantity,
    totalDiscountVnd,
    segments,
  };
}

/**
 * Publish-time safety (spec FR-07): the unit prices a campaign could touch that the **largest**
 * tier value would not leave valid. Values never decrease with the threshold, so the largest value
 * is the worst case for every tier. Prices are the amounts remaining after every earlier step.
 */
export function findPricesInvalidForTier(config: QuantityTierConfig, unitPricesVnd: readonly number[]): readonly number[] {
  const issues = validateTierConfig(config);
  if (issues.length > 0) return [];
  // A fixed total is split over the whole order at quote time, so no single price can be "invalid" for it.
  if (config.unit === "FIXED_AMOUNT_TOTAL_VND") return [];
  const worst = config.tiers[config.tiers.length - 1]!.discountValue;
  return unitPricesVnd.filter((price) => applyTierStep(config.unit, worst, price) === null);
}
