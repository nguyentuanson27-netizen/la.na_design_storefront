/**
 * The tier rule a Draft or Scheduled campaign carries (GQ09a): unit, ladder, FROM/ALL selection,
 * stacking priority and peers.
 *
 * Two layers, deliberately separate (spec FR-07, GQ09a):
 * - **Structure** (`validateTierRuleStructure`): malformed or unbounded input is refused on every
 *   write, Draft included -- integers only, bounds, allowlists, no duplicates, nothing the database
 *   would reject anyway. It never judges the *business* of a ladder.
 * - **Business** (`validateTierRuleForPublish`, added with the publish contract): strictly
 *   increasing thresholds, non-decreasing values, a selection priority for FROM, a priority and
 *   peers for stacking. A Draft may fail these and still be saved; until that validator exists a
 *   tier campaign cannot be published at all.
 */

import { MAX_TIERS_PER_CAMPAIGN } from "./gift-quantity-tier.ts";
import { MAX_STACK_PRIORITY } from "./gift-quantity-stack-priority.ts";
import type { StackPeer, StackPeerKind } from "./gift-quantity-stack.ts";

export const TIER_UNITS = ["PERCENTAGE", "FIXED_AMOUNT_PER_UNIT_VND"] as const;
export const TIER_DISCOUNTED_UNITS = ["ALL_ELIGIBLE_UNITS", "FROM_REACHED_THRESHOLD"] as const;
export const TIER_SELECTION_PRIORITIES = ["CHEAPEST_FIRST", "MOST_EXPENSIVE_FIRST"] as const;
/**
 * The peers a tier may name: the kinds the stacking engine actually pairs a tier with. A gift
 * campaign is deliberately not one of them: gifts are evaluated after every price step and are
 * only ever paired with other gifts (`resolveGiftCampaignStacking`), so a tier naming a gift would
 * store a consent nothing reads. If the owner wants tier/gift pairing to mean something, that is a
 * new stacking decision, not a field to accept silently.
 */
export const TIER_STACK_PEER_KINDS = ["PROMOTION", "FLASH_SALE", "CLEARANCE", "QUANTITY_TIER"] as const;

export const MAX_STACK_PEERS = 50;
const MAX_PEER_ID_LENGTH = 64;
const MAX_TIER_THRESHOLD = 1_000_000;
const MAX_TIER_VALUE = 2_000_000_000;

export type TierRuleInput = Readonly<{
  unit: (typeof TIER_UNITS)[number] | null;
  discountedUnits: (typeof TIER_DISCOUNTED_UNITS)[number] | null;
  selectionPriority: (typeof TIER_SELECTION_PRIORITIES)[number] | null;
  tiers: readonly Readonly<{ minQuantity: number; discountValue: number }>[];
  stackingEnabled: boolean;
  stackPriority: number | null;
  peers: readonly StackPeer[];
}>;

export type TierRuleParseReason =
  | "INVALID_TIER_UNIT"
  | "INVALID_TIER_DISCOUNTED_UNITS"
  | "INVALID_TIER_SELECTION_PRIORITY"
  | "INVALID_TIER_ROW"
  | "INVALID_STACKING_FLAG"
  | "INVALID_STACK_PRIORITY"
  | "INVALID_STACK_PEER";

export type ParsedTierRule =
  | Readonly<{ ok: true; value: TierRuleInput }>
  | Readonly<{ ok: false; reason: TierRuleParseReason }>;

/**
 * One optional value. Absent or blank is `null`; a repeated field, a non-string or a value outside
 * the allowlist is `undefined` (refused) -- the first of two competing values is never picked.
 */
function optionalAllowlisted<T extends string>(formData: FormData, field: string, allowed: readonly T[]): T | null | undefined {
  const entries = formData.getAll(field);
  if (entries.length === 0) return null;
  if (entries.length > 1) return undefined;
  const raw = entries[0];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length === 0) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Plain base-10 digits: no sign, fraction, exponent, separator or leading zero. */
