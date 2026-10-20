/**
 * The gift rule a Draft or Scheduled `GIFT_ITEM` campaign carries (GQ13a): the Q / S threshold, the
 * award mode, the per-order cap, the duplicate policy and the variant allowlist.
 *
 * Same two layers, deliberately separate, as the tier rule (`gift-quantity-tier-rule.ts`):
 * - **Structure** (`validateGiftRuleStructure`): malformed or unbounded input is refused on every
 *   write, Draft included -- plain integers, bounds, allowlists, no duplicates, nothing the
 *   database would reject anyway, and no field that does not belong to the chosen trigger. It never
 *   judges whether the rule is *finished*.
 * - **Business** (`validateGiftRuleForPublish`): the trigger is chosen, its threshold exists, the
 *   duplicate policy was decided and there is at least one option. A Draft may fail these and still
 *   be saved; publish and Scheduled edits are refused until they hold. Checks that need other rows
 *   (an allowlisted variant exists and has proven READY capacity) live in
 *   `giftOptionErrors` and run in the publish / Scheduled-edit transaction.
 *
 * The trigger (`QUANTITY` or `ORDER_SUBTOTAL`) and `subtotalScope` stay on the Draft form values and
 * the Scheduled-edit identity checks (GQ05): a rule describes only what the trigger decides. A
 * quantity trigger owns `minimumQuantity` and nothing else; a subtotal trigger owns
 * `minimumSubtotalVnd` and `awardMode`. The cap, duplicate policy and options apply to both.
 *
 * Out of scope here: gift-to-gift stacking consent (`stackingEnabled` / peers). Without it two gift
 * campaigns earning on one cart both step aside (`resolveGiftCampaignStacking`), which fails closed.
 */

import type { GiftAwardMode, GiftTrigger, PrismaClient } from "../generated/prisma/client.ts";
import { readyGiftOptionStock } from "./gift-quantity-gift-option-capacity.ts";
import { MAX_GIFT_CAMPAIGNS, MAX_GIFT_OPTIONS_PER_CAMPAIGN, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP } from "./gift-quantity-entitlement.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import type { Tx } from "./promotion-activation-service.ts";

export const GIFT_AWARD_MODES = ["ONCE", "REPEAT_PER_THRESHOLD"] as const;

/** Same bounds as the `GiftQuantityCampaign_bounds_check` database constraint. */
export const MAX_GIFT_THRESHOLD_QUANTITY = 1_000_000;
export const MAX_GIFT_THRESHOLD_SUBTOTAL_VND = 100_000_000_000;

export type GiftRuleInput = Readonly<{
  /** QUANTITY trigger: `N` paid units. */
  minimumQuantity: number | null;
  /** ORDER_SUBTOTAL trigger: `T` in whole VND (a plain number: the bound is far below 2^53). */
  minimumSubtotalVnd: number | null;
  /** ORDER_SUBTOTAL trigger only. A quantity trigger always grants `floor(Q / N)`. */
  awardMode: GiftAwardMode | null;
  /** Null means "no explicit cap": the technical cap still applies at evaluation. */
  maxGiftsPerOrder: number | null;
  /** Null only for a row nobody has configured yet; a form always sends a boolean. */
  allowDuplicateGifts: boolean | null;
  /** Allowlisted gift variants (`VariantMirror.id`). */
  variantIds: readonly string[];
}>;

export type GiftRuleParseReason =
  | "INVALID_GIFT_MINIMUM_QUANTITY"
  | "INVALID_GIFT_MINIMUM_SUBTOTAL"
  | "INVALID_GIFT_AWARD_MODE"
  | "INVALID_GIFT_MAX_PER_ORDER"
  | "INVALID_GIFT_DUPLICATE_FLAG"
  | "INVALID_GIFT_VARIANT";

export type ParsedGiftRule =
  | Readonly<{ ok: true; value: GiftRuleInput }>
  | Readonly<{ ok: false; reason: GiftRuleParseReason }>;

