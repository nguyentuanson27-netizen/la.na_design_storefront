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
 */

export const MAX_TIERS_PER_CAMPAIGN = 20;
export const MAX_TIER_LINES = 200;
export const MAX_TIER_UNITS = 5_000;
const MAX_VND_DISCOUNT = 2_000_000_000;

export type TierDiscountUnit = "PERCENTAGE" | "FIXED_AMOUNT_PER_UNIT_VND";
export type TierDiscountedUnits = "ALL_ELIGIBLE_UNITS" | "FROM_REACHED_THRESHOLD";
export type TierSelectionPriority = "CHEAPEST_FIRST" | "MOST_EXPENSIVE_FIRST";

export type QuantityTierStep = Readonly<{ minQuantity: number; discountValue: number }>;

export type QuantityTierConfig = Readonly<{
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
  | "DISCOUNTED_UNITS_INVALID";

/**
 * Validates the configuration the engine runs on. The server calls this on Draft-complete rules at
 * publish; the engine calls it again so it can never price from an unvalidated ladder.
 */
export function validateTierConfig(config: QuantityTierConfig): readonly TierConfigIssue[] {
  const issues = new Set<TierConfigIssue>();

  if (config.unit !== "PERCENTAGE" && config.unit !== "FIXED_AMOUNT_PER_UNIT_VND") issues.add("UNIT_INVALID");
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

  if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
    issues.add("TIERS_EMPTY");
    return [...issues];
  }
  if (config.tiers.length > MAX_TIERS_PER_CAMPAIGN) {
    issues.add("TIERS_TOO_MANY");
    return [...issues];
  }

  let previous: QuantityTierStep | null = null;
  for (const tier of config.tiers) {
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 1) issues.add("THRESHOLD_INVALID");
    const valueOk =
      Number.isSafeInteger(tier.discountValue) &&
      (config.unit === "PERCENTAGE"
        ? tier.discountValue >= 1 && tier.discountValue <= 99
        : tier.discountValue >= 1 && tier.discountValue <= MAX_VND_DISCOUNT);
    if (!valueOk) issues.add("VALUE_INVALID");
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

export function priceQuantityTier(config: QuantityTierConfig, lines: readonly TierInputLine[]): TierResult {
  const issues = validateTierConfig(config);
  if (issues.length > 0) return { status: "INVALID_CONFIG", issues };

  if (!Array.isArray(lines) || lines.length > MAX_TIER_LINES) return { status: "INVALID_INPUT", reason: "TOO_MANY_LINES" };
  const seenKeys = new Set<string>();
  let eligibleQuantity = 0;
  let sourceSubtotalVnd = 0;
  for (const line of lines) {
    if (typeof line.lineKey !== "string" || line.lineKey.length === 0 || seenKeys.has(line.lineKey)) {
      return { status: "INVALID_INPUT", reason: "LINE_KEY_INVALID" };
    }
    seenKeys.add(line.lineKey);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return { status: "INVALID_INPUT", reason: "QUANTITY_INVALID" };
    if (!Number.isSafeInteger(line.unitPriceVnd) || line.unitPriceVnd < 1) return { status: "INVALID_INPUT", reason: "PRICE_INVALID" };
    eligibleQuantity += line.quantity;
    if (eligibleQuantity > MAX_TIER_UNITS) return { status: "INVALID_INPUT", reason: "TOO_MANY_UNITS" };
    // Every total this module reports derives from these; refuse before any of them can wrap.
    sourceSubtotalVnd += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(sourceSubtotalVnd)) return { status: "INVALID_INPUT", reason: "TOTAL_OVERFLOW" };
  }

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
 * Publish-time safety (spec FR-07): the unit prices a campaign could touch that the **largest**
 * tier value would not leave valid. Values never decrease with the threshold, so the largest value
 * is the worst case for every tier. Prices are the amounts remaining after every earlier step.
 */
export function findPricesInvalidForTier(config: QuantityTierConfig, unitPricesVnd: readonly number[]): readonly number[] {
  const issues = validateTierConfig(config);
  if (issues.length > 0) return [];
  const worst = config.tiers[config.tiers.length - 1]!.discountValue;
  return unitPricesVnd.filter((price) => applyTierStep(config.unit, worst, price) === null);
}
