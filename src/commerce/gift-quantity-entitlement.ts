import { buildScopeResolver, type ScopeConfig, type FrozenProductSet, type ScopeProductFacts } from "./gift-quantity-scope.ts";

/**
 * Gift & Quantity Promotions v1 (GQ10): gift entitlement and selection rules.
 *
 * Pure: no database, no I/O, no clock. It answers two questions and nothing else:
 *   1. How many gift slots does each campaign grant for this cart (`earned`, then `entitled`)?
 *   2. Is a proposed set of gift choices allowed, and what is left unclaimed?
 *
 * Inputs are the **final paid** price groups -- after every discount step (spec FR-04, FR-08) -- so
 * `Q` is the number of paid units and `S` is the sum of post-discount paid line totals in scope.
 * Gifts are never passed in: a gift can neither raise `Q`/`S` nor reach another campaign's
 * threshold (spec FR-05, FR-08). Every gift campaign is evaluated independently; physical stock is
 * the only thing shared between campaigns and is checked in `validateGiftSelections`.
 *
 * Decisions applied (ADR 0016): D-03 duplicate gifts are per `ProductMirror`; D-04 only READY,
 * variants with proven READY capacity are selectable (the caller supplies `readyAvailable`,
 * already net of paid demand and holds). Nothing here chooses a new rule: thresholds are `>=`
 * (FR-04), `earned = floor(Q / N)` (FR-03), ONCE / REPEAT_PER_THRESHOLD (FR-04), then the
 * `maxGiftsPerOrder` / technical cap.
 *
 * The campaign fact type is deliberately a small explicit shape, not a Prisma row, so the cart
 * wiring (GQ08) and the admin allow-list (GQ13) feed it by mapping, never by coupling. Gift
 * allow-lists are simply `options`; adding fields later does not change the evaluation.
 */

export const MAX_GIFTS_PER_ORDER_TECHNICAL_CAP = 100;
export const MAX_GIFT_CAMPAIGNS = 20;
export const MAX_GIFT_OPTIONS_PER_CAMPAIGN = 500;
export const MAX_GIFT_SELECTION_LINES = 100;
export const MAX_PAID_GROUPS = 1_000;

export type GiftTrigger = "QUANTITY" | "ORDER_SUBTOTAL";
export type GiftSubtotalScope = "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES";
export type GiftAwardMode = "ONCE" | "REPEAT_PER_THRESHOLD";

export type GiftOptionFacts = Readonly<{
  variantId: string;
  /** The gift's owning product; duplicate policy is per product (D-03). */
  productId: string;
  /** Set variants are eligible when component-backed READY stock is proven. */
  composite: boolean;
  /** READY units that can really be given right now, net of paid demand and existing holds. */
  readyAvailable: number;
  /** Physical resources consumed per gift unit. Legacy pure-domain fixtures may omit this field. */
  resourceNeeds?: readonly Readonly<{ variantId: string; unitsPerGift: number; availableUnits: number }>[];
}>;

export type GiftCampaignFacts = Readonly<{
  id: string;
  /** Campaign revision at the time of evaluation; carried into the entitlement for staleness checks. */
  revision: number;
  trigger: GiftTrigger;
  /** QUANTITY trigger: `N`. */
  minimumQuantity: number | null;
  /** ORDER_SUBTOTAL trigger: `T` in whole VND (the database column is a BigInt). */
  minimumSubtotalVnd: number | bigint | null;
  subtotalScope: GiftSubtotalScope | null;
  awardMode: GiftAwardMode | null;
  maxGiftsPerOrder: number | null;
  allowDuplicateGifts: boolean;
  scope: ScopeConfig;
  frozen: FrozenProductSet | null;
  options: readonly GiftOptionFacts[];
}>;

export type PaidGroup = Readonly<{
  groupKey: string;
  product: ScopeProductFacts;
  quantity: number;
  /** Per-unit price after every discount step, whole VND >= 1. */
  unitPriceVnd: number;
}>;