/** The form fields that make up the gift rule. A form that carries none of them leaves a stored rule alone. */
const GIFT_RULE_FIELDS = [
  "giftRuleForm",
  "giftMinimumQuantity",
  "giftMinimumSubtotalVnd",
  "giftAwardMode",
  "giftMaxPerOrder",
  "giftAllowDuplicates",
  "giftVariantId",
] as const;

export function formCarriesGiftRule(formData: FormData): boolean {
  return GIFT_RULE_FIELDS.some((field) => formData.has(field));
}

/** Plain base-10 digits: no sign, fraction, exponent, separator or leading zero. */
function strictInt(raw: string): number | null {
  if (!/^(0|[1-9]\d{0,14})$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** One optional value: absent or blank is `null`; a repeated or non-string field is `undefined` (refused). */
function optionalSingle(formData: FormData, field: string): string | null | undefined {
  const entries = formData.getAll(field);
  if (entries.length === 0) return null;
  if (entries.length > 1) return undefined;
  const raw = entries[0];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

/** Parses the gift fields of an admin form. Everything is strict: nothing is coerced or repaired. */
export function parseGiftRuleForm(formData: FormData): ParsedGiftRule {
  const quantityRaw = optionalSingle(formData, "giftMinimumQuantity");
  if (quantityRaw === undefined) return { ok: false, reason: "INVALID_GIFT_MINIMUM_QUANTITY" };
  const minimumQuantity = quantityRaw === null ? null : strictInt(quantityRaw);
  if (quantityRaw !== null && minimumQuantity === null) return { ok: false, reason: "INVALID_GIFT_MINIMUM_QUANTITY" };

  const subtotalRaw = optionalSingle(formData, "giftMinimumSubtotalVnd");
  if (subtotalRaw === undefined) return { ok: false, reason: "INVALID_GIFT_MINIMUM_SUBTOTAL" };
  const minimumSubtotalVnd = subtotalRaw === null ? null : strictInt(subtotalRaw);
  if (subtotalRaw !== null && minimumSubtotalVnd === null) return { ok: false, reason: "INVALID_GIFT_MINIMUM_SUBTOTAL" };

  const awardRaw = optionalSingle(formData, "giftAwardMode");
  if (awardRaw === undefined || (awardRaw !== null && !(GIFT_AWARD_MODES as readonly string[]).includes(awardRaw))) {
    return { ok: false, reason: "INVALID_GIFT_AWARD_MODE" };
  }

  const maxRaw = optionalSingle(formData, "giftMaxPerOrder");
  if (maxRaw === undefined) return { ok: false, reason: "INVALID_GIFT_MAX_PER_ORDER" };
  const maxGiftsPerOrder = maxRaw === null ? null : strictInt(maxRaw);
  if (maxRaw !== null && maxGiftsPerOrder === null) return { ok: false, reason: "INVALID_GIFT_MAX_PER_ORDER" };

  // A checkbox: absent means off. Anything that is not a recognised on/off token is refused.
  const flagRaw = optionalSingle(formData, "giftAllowDuplicates");
  if (flagRaw === undefined || (flagRaw !== null && !["on", "true", "off", "false"].includes(flagRaw))) {
    return { ok: false, reason: "INVALID_GIFT_DUPLICATE_FLAG" };
  }
  const allowDuplicateGifts = flagRaw === "on" || flagRaw === "true";

  // More than the bound is unbounded input and is refused whole: truncating would silently drop
  // options (a blank entry early in the list must never push a real one past the cut).
  const entries = formData.getAll("giftVariantId");
  if (entries.length > MAX_GIFT_OPTIONS_PER_CAMPAIGN * 2) return { ok: false, reason: "INVALID_GIFT_VARIANT" };
  const variantIds: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return { ok: false, reason: "INVALID_GIFT_VARIANT" };
    const id = entry.trim();
    if (id.length > 0) variantIds.push(id);
  }

  return {
    ok: true,
    value: { minimumQuantity, minimumSubtotalVnd, awardMode: awardRaw as GiftAwardMode | null, maxGiftsPerOrder, allowDuplicateGifts, variantIds },
  };
}

export type GiftRuleStructureError =
  | "GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"
  | "GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE"
  | "INVALID_GIFT_AWARD_MODE"
  | "GIFT_MAX_PER_ORDER_OUT_OF_RANGE"
  | "INVALID_GIFT_DUPLICATE_FLAG"
  | "GIFT_OPTIONS_TOO_MANY"
  | "GIFT_OPTION_INVALID"
  | "GIFT_OPTION_DUPLICATE"
  | "GIFT_TRIGGER_REQUIRED_FOR_THRESHOLD"
  | "GIFT_FIELD_NOT_APPLICABLE";

function isInRange(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/**
 * Malformed or unbounded input, independent of the trigger. Services also accept typed inputs
 * directly, so the form parser is not their validation boundary.
 */
export function validateGiftRuleBounds(rule: GiftRuleInput): readonly GiftRuleStructureError[] {
  const errors = new Set<GiftRuleStructureError>();
  if (rule.minimumQuantity !== null && !isInRange(rule.minimumQuantity, MAX_GIFT_THRESHOLD_QUANTITY)) errors.add("GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE");
  if (rule.minimumSubtotalVnd !== null && !isInRange(rule.minimumSubtotalVnd, MAX_GIFT_THRESHOLD_SUBTOTAL_VND)) errors.add("GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE");
  if (rule.awardMode !== null && !(GIFT_AWARD_MODES as readonly string[]).includes(rule.awardMode)) errors.add("INVALID_GIFT_AWARD_MODE");
  if (rule.maxGiftsPerOrder !== null && !isInRange(rule.maxGiftsPerOrder, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP)) errors.add("GIFT_MAX_PER_ORDER_OUT_OF_RANGE");
  if (rule.allowDuplicateGifts !== null && typeof rule.allowDuplicateGifts !== "boolean") errors.add("INVALID_GIFT_DUPLICATE_FLAG");
  if (!Array.isArray(rule.variantIds) || rule.variantIds.length > MAX_GIFT_OPTIONS_PER_CAMPAIGN) {
    errors.add("GIFT_OPTIONS_TOO_MANY");
  } else {
    const seen = new Set<string>();
    for (const id of rule.variantIds) {
      if (typeof id !== "string" || id.trim() !== id || !isBoundedPromotionIdentifier(id)) errors.add("GIFT_OPTION_INVALID");
      if (seen.has(id)) errors.add("GIFT_OPTION_DUPLICATE");
      seen.add(id);
    }
  }
  return [...errors];
}

/**
 * Bounds plus applicability: a field the chosen trigger does not own is a contradiction, not
 * something to repair. With no trigger chosen yet the thresholds cannot be meaningful either.
 */
export function validateGiftRuleStructure(rule: GiftRuleInput, trigger: GiftTrigger | null): readonly GiftRuleStructureError[] {
  const errors = new Set<GiftRuleStructureError>(validateGiftRuleBounds(rule));
  const hasQuantity = rule.minimumQuantity !== null;
  const hasSubtotal = rule.minimumSubtotalVnd !== null || rule.awardMode !== null;
  if (trigger === null) {
    if (hasQuantity || hasSubtotal) errors.add("GIFT_TRIGGER_REQUIRED_FOR_THRESHOLD");
  } else if (trigger === "QUANTITY") {
    if (hasSubtotal) errors.add("GIFT_FIELD_NOT_APPLICABLE");
  } else if (hasQuantity) {
    errors.add("GIFT_FIELD_NOT_APPLICABLE");
  }
  return [...errors];
}

export type GiftRulePublishInput = Readonly<{
  trigger: GiftTrigger | null;
  subtotalScope: "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES" | null;
  rule: GiftRuleInput;
}>;

export type GiftRulePublishError =
  | "GIFT_TRIGGER_REQUIRED"
  | "GIFT_MINIMUM_QUANTITY_REQUIRED"
  | "GIFT_MINIMUM_SUBTOTAL_REQUIRED"
  | "GIFT_AWARD_MODE_REQUIRED"
  | "GIFT_SUBTOTAL_SCOPE_REQUIRED"
  | "GIFT_DUPLICATE_POLICY_REQUIRED"
  | "GIFT_OPTIONS_EMPTY"
  | GiftRuleStructureError;

/** Business validation. Empty means the rule may become effective (cross-row checks still apply). */
export function validateGiftRuleForPublish(input: GiftRulePublishInput): readonly GiftRulePublishError[] {
  const { rule, trigger } = input;
  const errors: GiftRulePublishError[] = [...validateGiftRuleStructure(rule, trigger)];
  if (trigger === null) {
    errors.push("GIFT_TRIGGER_REQUIRED");
  } else if (trigger === "QUANTITY") {
    if (rule.minimumQuantity === null) errors.push("GIFT_MINIMUM_QUANTITY_REQUIRED");
  } else {
    if (rule.minimumSubtotalVnd === null) errors.push("GIFT_MINIMUM_SUBTOTAL_REQUIRED");
    if (rule.awardMode === null) errors.push("GIFT_AWARD_MODE_REQUIRED");
    if (input.subtotalScope === null) errors.push("GIFT_SUBTOTAL_SCOPE_REQUIRED");
  }
  if (rule.allowDuplicateGifts === null) errors.push("GIFT_DUPLICATE_POLICY_REQUIRED");
  if (rule.variantIds.length === 0) errors.push("GIFT_OPTIONS_EMPTY");
  return errors;
}

/** The stored gift rule of a campaign row, in the shape the writers and validators use. */
export function giftRuleOfRow(row: Readonly<{
  minimumQuantity: number | null;
  minimumSubtotalVnd: bigint | null;
  awardMode: GiftAwardMode | null;
  maxGiftsPerOrder: number | null;
  allowDuplicateGifts: boolean | null;
  giftOptions: readonly Readonly<{ variantId: string }>[];
}>): GiftRuleInput {
  return {
    minimumQuantity: row.minimumQuantity,
    minimumSubtotalVnd: row.minimumSubtotalVnd === null ? null : Number(row.minimumSubtotalVnd),
    awardMode: row.awardMode,
    maxGiftsPerOrder: row.maxGiftsPerOrder,
    allowDuplicateGifts: row.allowDuplicateGifts,
    variantIds: row.giftOptions.map((option) => option.variantId),
  };
}

/** Whether two rules describe the same campaign. The allowlist is a set: its order is not an edit. */
export function sameGiftRule(a: GiftRuleInput, b: GiftRuleInput): boolean {
  const ids = (rule: GiftRuleInput) => [...rule.variantIds].sort().join("\u0000");
  return (
    a.minimumQuantity === b.minimumQuantity &&
    a.minimumSubtotalVnd === b.minimumSubtotalVnd &&
    a.awardMode === b.awardMode &&
    a.maxGiftsPerOrder === b.maxGiftsPerOrder &&
    a.allowDuplicateGifts === b.allowDuplicateGifts &&
    a.variantIds.length === b.variantIds.length &&
    ids(a) === ids(b)
  );
}

/** The persisted columns a gift rule describes (the allowlist is written separately). */
export function giftRuleColumns(rule: GiftRuleInput) {
  return {
    minimumQuantity: rule.minimumQuantity,
    minimumSubtotalVnd: rule.minimumSubtotalVnd === null ? null : BigInt(rule.minimumSubtotalVnd),
    awardMode: rule.awardMode,
    maxGiftsPerOrder: rule.maxGiftsPerOrder,
    allowDuplicateGifts: rule.allowDuplicateGifts,
  } as const;
}

export function giftOptionChildren(rule: GiftRuleInput) {
  return { giftOptions: { create: rule.variantIds.map((variantId) => ({ variantId })) } } as const;
}

/**
 * Existence of the allowlisted variants. Runs on every Draft write so a typo is reported as input,
 * not as a foreign-key failure; the publish check below repeats it because a Draft's option is only
 * a name until the campaign goes live.
 */
export async function unknownGiftVariantIds(
  client: Pick<Tx, "variantMirror">,
  variantIds: readonly string[],
): Promise<readonly string[]> {
  if (variantIds.length === 0) return [];
  const found = await client.variantMirror.findMany({ where: { id: { in: [...variantIds] } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  return variantIds.filter((id) => !known.has(id));
}

export type GiftOptionError =
  | "GIFT_VARIANT_UNKNOWN"
  | "GIFT_VARIANT_UNAVAILABLE"
  /** No longer produced: sets are allowed as gifts (ADR 0016 D-04). Kept so an older Admin redirect still reads. */
  | "GIFT_VARIANT_COMPOSITE"
  | "GIFT_NO_READY_STOCK";

/**
 * Cross-row publish checks for the allowlist (ADR 0016 D-04). Gifts use READY stock,
 * including component-backed FULL SET stock, so:
 * - every option exists, is present and active, and so is its product;
 * - composite components must be present, same-shop, and stocked;
 * - at least one option has READY stock now. Stock is not re-checked per option: it moves, and the
 *   cart decides what is selectable on every read; this only refuses a campaign nobody could ever
 *   receive a gift from.
 */
export async function giftOptionErrors(
  tx: Pick<Tx, "variantMirror">,
  variantIds: readonly string[],
): Promise<readonly GiftOptionError[]> {
  if (variantIds.length === 0) return [];
  const rows = await tx.variantMirror.findMany({
    where: { id: { in: [...variantIds] } },
    select: {
      id: true,
      isPresent: true,
      isActive: true,
      product: { select: { pancakeShopId: true, isPresent: true, isActive: true } },
      compositeComponents: { select: {
        quantity: true,
        componentVariant: { select: {
          id: true, isPresent: true,
          product: { select: { pancakeShopId: true, isPresent: true } },
          warehouseStocks: { select: { quantity: true } },
        } },
      } },
      warehouseStocks: { select: { quantity: true } },
    },
    take: MAX_GIFT_OPTIONS_PER_CAMPAIGN + 1,
  });
  const errors = new Set<GiftOptionError>();
  const byId = new Map(rows.map((row) => [row.id, row]));
  let anyReady = false;
  for (const id of variantIds) {
    const row = byId.get(id);
    if (row === undefined) {
      errors.add("GIFT_VARIANT_UNKNOWN");
      continue;
    }
    if (!row.isPresent || !row.isActive || !row.product.isPresent || !row.product.isActive) {
      errors.add("GIFT_VARIANT_UNAVAILABLE");
      continue;
    }
    if (readyGiftOptionStock(row) >= 1) anyReady = true;
  }
  if (errors.size === 0 && !anyReady) errors.add("GIFT_NO_READY_STOCK");
  return [...errors];
}

export type GiftCampaignAdmissionError = "GIFT_CAMPAIGN_LIMIT_EXCEEDED";

/** A campaign window; `null` means unbounded on that side. Half-open: it contains `startsAt` and not `endsAt`. */
export type GiftCampaignWindow = Readonly<{ startsAt: Date | null; endsAt: Date | null }>;

/**
 * Whether adding `candidate` would put more than `cap` windows in force at one instant.
 *
 * Pure. `others` are the windows already admitted; a window that never intersects the candidate's
 * cannot matter, so only instants inside the candidate's window are examined. The most crowded
 * instant of a set of intervals is always the start of one of them, hence the candidate's own start
 * plus every other start that falls inside the candidate window is enough. Intervals are half-open
 * (a campaign ending exactly when another starts does not overlap it).
 */
export function exceedsConcurrentWindows(
  candidate: GiftCampaignWindow,
  others: readonly GiftCampaignWindow[],
  cap: number,
): boolean {
  const start = (window: GiftCampaignWindow) => (window.startsAt === null ? Number.NEGATIVE_INFINITY : window.startsAt.getTime());
  const end = (window: GiftCampaignWindow) => (window.endsAt === null ? Number.POSITIVE_INFINITY : window.endsAt.getTime());
  const from = start(candidate);
  const until = end(candidate);
  if (!(until > from)) return false;
  const contains = (window: GiftCampaignWindow, instant: number) => start(window) <= instant && instant < end(window);
  const instants = new Set<number>([from]);
  for (const other of others) {
    const at = start(other);
    if (at > from && at < until) instants.add(at);
  }
  for (const instant of instants) {
    let inForce = 1;
    for (const other of others) if (contains(other, instant)) inForce += 1;
    if (inForce > cap) return true;
  }
  return false;
}

/** More enabled-and-not-ended windows than this are not worth scanning: refuse instead of guessing. */
const MAX_ADMISSION_SCAN = 1_000;

/**
 * Publish admission: the number of gift campaigns that can be in force at the same time must stay
 * within what the cart's entitlement engine accepts (`MAX_GIFT_CAMPAIGNS`). The cart loads every
 * active campaign regardless of scope and passes all gifts to the engine, which refuses more than
 * the cap outright -- so one campaign too many would make the gift lookup of *every* cart fail even
 * though each rule is valid. Counting ignores scope on purpose (a global gift reaches every cart).
 *
 * Counts enabled gift campaigns that have not ended, Scheduled ones included (they will be in force
 * when their window opens), and looks only at the instants inside the candidate's own window. It must
 * run inside the publish / re-enable / Scheduled-edit transaction under the pricing revision lock,
 * which serialises every effective mutation, so two concurrent admissions cannot both take the last slot.
 */
export async function giftCampaignAdmissionErrors(
  tx: Pick<Tx, "giftQuantityCampaign">,
  input: Readonly<{ campaignId: string; window: GiftCampaignWindow; now: Date }>,
): Promise<readonly GiftCampaignAdmissionError[]> {
  const rows = await tx.giftQuantityCampaign.findMany({
    where: {
      kind: "GIFT_ITEM",
      isEnabled: true,
      id: { not: input.campaignId },
      OR: [{ endsAt: null }, { endsAt: { gt: input.now } }],
    },
    select: { startsAt: true, endsAt: true },
    take: MAX_ADMISSION_SCAN + 1,
  });
  if (rows.length > MAX_ADMISSION_SCAN) return ["GIFT_CAMPAIGN_LIMIT_EXCEEDED"];
  return exceedsConcurrentWindows(input.window, rows, MAX_GIFT_CAMPAIGNS) ? ["GIFT_CAMPAIGN_LIMIT_EXCEEDED"] : [];
}

/** Read-back of the stored gift rule for the admin edit form (GQ13b); null for a missing or tier campaign. */
export async function readGiftRule(
  client: Pick<PrismaClient, "giftQuantityCampaign">,
  campaignId: string,
): Promise<GiftRuleInput | null> {
  if (!isBoundedPromotionIdentifier(campaignId)) return null;
  const row = await client.giftQuantityCampaign.findUnique({
    where: { id: campaignId },
    select: {
      kind: true,
      minimumQuantity: true,
      minimumSubtotalVnd: true,
      awardMode: true,
      maxGiftsPerOrder: true,
      allowDuplicateGifts: true,
      giftOptions: { select: { variantId: true }, orderBy: { variantId: "asc" } },
    },
  });
  return row === null || row.kind !== "GIFT_ITEM" ? null : giftRuleOfRow(row);
}
