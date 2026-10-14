/**
 * Counts-only telemetry summary of a benefit quote (GQ24). Kept apart from the resolver so it is pure
 * and loads without a database.
 */

import type { DroppedBenefitInput } from "./order-quote-snapshot.ts";
import type { QuoteStructure } from "./order-quote-rules.ts";

/**
 * Counts-only summary of a benefit quote for telemetry (GQ24). No campaign id, variant id, cart id or
 * money: a log line built from this can say how often a stack conflict or an unclaimed slot happens,
 * and nothing about whose cart it was.
 */
export type BenefitQuoteSummary = Readonly<{
  paidLines: number;
  giftLines: number;
  /** STACK_NOT_PERMITTED + STACK_PRIORITY_CONFLICT. */
  stackConflicts: number;
  tierPriceInvalid: number;
  /** TIER_CONFIG_INVALID + TIER_INPUT_INVALID. */
  tierConfigInvalid: number;
  entitledSlots: number;
  selectedSlots: number;
  /** Entitled but not taken: what the buyer is asked to acknowledge. */
  unclaimedSlots: number;
  /** Slots lost to stock (gift variant out of stock, or contended with another campaign). */
  stockShortSlots: number;
}>;

export function summarizeBenefitQuote(resolution: Readonly<{ facts: QuoteStructure; dropped: readonly DroppedBenefitInput[] }>): BenefitQuoteSummary {
  const count = (reasons: readonly string[]) => resolution.dropped.filter((entry) => reasons.includes(entry.reason)).length;
  let entitledSlots = 0;
  let selectedSlots = 0;
  let stockShortSlots = 0;
  for (const entry of resolution.facts.entitlements) {
    entitledSlots += entry.entitled;
    selectedSlots += entry.selected;
    stockShortSlots += entry.shortForStock + entry.contendedForSharedStock;
  }
  return Object.freeze({
    paidLines: resolution.facts.lines.filter((line) => line.role === "PAID").length,
    giftLines: resolution.facts.lines.filter((line) => line.role === "GIFT").length,
    stackConflicts: count(["STACK_NOT_PERMITTED", "STACK_PRIORITY_CONFLICT"]),
    tierPriceInvalid: count(["TIER_PRICE_INVALID"]),
    tierConfigInvalid: count(["TIER_CONFIG_INVALID", "TIER_INPUT_INVALID"]),
    entitledSlots,
    selectedSlots,
    unclaimedSlots: Math.max(0, entitledSlots - selectedSlots),
    stockShortSlots,
  });
}