export type GiftEntitlement = Readonly<{
  campaignId: string;
  /** Campaign revision this entitlement was computed from. */
  revision: number;
  /** `Q`: eligible paid units. */
  eligibleQuantity: number;
  /** `S`: eligible paid lines, post-discount, whole VND. */
  eligibleSubtotalVnd: number;
  /** Slots before any cap. */
  earned: number;
  /** Slots after `maxGiftsPerOrder` and the technical cap. */
  entitled: number;
  cappedByMaximum: boolean;
  /** Options that can be chosen right now (READY stock >= 1), ordered by variant id. */
  selectableOptions: readonly GiftOptionFacts[];
  /** Slots backed by a feasible joint allocation of variant and component stock. */
  grantable: number;
  /** Entitled slots that cannot be given for lack of stock or distinct products. */
  unfulfillableForStock: number;
  /** How much more `Q` / `S` reaches the next slot; null when there is no next slot below the cap. */
  shortfallToNext: Readonly<{ quantity: number | null; subtotalVnd: number | null }> | null;
}>;

export type GiftEvaluationError = "INVALID_INPUT";

export type GiftEvaluation =
  | Readonly<{ ok: true; entitlements: readonly GiftEntitlement[] }>
  | Readonly<{ ok: false; error: GiftEvaluationError; detail: string }>;

const ZERO = BigInt(0);
const ONE = BigInt(1);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isSafePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validPaidGroup(group: PaidGroup): boolean {
  return (
    group !== null && typeof group === "object" &&
    typeof group.groupKey === "string" && group.groupKey.length > 0 &&
    group.product !== null && typeof group.product === "object" &&
    typeof group.product.productId === "string" && Array.isArray(group.product.categoryKeys) &&
    isSafePositive(group.quantity) && isSafePositive(group.unitPriceVnd)
  );
}

function selectableOptionsOf(campaign: GiftCampaignFacts): GiftOptionFacts[] {
  return campaign.options
    .filter((option) => option.readyAvailable >= 1)
    .sort((a, b) => compareText(a.variantId, b.variantId));
}

type GiftResourceNeed = Readonly<{ variantId: string; unitsPerGift: number; availableUnits: number }>;

function resourcesOf(option: GiftOptionFacts): readonly GiftResourceNeed[] {
  return option.resourceNeeds ?? [{ variantId: option.variantId, unitsPerGift: 1, availableUnits: option.readyAvailable }];
}

function resourceStockOf(options: readonly GiftOptionFacts[]): Map<string, number> {
  const stock = new Map<string, number>();
  for (const option of options) for (const resource of resourcesOf(option)) {
    stock.set(resource.variantId, Math.min(stock.get(resource.variantId) ?? Number.MAX_SAFE_INTEGER, resource.availableUnits));
  }
  return stock;
}

function variantStockOf(options: readonly GiftOptionFacts[]): Map<string, number> {
  const stock = new Map<string, number>();
  for (const option of options) {
    stock.set(option.variantId, Math.min(stock.get(option.variantId) ?? Number.MAX_SAFE_INTEGER, option.readyAvailable));
  }
  return stock;
}

const MAX_CAPACITY_ALLOCATION_STATES = 20_000;

/**
 * Find the maximum jointly fulfillable number of gift units, including alternative variants of
 * one product. Greedy allocation is unsound: choosing P/A first can block the valid P/B + Q/A.
 *
 * Each group is one product when duplicates are disallowed, or one variant otherwise. Memoize
 * remaining shared component stock. The state cap protects interactive cart transactions: null
 * means "undetermined", never falsely report a definite stock shortage.
 */