function strictInt(raw: string): number | null {
  if (!/^(0|[1-9]\d{0,14})$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The submitted values of a repeated field, trimmed. More than `limit` entries is unbounded input
 * and is reported as `null` so the caller refuses it: truncating would silently drop rows (a blank
 * row early in the list must never push a real one past the cut).
 */
function boundedStrings(formData: FormData, field: string, limit: number): string[] | null {
  const entries = formData.getAll(field);
  if (entries.length > limit) return null;
  const values: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return null;
    values.push(entry.trim());
  }
  return values;
}

/** The form fields that make up the tier rule. A form that carries none of them leaves a stored rule alone. */
const TIER_RULE_FIELDS = [
  "tierRuleForm",
  "tierUnit",
  "tierDiscountedUnits",
  "tierSelectionPriority",
  "tierMinQuantity",
  "tierDiscountValue",
  "stackingEnabled",
  "stackPriority",
  "stackPeer",
] as const;

export function formCarriesTierRule(formData: FormData): boolean {
  return TIER_RULE_FIELDS.some((field) => formData.has(field));
}

/** Parses the tier fields of an admin form. Everything is strict: nothing is coerced or repaired. */
export function parseTierRuleForm(formData: FormData): ParsedTierRule {
  const unit = optionalAllowlisted(formData, "tierUnit", TIER_UNITS);
  if (unit === undefined) return { ok: false, reason: "INVALID_TIER_UNIT" };
  const discountedUnits = optionalAllowlisted(formData, "tierDiscountedUnits", TIER_DISCOUNTED_UNITS);
  if (discountedUnits === undefined) return { ok: false, reason: "INVALID_TIER_DISCOUNTED_UNITS" };
  const selectionPriority = optionalAllowlisted(formData, "tierSelectionPriority", TIER_SELECTION_PRIORITIES);
  if (selectionPriority === undefined) return { ok: false, reason: "INVALID_TIER_SELECTION_PRIORITY" };

  // Two parallel lists, one entry per ladder row. Blank rows are skipped only after both lists are
  // read in full, so nothing is cut off silently; the cap leaves room for a few blank form rows.
  const rowLimit = MAX_TIERS_PER_CAMPAIGN * 2;
  const thresholds = boundedStrings(formData, "tierMinQuantity", rowLimit);
  const values = boundedStrings(formData, "tierDiscountValue", rowLimit);
  if (thresholds === null || values === null || thresholds.length !== values.length) {
    return { ok: false, reason: "INVALID_TIER_ROW" };
  }
  const tiers: Array<{ minQuantity: number; discountValue: number }> = [];
  for (let index = 0; index < thresholds.length; index += 1) {
    const rawThreshold = thresholds[index]!;
    const rawValue = values[index]!;
    // A completely blank row is an empty form line, not a tier.
    if (rawThreshold === "" && rawValue === "") continue;
    const minQuantity = strictInt(rawThreshold);
    const discountValue = strictInt(rawValue);
    if (minQuantity === null || discountValue === null) return { ok: false, reason: "INVALID_TIER_ROW" };
    tiers.push({ minQuantity, discountValue });
  }

  // A checkbox: absent means off. Anything that is not a recognised on/off token is refused.
  const stackingValues = boundedStrings(formData, "stackingEnabled", 2);
  if (stackingValues === null || stackingValues.length > 1) return { ok: false, reason: "INVALID_STACKING_FLAG" };
  const stackingRaw = stackingValues[0];
  if (stackingRaw !== undefined && !["", "on", "true", "off", "false"].includes(stackingRaw)) {
    return { ok: false, reason: "INVALID_STACKING_FLAG" };
  }
  const stackingEnabled = stackingRaw === "on" || stackingRaw === "true";

  const priorityValues = boundedStrings(formData, "stackPriority", 2);
  if (priorityValues === null || priorityValues.length > 1) return { ok: false, reason: "INVALID_STACK_PRIORITY" };
  let stackPriority: number | null = null;
  if (priorityValues[0] !== undefined && priorityValues[0] !== "") {
    stackPriority = strictInt(priorityValues[0]);
    if (stackPriority === null) return { ok: false, reason: "INVALID_STACK_PRIORITY" };
  }

  const peerEntries = boundedStrings(formData, "stackPeer", MAX_STACK_PEERS * 2);
  if (peerEntries === null) return { ok: false, reason: "INVALID_STACK_PEER" };
  const peers: StackPeer[] = [];
  for (const entry of peerEntries) {
    if (entry === "") continue;
    const separator = entry.indexOf(":");
    if (separator < 1) return { ok: false, reason: "INVALID_STACK_PEER" };
    // The kind is checked by the structure validator, the single place that knows the allowlist.
    peers.push({ kind: entry.slice(0, separator) as StackPeerKind, campaignId: entry.slice(separator + 1) });
  }

  return { ok: true, value: { unit, discountedUnits, selectionPriority, tiers, stackingEnabled, stackPriority, peers } };
}

export type TierRuleStructureError =
  | "INVALID_TIER_UNIT"
  | "INVALID_TIER_DISCOUNTED_UNITS"
  | "INVALID_TIER_SELECTION_PRIORITY"
  | "INVALID_STACKING_FLAG"
  | "TIERS_TOO_MANY"
  | "TIER_THRESHOLD_OUT_OF_RANGE"
  | "TIER_VALUE_OUT_OF_RANGE"
  | "TIER_PERCENT_OUT_OF_RANGE"
  | "TIER_THRESHOLD_DUPLICATE"
  | "TIER_UNIT_REQUIRED"
  | "SELECTION_PRIORITY_NOT_APPLICABLE"
  | "STACK_PRIORITY_OUT_OF_RANGE"
  | "STACK_PEERS_TOO_MANY"
  | "STACK_PEER_INVALID"
  | "STACK_PEER_DUPLICATE";

/** Malformed or unbounded input. Enforced on every write, Draft included. */
export function validateTierRuleStructure(rule: TierRuleInput): readonly TierRuleStructureError[] {
  const errors = new Set<TierRuleStructureError>();
  // Services also accept typed inputs directly; the form parser is not their validation boundary.
  if (rule.unit !== null && !(TIER_UNITS as readonly string[]).includes(rule.unit)) errors.add("INVALID_TIER_UNIT");
  if (rule.discountedUnits !== null && !(TIER_DISCOUNTED_UNITS as readonly string[]).includes(rule.discountedUnits)) errors.add("INVALID_TIER_DISCOUNTED_UNITS");
  if (rule.selectionPriority !== null && !(TIER_SELECTION_PRIORITIES as readonly string[]).includes(rule.selectionPriority)) errors.add("INVALID_TIER_SELECTION_PRIORITY");
  if (typeof rule.stackingEnabled !== "boolean") errors.add("INVALID_STACKING_FLAG");
  if (rule.tiers.length > MAX_TIERS_PER_CAMPAIGN) errors.add("TIERS_TOO_MANY");
  if (rule.tiers.length > 0 && rule.unit === null) errors.add("TIER_UNIT_REQUIRED");

  const thresholds = new Set<number>();
  for (const tier of rule.tiers) {
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 1 || tier.minQuantity > MAX_TIER_THRESHOLD) {
      errors.add("TIER_THRESHOLD_OUT_OF_RANGE");
    }
    if (thresholds.has(tier.minQuantity)) errors.add("TIER_THRESHOLD_DUPLICATE");
    thresholds.add(tier.minQuantity);
    if (!Number.isSafeInteger(tier.discountValue) || tier.discountValue < 1 || tier.discountValue > MAX_TIER_VALUE) {
      errors.add("TIER_VALUE_OUT_OF_RANGE");
    } else if (rule.unit === "PERCENTAGE" && tier.discountValue > 99) {
      errors.add("TIER_PERCENT_OUT_OF_RANGE");
    }
  }

  // Only meaningful when only some units are discounted (the database enforces the same).
  if (rule.selectionPriority !== null && rule.discountedUnits !== "FROM_REACHED_THRESHOLD") {
    errors.add("SELECTION_PRIORITY_NOT_APPLICABLE");
  }

  if (rule.stackPriority !== null && (!Number.isSafeInteger(rule.stackPriority) || rule.stackPriority < 0 || rule.stackPriority > MAX_STACK_PRIORITY)) {
    errors.add("STACK_PRIORITY_OUT_OF_RANGE");
  }
  if (rule.peers.length > MAX_STACK_PEERS) errors.add("STACK_PEERS_TOO_MANY");
  const seen = new Set<string>();
  for (const peer of rule.peers) {
    if (!(TIER_STACK_PEER_KINDS as readonly string[]).includes(peer.kind)) errors.add("STACK_PEER_INVALID");
    if (typeof peer.campaignId !== "string" || peer.campaignId.length < 1 || peer.campaignId.length > MAX_PEER_ID_LENGTH || peer.campaignId.trim() !== peer.campaignId) {
      errors.add("STACK_PEER_INVALID");
    }
    const key = `${peer.kind}|${peer.campaignId}`;
    if (seen.has(key)) errors.add("STACK_PEER_DUPLICATE");
    seen.add(key);
  }
  return [...errors];
}