function feasibleGiftCapacity(
  options: readonly GiftOptionFacts[],
  limit: number,
  allowDuplicateGifts: boolean,
  variantStock: ReadonlyMap<string, number>,
  resourceStock: ReadonlyMap<string, number>,
): number | null {
  if (limit < 1 || options.length === 0) return 0;
  const byGroup = new Map<string, GiftOptionFacts[]>();
  for (const option of options) {
    if ((variantStock.get(option.variantId) ?? 0) < 1) continue;
    if (resourcesOf(option).some((need) => (resourceStock.get(need.variantId) ?? 0) < need.unitsPerGift)) continue;
    const key = allowDuplicateGifts ? option.variantId : option.productId;
    const group = byGroup.get(key) ?? [];
    group.push(option);
    byGroup.set(key, group);
  }
  const groups = [...byGroup.values()];

  // Resource IDs only used by one group never influence later groups and need no memo state.
  const resourceUses = new Map<string, number>();
  for (const group of groups) {
    const used = new Set(group.flatMap((option) => resourcesOf(option).map((need) => need.variantId)));
    for (const id of used) resourceUses.set(id, (resourceUses.get(id) ?? 0) + 1);
  }
  const sharedIds = [...resourceUses].filter(([, count]) => count > 1).map(([id]) => id).sort(compareText);
  const remaining = new Map(resourceStock);
  const memo = new Map<string, number>();
  let explored = 0;

  const solve = (index: number, needed: number): number | null => {
    if (needed === 0 || index === groups.length) return 0;
    const key = `${index}:${needed}:${sharedIds.map((id) => remaining.get(id) ?? 0).join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (++explored > MAX_CAPACITY_ALLOCATION_STATES) return null;

    let best = 0;
    for (const option of groups[index]!) {
      const needs = resourcesOf(option);
      const maxQuantity = Math.min(
        needed,
        allowDuplicateGifts ? (variantStock.get(option.variantId) ?? 0) : 1,
        ...needs.map((need) => Math.floor((remaining.get(need.variantId) ?? 0) / need.unitsPerGift)),
      );
      for (let quantity = maxQuantity; quantity >= 1; quantity--) {
        for (const need of needs) remaining.set(need.variantId, remaining.get(need.variantId)! - quantity * need.unitsPerGift);
        const rest = solve(index + 1, needed - quantity);
        for (const need of needs) remaining.set(need.variantId, remaining.get(need.variantId)! + quantity * need.unitsPerGift);
        if (rest === null) return null;
        best = Math.max(best, quantity + rest);
        if (best === needed) break;
      }
      if (best === needed) break;
    }
    if (best < needed) {
      const skipped = solve(index + 1, needed);
      if (skipped === null) return null;
      best = Math.max(best, skipped);
    }
    memo.set(key, best);
    return best;
  };
  return solve(0, limit);
}

function giftCapacity(campaign: GiftCampaignFacts, selectable: readonly GiftOptionFacts[], entitled: number): number | null {
  return feasibleGiftCapacity(
    selectable, entitled, campaign.allowDuplicateGifts,
    variantStockOf(campaign.options), resourceStockOf(campaign.options),
  );
}

/** Returns the `T` of a subtotal campaign as a BigInt, or null when it is not a positive safe integer. */
function thresholdOf(value: number | bigint | null): bigint | null {
  if (typeof value === "number") return isSafePositive(value) ? BigInt(value) : null;
  if (typeof value === "bigint") return value >= ONE && value <= BigInt(Number.MAX_SAFE_INTEGER) ? value : null;
  return null;
}

function campaignProblem(campaign: GiftCampaignFacts): string | null {
  if (campaign === null || typeof campaign !== "object") return "campaign";
  if (typeof campaign.id !== "string" || campaign.id.length === 0) return "campaign id";
  if (!isSafePositive(campaign.revision)) return "revision";
  if (typeof campaign.allowDuplicateGifts !== "boolean") return "allowDuplicateGifts";
  if (!Array.isArray(campaign.options) || campaign.options.length > MAX_GIFT_OPTIONS_PER_CAMPAIGN) return "options";
  if (campaign.maxGiftsPerOrder !== null && !isSafePositive(campaign.maxGiftsPerOrder)) return "maxGiftsPerOrder";
  const scopeMode = campaign.scope?.mode;
  if (scopeMode !== "GLOBAL_ALL_PAID_LINES" && scopeMode !== "DYNAMIC_CATEGORY" && scopeMode !== "FIXED_PRODUCT_SET") return "scope";
  if (campaign.trigger === "QUANTITY") {
    if (!isSafePositive(campaign.minimumQuantity)) return "minimumQuantity";
    if (scopeMode === "GLOBAL_ALL_PAID_LINES") return "quantity trigger needs a real scope";
  } else if (campaign.trigger === "ORDER_SUBTOTAL") {
    if (thresholdOf(campaign.minimumSubtotalVnd) === null) return "minimumSubtotalVnd";
    if (campaign.awardMode !== "ONCE" && campaign.awardMode !== "REPEAT_PER_THRESHOLD") return "awardMode";
    if (campaign.subtotalScope !== "ALL_PAID_LINES" && campaign.subtotalScope !== "ELIGIBLE_PAID_LINES") return "subtotalScope";
    if (campaign.subtotalScope === "ALL_PAID_LINES" && scopeMode !== "GLOBAL_ALL_PAID_LINES") return "ALL_PAID_LINES needs the global scope";
    if (campaign.subtotalScope === "ELIGIBLE_PAID_LINES" && scopeMode === "GLOBAL_ALL_PAID_LINES") return "ELIGIBLE_PAID_LINES needs a real scope";
  } else {
    return "trigger";
  }
  const variantIds = new Set<string>();
  for (const option of campaign.options) {
    if (option === null || typeof option !== "object") return "option";
    if (typeof option.variantId !== "string" || option.variantId.length === 0 || variantIds.has(option.variantId)) return "option variant";
    if (typeof option.productId !== "string" || option.productId.length === 0) return "option product";
    if (typeof option.composite !== "boolean") return "option composite";
    if (typeof option.readyAvailable !== "number" || !Number.isSafeInteger(option.readyAvailable) || option.readyAvailable < 0) return "option stock";
    if (option.resourceNeeds !== undefined) {
      if (!Array.isArray(option.resourceNeeds) || option.resourceNeeds.length === 0 || option.resourceNeeds.length > MAX_GIFT_OPTIONS_PER_CAMPAIGN) return "option resources";
      const resources = new Set<string>();
      for (const resource of option.resourceNeeds) {
        if (!resource || typeof resource.variantId !== "string" || !resource.variantId || resources.has(resource.variantId)
          || !isSafePositive(resource.unitsPerGift) || !Number.isSafeInteger(resource.availableUnits) || resource.availableUnits < 0) {
          return "option resource";
        }
        resources.add(resource.variantId);
      }
    }
    variantIds.add(option.variantId);
  }
  return null;
}

/**
 * Computes the entitlement of every gift campaign against the final paid groups.
 * The result is ordered by campaign id and does not depend on the order of either input list.
 */
export function evaluateGiftEntitlements(input: Readonly<{
  campaigns: readonly GiftCampaignFacts[];
  paidGroups: readonly PaidGroup[];
}>): GiftEvaluation {
  const { campaigns, paidGroups } = input;
  if (!Array.isArray(campaigns) || campaigns.length > MAX_GIFT_CAMPAIGNS) return { ok: false, error: "INVALID_INPUT", detail: "campaigns" };
  if (!Array.isArray(paidGroups) || paidGroups.length > MAX_PAID_GROUPS) return { ok: false, error: "INVALID_INPUT", detail: "paid groups" };
  const groupKeys = new Set<string>();
  for (const group of paidGroups) {
    if (!validPaidGroup(group) || groupKeys.has(group.groupKey)) return { ok: false, error: "INVALID_INPUT", detail: "paid group" };
    groupKeys.add(group.groupKey);
  }
  const ids = new Set<string>();
  for (const campaign of campaigns) {
    const problem = campaignProblem(campaign);
    if (problem !== null || ids.has(campaign.id)) return { ok: false, error: "INVALID_INPUT", detail: problem ?? "duplicate campaign" };
    ids.add(campaign.id);
  }

  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const entitlements: GiftEntitlement[] = [];
  for (const campaign of [...campaigns].sort((a, b) => compareText(a.id, b.id))) {
    const resolver = buildScopeResolver(campaign.scope, campaign.frozen);
    let quantity = ZERO;
    let subtotal = ZERO;
    for (const group of paidGroups) {
      if (!resolver(group.product)) continue;
      quantity += BigInt(group.quantity);
      subtotal += BigInt(group.quantity) * BigInt(group.unitPriceVnd);
    }
    if (quantity > maxSafe || subtotal > maxSafe) return { ok: false, error: "INVALID_INPUT", detail: "overflow" };

    const cap = Math.min(campaign.maxGiftsPerOrder ?? MAX_GIFTS_PER_ORDER_TECHNICAL_CAP, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP);
    let earned: bigint;
    let shortfall: GiftEntitlement["shortfallToNext"];
    if (campaign.trigger === "QUANTITY") {
      const n = BigInt(campaign.minimumQuantity!);
      earned = quantity / n;
      shortfall = { quantity: Number(n - (quantity % n)), subtotalVnd: null };
    } else {
      const t = thresholdOf(campaign.minimumSubtotalVnd)!;
      // Boundary is >=: S == T qualifies (spec FR-04), unlike the legacy free-shipping rule.
      earned = campaign.awardMode === "ONCE" ? (subtotal >= t ? ONE : ZERO) : subtotal / t;
      shortfall =
        campaign.awardMode === "ONCE" && earned >= ONE
          ? null
          : { quantity: null, subtotalVnd: Number(t - (subtotal % t)) };
    }

    const earnedSlots = Number(earned);
    const entitled = Math.min(earnedSlots, cap);
    const selectable = selectableOptionsOf(campaign);
    const grantable = giftCapacity(campaign, selectable, entitled);
    if (grantable === null) return { ok: false, error: "INVALID_INPUT", detail: "gift capacity could not be proven within search budget" };
    entitlements.push({
      campaignId: campaign.id,
      revision: campaign.revision,
      eligibleQuantity: Number(quantity),
      eligibleSubtotalVnd: Number(subtotal),
      earned: earnedSlots,
      entitled,
      cappedByMaximum: earnedSlots > entitled,
      selectableOptions: selectable,
      grantable,
      unfulfillableForStock: entitled - grantable,
      // No "next slot" to advertise once the cap is reached.
      shortfallToNext: entitled >= cap ? null : shortfall,
    });
  }
  return { ok: true, entitlements };
}

export type GiftSelectionLine = Readonly<{
  campaignId: string;
  variantId: string;
  quantity: number;
  /**
   * REQUIRED. The campaign revision this choice was made (or stored) under. It must equal the
   * entitlement's revision, so a persisted or replayed choice cannot silently survive an edit of
   * the campaign. A missing / non-integer value is refused, never defaulted. GQ12 maps the stored
   * `CartGiftSelection.campaignRevision` straight through; a fresh choice sends the revision of
   * the entitlement it was shown.
   */
  campaignRevision: number;
}>;

export type GiftSelectionError =
  | "SELECTION_INVALID"
  | "SELECTION_REVISION_INVALID"
  | "CAMPAIGN_NOT_ENTITLED"
  | "STALE_CAMPAIGN_REVISION"
  | "VARIANT_NOT_ALLOWED"
  | "OVER_ENTITLEMENT"
  | "DUPLICATE_PRODUCT_NOT_ALLOWED"
  | "OUT_OF_STOCK";

/**
 * A refusal. `campaignId` / `variantId` are set only when they name something the server knows
 * (an entitlement, an allowed option); a malformed or forged line is reported by `lineIndex` only,
 * so client text is never echoed back.
 */
export type GiftSelectionIssue = Readonly<{
  error: GiftSelectionError;
  lineIndex: number | null;
  campaignId: string | null;
  variantId: string | null;
}>;

export type CampaignSelectionSummary = Readonly<{
  campaignId: string;
  revision: number;
  entitled: number;
  selected: number;
  /** `entitled - selected`: slots the buyer is not taking, whatever the reason. */
  unclaimed: number;
  /**
   * Unclaimed slots the buyer skipped although stock was **guaranteed** for them: still claimable
   * after the chosen gifts, and even if every other campaign took all it could from the same stock.
   */
  skippedWhileAvailable: number;
  /**
   * Unclaimed slots that cannot be given even if no other campaign claimed anything more: no
   * stock left after the chosen gifts (of this or any campaign), or no distinct product left (R-03).
   */
  shortForStock: number;
  /**
   * Unclaimed slots that exist in the remaining stock only if other campaigns do not take it
   * first. Not attributable to a skip or to a shortage, so neither is asserted.
   * `unclaimed = skippedWhileAvailable + contendedForSharedStock + shortForStock`.
   */
  contendedForSharedStock: number;
  /** Selecting fewer than entitled always needs an explicit buyer confirmation (FR-06). */
  requiresAcknowledgement: boolean;
}>;

export type GiftSelectionValidation =
  | Readonly<{ ok: true; summaries: readonly CampaignSelectionSummary[] }>
  | Readonly<{ ok: false; issues: readonly GiftSelectionIssue[] }>;

function compareIssues(a: GiftSelectionIssue, b: GiftSelectionIssue): number {
  return (
    compareText(a.error, b.error) ||
    compareText(a.campaignId ?? "", b.campaignId ?? "") ||
    compareText(a.variantId ?? "", b.variantId ?? "") ||
    (a.lineIndex ?? -1) - (b.lineIndex ?? -1)
  );
}

/**
 * Validates a proposed selection (0..entitled slots, FR-06) against the entitlements and the options
 * of each campaign. Selecting nothing is valid and yields `requiresAcknowledgement` summaries.
 *
 * Physical stock is shared: the same variant picked under two campaigns draws from one pool. The
 * campaign options already carry `readyAvailable` net of paid demand, so the pool check sums the
 * units asked for per variant across campaigns against the smallest `readyAvailable` any campaign
 * reports for it. The skipped / short / contended split of the unclaimed slots is computed on the
 * stock **left after the chosen gifts** and never depends on campaign or selection order.
 */
export function validateGiftSelections(input: Readonly<{
  entitlements: readonly GiftEntitlement[];
  campaigns: readonly GiftCampaignFacts[];
  selection: readonly GiftSelectionLine[];
}>): GiftSelectionValidation {
  const { entitlements, campaigns, selection } = input;
  if (!Array.isArray(selection) || selection.length > MAX_GIFT_SELECTION_LINES) {
    return { ok: false, issues: [{ error: "SELECTION_INVALID", lineIndex: null, campaignId: null, variantId: null }] };
  }

  const issues: GiftSelectionIssue[] = [];
  const entitlementById = new Map(entitlements.map((entry) => [entry.campaignId, entry]));
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const selectedByCampaign = new Map<string, number>();
  const unitsByCampaignProduct = new Map<string, Map<string, number>>();
  const unitsByVariant = new Map<string, number>();
  const stockByVariant = new Map<string, number>();
  const seenLines = new Map<string, Set<string>>();

  // An entitlement computed from another revision (or for a campaign that is gone) is stale as a
  // whole, with or without selection lines: the acknowledgement would describe the wrong rule.
  for (const entry of entitlements) {
    if (campaignById.get(entry.campaignId)?.revision !== entry.revision) {
      issues.push({ error: "STALE_CAMPAIGN_REVISION", lineIndex: null, campaignId: entry.campaignId, variantId: null });
    }
  }

  selection.forEach((line, lineIndex) => {
    if (
      line === null || typeof line !== "object" ||
      typeof line.campaignId !== "string" || typeof line.variantId !== "string" ||
      !isSafePositive(line.quantity) || line.quantity > MAX_GIFTS_PER_ORDER_TECHNICAL_CAP
    ) {
      issues.push({ error: "SELECTION_INVALID", lineIndex, campaignId: null, variantId: null });
      return;
    }
    // Fail closed: a choice without a revision cannot prove it is not a replay of an older one.
    if (!isSafePositive(line.campaignRevision)) {
      issues.push({ error: "SELECTION_REVISION_INVALID", lineIndex, campaignId: null, variantId: null });
      return;
    }
    let variantsSeen = seenLines.get(line.campaignId);
    if (variantsSeen === undefined) seenLines.set(line.campaignId, (variantsSeen = new Set()));
    if (variantsSeen.has(line.variantId)) {
      issues.push({ error: "SELECTION_INVALID", lineIndex, campaignId: null, variantId: null });
      return;
    }
    variantsSeen.add(line.variantId);

    const entitlement = entitlementById.get(line.campaignId);
    const campaign = campaignById.get(line.campaignId);
    if (entitlement === undefined || campaign === undefined || entitlement.entitled < 1) {
      issues.push({ error: "CAMPAIGN_NOT_ENTITLED", lineIndex, campaignId: null, variantId: null });
      return;
    }
    if (entitlement.revision !== campaign.revision || line.campaignRevision !== entitlement.revision) {
      issues.push({ error: "STALE_CAMPAIGN_REVISION", lineIndex, campaignId: entitlement.campaignId, variantId: null });
      return;
    }
    // Only a currently selectable option may be chosen: READY, stock >= 1 (R-04).
    const option = campaign.options.find((candidate) => candidate.variantId === line.variantId);
    if (option === undefined) {
      issues.push({ error: "VARIANT_NOT_ALLOWED", lineIndex, campaignId: entitlement.campaignId, variantId: null });
      return;
    }
    if (option.readyAvailable < 1) {
      issues.push({ error: "OUT_OF_STOCK", lineIndex, campaignId: entitlement.campaignId, variantId: option.variantId });
      return;
    }

    selectedByCampaign.set(line.campaignId, (selectedByCampaign.get(line.campaignId) ?? 0) + line.quantity);
    let products = unitsByCampaignProduct.get(line.campaignId);
    if (products === undefined) unitsByCampaignProduct.set(line.campaignId, (products = new Map()));
    products.set(option.productId, (products.get(option.productId) ?? 0) + line.quantity);
    unitsByVariant.set(option.variantId, (unitsByVariant.get(option.variantId) ?? 0) + line.quantity);
    stockByVariant.set(option.variantId, Math.min(stockByVariant.get(option.variantId) ?? Number.MAX_SAFE_INTEGER, option.readyAvailable));
  });

  for (const [campaignId, selected] of selectedByCampaign) {
    if (selected > entitlementById.get(campaignId)!.entitled) {
      issues.push({ error: "OVER_ENTITLEMENT", lineIndex: null, campaignId, variantId: null });
    }
  }
  for (const [campaignId, products] of unitsByCampaignProduct) {
    if (campaignById.get(campaignId)!.allowDuplicateGifts) continue;
    // R-03: one unit per owning product, regardless of variant.
    if ([...products.values()].some((units) => units > 1)) {
      issues.push({ error: "DUPLICATE_PRODUCT_NOT_ALLOWED", lineIndex: null, campaignId, variantId: null });
    }
  }
  for (const [variantId, units] of unitsByVariant) {
    if (units > stockByVariant.get(variantId)!) {
      issues.push({ error: "OUT_OF_STOCK", lineIndex: null, campaignId: null, variantId });
    }
  }
  const availableByResource = resourceStockOf(campaigns.flatMap((campaign) => campaign.options));
  const usedByResource = new Map<string, number>();
  if (issues.length === 0) {
    // Two distinct set parents (or a standalone child gift) can consume the same physical SKU.
    for (const choice of selection) {
      const option = campaignById.get(choice.campaignId)!.options.find((candidate) => candidate.variantId === choice.variantId)!;
      for (const resource of resourcesOf(option)) {
        usedByResource.set(resource.variantId,
          (usedByResource.get(resource.variantId) ?? 0) + choice.quantity * resource.unitsPerGift);
      }
    }
    for (const [resourceId, used] of usedByResource) {
      if (!Number.isSafeInteger(used) || used > (availableByResource.get(resourceId) ?? 0)) {
        issues.push({ error: "OUT_OF_STOCK", lineIndex: null, campaignId: null, variantId: null });
        break;
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues: issues.sort(compareIssues) };

  // Stock left once every chosen gift is taken, per variant: the smallest `readyAvailable` any
  // campaign reports for it, minus all chosen units (campaigns draw from one physical pool).
  const poolByVariant = new Map<string, number>();
  for (const campaign of campaigns) {
    for (const option of campaign.options) {
      poolByVariant.set(option.variantId, Math.min(poolByVariant.get(option.variantId) ?? Number.MAX_SAFE_INTEGER, option.readyAvailable));
    }
  }
  const remainingByVariant = new Map<string, number>();
  for (const [variantId, pool] of poolByVariant) {
    remainingByVariant.set(variantId, Math.max(0, pool - (unitsByVariant.get(variantId) ?? 0)));
  }
  const remainingByResource = new Map<string, number>();
  for (const [variantId, pool] of availableByResource) {
    remainingByResource.set(variantId, Math.max(0, pool - (usedByResource.get(variantId) ?? 0)));
  }

  type Open = Readonly<{
    entry: GiftEntitlement;
    campaign: GiftCampaignFacts | undefined;
    selected: number;
    unclaimed: number;
    /** Options this campaign could still take from, with the product units already chosen excluded (R-03). */
    usable: readonly GiftOptionFacts[];
  }>;
  const sortedEntitlements = [...entitlements].sort((a, b) => compareText(a.campaignId, b.campaignId));
  const open: Open[] = sortedEntitlements
    .filter((entry) => entry.entitled > 0)
    .map((entry) => {
      const campaign = campaignById.get(entry.campaignId);
      const selected = selectedByCampaign.get(entry.campaignId) ?? 0;
      const chosenProducts = unitsByCampaignProduct.get(entry.campaignId);
      const usable = (campaign?.options ?? []).filter(
        (option) =>
          (remainingByVariant.get(option.variantId) ?? 0) >= 1 &&
          resourcesOf(option).every((resource) => (remainingByResource.get(resource.variantId) ?? 0) >= resource.unitsPerGift) &&
          (campaign!.allowDuplicateGifts || !chosenProducts?.has(option.productId)),
      );
      return { entry, campaign, selected, unclaimed: entry.entitled - selected, usable };
    });

  /** Feasible additional gifts after selections, using both per-variant and physical resource stock. */
  const capacityFrom = (item: Open, variants: ReadonlyMap<string, number>, resources: ReadonlyMap<string, number>): number =>
    item.unclaimed <= 0 || item.campaign === undefined
      ? 0
      : feasibleGiftCapacity(item.usable, item.unclaimed, item.campaign.allowDuplicateGifts, variants, resources);

  /** Conservative upper bound on one option's consumption by another campaign. */
  const maxUseOf = (item: Open, option: GiftOptionFacts): number =>
    Math.min(
      item.unclaimed,
      item.campaign!.allowDuplicateGifts ? (remainingByVariant.get(option.variantId) ?? 0) : 1,
      ...resourcesOf(option).map((resource) =>
        Math.floor((remainingByResource.get(resource.variantId) ?? 0) / resource.unitsPerGift)),
    );

  const summaries = open.map((item): CampaignSelectionSummary | null => {
    // Attribute unclaimed slots from the physical capacity left after all chosen gifts.
    // `alone` is feasible without more choices by other campaigns. For `guaranteed`, reserve
    // their maximum potential resource demand first, so shared stock is never called a skip.
    const alone = capacityFrom(item, remainingByVariant, remainingByResource);
    if (alone === null) return null;
    let guaranteed = 0;
    if (item.campaign !== undefined && alone > 0) {
      const takenVariants = new Map<string, number>();
      const takenResources = new Map<string, number>();
      for (const other of open) {
        if (other === item || other.campaign === undefined) continue;
        for (const option of other.usable) {
          const units = maxUseOf(other, option);
          takenVariants.set(option.variantId, (takenVariants.get(option.variantId) ?? 0) + units);
          for (const resource of resourcesOf(option)) {
            takenResources.set(resource.variantId, (takenResources.get(resource.variantId) ?? 0) + units * resource.unitsPerGift);
          }
        }
      }
      const reducedVariants = new Map([...remainingByVariant].map(([id, stock]) =>
        [id, Math.max(0, stock - (takenVariants.get(id) ?? 0))]));
      const reducedResources = new Map([...remainingByResource].map(([id, stock]) =>
        [id, Math.max(0, stock - (takenResources.get(id) ?? 0))]));
      const available = capacityFrom(item, reducedVariants, reducedResources);
      if (available === null) return null;
      guaranteed = Math.min(alone, available);
    }
    return {
      campaignId: item.entry.campaignId,
      revision: item.entry.revision,
      entitled: item.entry.entitled,
      selected: item.selected,
      unclaimed: item.unclaimed,
      skippedWhileAvailable: guaranteed,
      shortForStock: item.unclaimed - alone,
      contendedForSharedStock: alone - guaranteed,
      requiresAcknowledgement: item.unclaimed > 0,
    };
  });
  if (summaries.some((summary) => summary === null)) {
    return { ok: false, issues: [{ error: "SELECTION_INVALID", lineIndex: null, campaignId: null, variantId: null }] };
  }
  return { ok: true, summaries: summaries.filter((summary): summary is CampaignSelectionSummary => summary !== null) };
}
