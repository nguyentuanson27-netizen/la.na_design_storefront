/**
 * The transactional boundary for effective gift / quantity-tier campaign mutations (GQ04).
 *
 * Same contract as `promotion-activation-service.ts` and deliberately the same locks: every
 * effective mutation takes `FOR UPDATE` on the single `PromotionPricingRevision` row first, then
 * the campaign row, and advances the durable revision in the same transaction. Sharing the one
 * revision keeps a single global order across legacy and new campaigns, so a Merchant cache
 * decision orders itself against both.
 *
 * What this adds on top of the legacy rules:
 * - **Gate.** Publish, re-enable and Scheduled edit are refused with `FEATURE_DISABLED` unless
 *   `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` is exactly `"true"`. A refused call reads nothing and
 *   advances nothing. Disable and end-early are never gated: they are the rollback path.
 * - **Fixed scope freeze.** For `FIXED_PRODUCT_SET` the product ids are computed from one
 *   single-statement membership read (one snapshot) and written, with `frozenAt` and the new
 *   campaign revision, in the same transaction as the publish / re-enable / scope edit. Nothing is
 *   written at `startsAt`: Scheduled -> Active is derived from `now`.
 * - **Rule validation seam.** Rule economics are validated by an injected `RuleValidator`. The
 *   production default validates quantity-tier rules (GQ09a) and still refuses gift rules until
 *   GQ13a. Checks that need other rows (unique stack priority, EX-21 catalog prices) run in the same
 *   transaction under the revision lock. A refused publish / edit rolls back: no revision moves.
 * - **Tier rule edits.** A Scheduled edit may replace the whole tier rule (ladder, FROM/ALL,
 *   stacking, peers). The rule is validated as it will be after the edit, and only a *real* change
 *   against the stored rule is gated, validated and revisioned.
 */

import type { GiftQuantityCampaignKind, GiftSubtotalScope, GiftTrigger, PrismaClient } from "../generated/prisma/client.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import { prisma } from "../db/prisma.ts";

import {
  giftQuantityCampaignSelection,
  type GiftQuantityCampaignRecord,
} from "./gift-quantity-candidate-repository.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { checkTierPriceSafety } from "./gift-quantity-publish-guards.ts";
import { invalidStackPeers } from "./gift-quantity-stack-peers.ts";
import { hasStackPriorityConflict } from "./gift-quantity-stack-priority.ts";
import { validateRuleForPublish, type RuleValidationInput, type RuleValidator } from "./gift-quantity-rule-validation.ts";
import {
  applyExcludeWins,
  computeFrozenProductIds,
  expandScopeCategoryKeys,
  FIXED_PRODUCT_SET,
  MAX_FROZEN_PRODUCTS,
  validateScopeConfig,
  type ScopeConfig,
  type ScopeIssue,
  type ScopeProductFacts,
} from "./gift-quantity-scope.ts";
import { toQuantityTierConfig, validateTierRuleStructure, type TierRuleInput } from "./gift-quantity-tier-rule.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import { deriveCampaignLifecycle, type CampaignLifecycleStatus } from "./promotion-campaign-lifecycle.ts";
import { normalizePromotionCampaignName } from "./promotion-campaign-name.ts";
import { advanceRevision, lockRevision, lockRows, type Tx } from "./promotion-activation-service.ts";

export type GiftQuantityActivationFailure =
  | { reason: "FEATURE_DISABLED" }
  | { reason: "CAMPAIGN_NOT_FOUND" }
  | { reason: "ILLEGAL_TRANSITION"; from: CampaignLifecycleStatus }
  | { reason: "INVALID_INPUT"; errors: readonly string[] }
  | { reason: "INVALID_SCOPE"; issues: readonly ScopeIssue[] }
  | { reason: "INVALID_RULE"; errors: readonly string[] }
  | { reason: "FROZEN_SET_INVALID"; code: string };

export type GiftQuantityActivationOutcome =
  | Readonly<{
      ok: true;
      campaignId: string;
      /** The durable pricing revision after the mutation. */
      revision: bigint;
      /** The campaign's own revision after the mutation. */
      campaignRevision: number;
      /** Fixed scopes: how many products the snapshot froze; null otherwise. */
      frozenProductCount: number | null;
    }>
  | Readonly<{ ok: false; failure: GiftQuantityActivationFailure }>;

export type AdminSessionCandidate =
  | { user: { id: string; role?: string | null }; session: { id: string } }
  | null
  | undefined;

export type GiftQuantityActivationInput = Readonly<{
  campaignId: string;
  now: Date;
  session: AdminSessionCandidate;
  client?: PrismaClient;
  env?: Readonly<Record<string, string | undefined>>;
  validateRule?: RuleValidator;
}>;

type CampaignRow = GiftQuantityCampaignRecord;

function authorize(session: AdminSessionCandidate): void {
  requireAdminSession(session);
}

function refuseUnboundedId(campaignId: string): GiftQuantityActivationFailure | null {
  return isBoundedPromotionIdentifier(campaignId) ? null : { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] };
}

/** The scope the campaign row currently describes, as the pure scope module sees it. */
function scopeFromRow(row: CampaignRow, override?: ScopePatch): unknown {
  if (row.scopeMode === "GLOBAL_ALL_PAID_LINES" && override === undefined) {
    return { mode: row.scopeMode };
  }
  return {
    mode: override?.scopeMode ?? row.scopeMode,
    categoryKeys: override?.categoryKeys ?? row.categoryKeys,
    includeProductIds:
      override?.includeProductIds ?? row.targets.filter((t) => t.role === "INCLUDE").map((t) => t.productId),
    excludeProductIds:
      override?.excludeProductIds ?? row.targets.filter((t) => t.role === "EXCLUDE").map((t) => t.productId),
  };
}

/** The global scope exists only for gift + ORDER_SUBTOTAL + ALL_PAID_LINES. */
function allowsGlobalScope(row: Pick<CampaignRow, "kind" | "giftTrigger" | "subtotalScope">): boolean {
  return row.kind === "GIFT_ITEM" && row.giftTrigger === "ORDER_SUBTOTAL" && row.subtotalScope === "ALL_PAID_LINES";
}

/**
 * One consistent membership snapshot for a Fixed scope.
 *
 * A single SQL statement reads at a single snapshot, so concurrent category assignment can never
 * produce a half-old, half-new set. The statement is bounded one past the freeze limit so the
 * limit is reported rather than silently truncated. Only the membership keys the scope covers are
 * aggregated; that is all `computeFrozenProductIds` looks at.
 */
export async function readMembershipSnapshot(
  tx: Pick<Tx, "$queryRaw">,
  scope: Extract<ScopeConfig, { categoryKeys: readonly string[] }>,
) {
  const covered = [...expandScopeCategoryKeys(scope.categoryKeys)];
  const rows = await tx.$queryRaw<Array<{ productId: string; categoryKeys: string[] }>>`
    SELECT pm."id" AS "productId",
           COALESCE(array_agg(pcm."categoryKey") FILTER (WHERE pcm."categoryKey" IS NOT NULL), ARRAY[]::text[]) AS "categoryKeys"
    FROM "ProductMirror" pm
    LEFT JOIN "ProductCategoryMembership" pcm
      ON pcm."productId" = pm."id" AND pcm."categoryKey" = ANY(${covered}::text[])
    WHERE (
        pm."id" = ANY(${[...scope.includeProductIds]}::text[])
        OR EXISTS (
          SELECT 1 FROM "ProductCategoryMembership" m
          WHERE m."productId" = pm."id" AND m."categoryKey" = ANY(${covered}::text[])
        )
      )
      -- Explicit exclusions are removed before the bound, so they cannot consume its budget.
      AND NOT (pm."id" = ANY(${[...scope.excludeProductIds]}::text[]))
    GROUP BY pm."id"
    ORDER BY pm."id"
    LIMIT ${MAX_FROZEN_PRODUCTS + 1}
  `;
  return rows.map((row): ScopeProductFacts => ({ productId: row.productId, categoryKeys: row.categoryKeys }));
}

/** Replaces the frozen set (never merges into it) and returns how many products it froze. */
async function writeFrozenSet(
  tx: Tx,
  campaignId: string,
  scope: ScopeConfig,
  now: Date,
  campaignRevision: number,
): Promise<{ ok: true; count: number } | { ok: false; code: string }> {
  if (scope.mode !== FIXED_PRODUCT_SET) return { ok: false, code: "scope-mode-invalid" };
  const snapshot = await readMembershipSnapshot(tx, scope);
  const frozen = computeFrozenProductIds(scope, snapshot);
  if (!frozen.ok) return { ok: false, code: frozen.code };

  await tx.giftQuantityFrozenProduct.deleteMany({ where: { campaignId } });
  await tx.giftQuantityFrozenProduct.createMany({
    data: frozen.productIds.map((productId) => ({ campaignId, productId })),
  });
  await tx.giftQuantityCampaign.update({
    where: { id: campaignId },
    data: { frozenAt: now, frozenCampaignRevision: campaignRevision },
  });
  return { ok: true, count: frozen.productIds.length };
}

async function clearFrozenSet(tx: Tx, campaignId: string): Promise<void> {
  await tx.giftQuantityFrozenProduct.deleteMany({ where: { campaignId } });
  await tx.giftQuantityCampaign.update({
    where: { id: campaignId },
    data: { frozenAt: null, frozenCampaignRevision: null },
  });
}

function validateWindow(
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
  options: Readonly<{ startMustBeFuture?: boolean }> = {},
): string[] {
  const errors: string[] = [];
  if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) errors.push("WINDOW_NOT_POSITIVE");
  if (endsAt !== null && endsAt.getTime() <= now.getTime()) errors.push("WINDOW_ALREADY_ENDED");
  // A Scheduled campaign stays Scheduled: an edit may not clear or backdate its start, because that
  // would make it charge buyers at once without the publish step that validates it.
  if (options.startMustBeFuture === true && (startsAt === null || startsAt.getTime() <= now.getTime())) {
    errors.push("WINDOW_START_NOT_FUTURE");
  }
  return errors;
}

/** The rule fields a validation looks at: the stored row, or the row as an edit would leave it. */
type RuleSource = Pick<
  CampaignRow,
  | "kind" | "giftTrigger" | "minimumQuantity" | "minimumSubtotalVnd" | "subtotalScope" | "awardMode"
  | "maxGiftsPerOrder" | "allowDuplicateGifts" | "tierUnit" | "tierDiscountedUnits" | "tierSelectionPriority"
  | "tiers" | "giftOptions" | "stackingEnabled" | "stackPriority" | "stackPeers"
>;

function ruleInputOf(row: RuleSource): RuleValidationInput {
  return {
    kind: row.kind,
    giftTrigger: row.giftTrigger,
    minimumQuantity: row.minimumQuantity,
    minimumSubtotalVnd: row.minimumSubtotalVnd,
    subtotalScope: row.subtotalScope,
    awardMode: row.awardMode,
    maxGiftsPerOrder: row.maxGiftsPerOrder,
    allowDuplicateGifts: row.allowDuplicateGifts,
    tierUnit: row.tierUnit,
    tierDiscountedUnits: row.tierDiscountedUnits,
    tierSelectionPriority: row.tierSelectionPriority,
    tiers: row.tiers,
    giftVariantIds: row.giftOptions.map((option) => option.variantId),
    stackingEnabled: row.stackingEnabled,
    stackPriority: row.stackPriority,
    stackPeers: row.stackPeers.map((peer) => ({ kind: peer.peerKind, campaignId: peer.peerCampaignId })),
  } as const;
}

function tierRuleOfRow(row: RuleSource): TierRuleInput {
  return {
    unit: row.tierUnit,
    discountedUnits: row.tierDiscountedUnits,
    selectionPriority: row.tierSelectionPriority,
    tiers: row.tiers,
    stackingEnabled: row.stackingEnabled,
    stackPriority: row.stackPriority,
    peers: row.stackPeers.map((peer) => ({ kind: peer.peerKind, campaignId: peer.peerCampaignId })),
  };
}

/**
 * Checks that need other rows, run after the campaign's own rule validated and inside the same
 * transaction as the write (so under the revision lock): the stack priority is unique among
 * effective-or-pending stacking tiers and legacy consents, and a fixed-VND tier cannot take any
 * in-scope catalog price below 1 VND (EX-21). Peers must exist (also enforced on Draft writes; it
 * is re-checked here because a Draft's peer is only a name until the campaign goes live).
 */
async function crossRowRuleErrors(
  tx: Tx,
  campaignId: string,
  source: RuleSource,
  scope: ScopeConfig,
  now: Date,
): Promise<readonly string[]> {
  if (source.kind !== "QUANTITY_TIER") return [];
  const rule = tierRuleOfRow(source);
  const errors: string[] = [];
  errors.push(...(await invalidStackPeers(tx, rule, campaignId)));
  if (rule.stackingEnabled && rule.stackPriority !== null) {
    if (await hasStackPriorityConflict(tx, { campaignId, priority: rule.stackPriority, now })) {
      errors.push("STACK_PRIORITY_CONFLICT");
    }
  }
  if (toQuantityTierConfig(rule) !== null) {
    const price = await checkTierPriceSafety(tx, rule, scope);
    if (price !== null) errors.push(price);
  }
  return errors;
}

async function loadCampaign(tx: Tx, campaignId: string): Promise<CampaignRow | null> {
  return tx.giftQuantityCampaign.findUnique({ where: { id: campaignId }, select: giftQuantityCampaignSelection });
}

/**
 * Publish or re-enable.
 *
 * Re-enable is only legal for a campaign disabled before it was ever active; it is treated as a new
 * publish and **re-captures** a Fixed scope from current membership. Anything that has run is
 * terminal and is copied instead.
 */
export async function publishGiftQuantityCampaign({
  campaignId,
  now,
  session,
  client = prisma,
  env = process.env,
  validateRule = validateRuleForPublish,
}: GiftQuantityActivationInput): Promise<GiftQuantityActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };
  if (!isGiftQuantityPromotionsEnabled(env)) return { ok: false, failure: { reason: "FEATURE_DISABLED" } };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);

    const row = await loadCampaign(tx, campaignId);
    if (row === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;

    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    if (lifecycle.status !== "DRAFT" && !lifecycle.canReEnable) {
      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;
    }

    const inputErrors = [
      ...(normalizePromotionCampaignName(row.name).ok ? [] : ["INVALID_NAME"]),
      ...validateWindow(row.startsAt, row.endsAt, now),
    ];
    if (inputErrors.length > 0) return { ok: false, failure: { reason: "INVALID_INPUT", errors: inputErrors } } as const;

    const scope = validateScopeConfig(scopeFromRow(row), { allowGlobal: allowsGlobalScope(row) });
    if (!scope.ok) return { ok: false, failure: { reason: "INVALID_SCOPE", issues: scope.issues } } as const;

    const ruleErrors = validateRule(ruleInputOf(row));
    if (ruleErrors.length > 0) return { ok: false, failure: { reason: "INVALID_RULE", errors: ruleErrors } } as const;
    const crossRowErrors = await crossRowRuleErrors(tx, row.id, row, scope.scope, now);
    if (crossRowErrors.length > 0) return { ok: false, failure: { reason: "INVALID_RULE", errors: crossRowErrors } } as const;

    // A publish / re-enable is a new effective version of the campaign.
    const campaignRevision = row.revision + 1;
    let frozenProductCount: number | null = null;
    if (scope.scope.mode === FIXED_PRODUCT_SET) {
      const frozen = await writeFrozenSet(tx, row.id, scope.scope, now, campaignRevision);
      if (!frozen.ok) return { ok: false, failure: { reason: "FROZEN_SET_INVALID", code: frozen.code } } as const;
      frozenProductCount = frozen.count;
    } else {
      await clearFrozenSet(tx, row.id);
    }

    await tx.giftQuantityCampaign.update({
      where: { id: row.id },
      // Re-enable writes a fresh enabledAt and clears disabledAt, exactly like the legacy service.
      data: { isEnabled: true, enabledAt: now, disabledAt: null, revision: campaignRevision },
    });

    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: row.id, revision, campaignRevision, frozenProductCount } as const;
  });
}

/**
 * Disable. Never gated and never expands anything: it is the rollback path and must not be the
 * thing that fails.
 */
export async function disableGiftQuantityCampaign({
  campaignId,
  now,
  session,
  client = prisma,
}: Omit<GiftQuantityActivationInput, "env" | "validateRule">): Promise<GiftQuantityActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);

    const row = await tx.giftQuantityCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, isEnabled: true, enabledAt: true, disabledAt: true, startsAt: true, endsAt: true, revision: true },
    });
    if (row === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    // Only a campaign that can still charge anyone is switched off. A Draft was never on, and an
    // Ended or already Disabled one is history that must keep reading as what it was.
    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    if (lifecycle.status !== "ACTIVE" && lifecycle.status !== "SCHEDULED") {
      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;
    }

    // Disabling is an effective change, so the campaign's own revision moves with the durable one.
    const campaignRevision = row.revision + 1;
    await tx.giftQuantityCampaign.update({
      where: { id: row.id },
      data: { isEnabled: false, disabledAt: now, revision: campaignRevision },
    });
    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: row.id, revision, campaignRevision, frozenProductCount: null } as const;
  });
}

/** End a running campaign early: it only ever shrinks the window, and stays enabled. Never gated. */
export async function endGiftQuantityCampaignEarly({
  campaignId,
  now,
  session,
  client = prisma,
}: Omit<GiftQuantityActivationInput, "env" | "validateRule">): Promise<GiftQuantityActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);

    const row = await loadCampaign(tx, campaignId);
    if (row === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    if (lifecycle.status !== "ACTIVE") {
      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;
    }

    // Shrinking the window is an effective change, so the campaign's own revision moves too.
    const campaignRevision = row.revision + 1;
    await tx.giftQuantityCampaign.update({ where: { id: row.id }, data: { endsAt: now, revision: campaignRevision } });
    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: row.id, revision, campaignRevision, frozenProductCount: null } as const;
  });
}

export type ScopePatch = Readonly<{
  scopeMode: ScopeConfig["mode"];
  categoryKeys: readonly string[];
  includeProductIds: readonly string[];
  excludeProductIds: readonly string[];
}>;

/**
 * Fields a Scheduled edit may change here. The tier rule is GQ09a's; gift options and thresholds
 * arrive with GQ13a through their own write contract and reuse this transaction.
 */
export type ScheduledEditPatch = Readonly<{
  /**
   * Identity facts the caller believes the campaign has. They are **not editable** on a Scheduled
   * campaign, so a value that differs from the stored one is refused instead of silently ignored
   * (changing the trigger would change what the stored thresholds mean).
   */
  kind?: GiftQuantityCampaignKind;
  giftTrigger?: GiftTrigger | null;
  subtotalScope?: GiftSubtotalScope | null;
  name?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  stackPriority?: number | null;
  stackingEnabled?: boolean;
  scope?: ScopePatch;
  /**
   * Quantity-tier campaigns only: the whole rule (ladder, FROM/ALL, stacking, peers) as it should
   * be after the edit. Compared with the stored rule; an identical rule is not an edit. When given
   * together with `stackPriority` / `stackingEnabled` the three must agree.
   */
  tierRule?: TierRuleInput;
}>;

/** The campaign as it will be once `patch` lands: only the rule fields a Scheduled edit can change. */
function applyRulePatch(
  row: CampaignRow,
  patch: ScheduledEditPatch,
  stackPriority: number | null,
  stackingEnabled: boolean,
): RuleSource {
  const rule = patch.tierRule;
  return {
    ...row,
    stackPriority,
    stackingEnabled,
    ...(rule === undefined
      ? {}
      : {
          tierUnit: rule.unit,
          tierDiscountedUnits: rule.discountedUnits,
          tierSelectionPriority: rule.discountedUnits === "FROM_REACHED_THRESHOLD" ? rule.selectionPriority : null,
          tiers: rule.tiers.map((tier) => ({ minQuantity: tier.minQuantity, discountValue: tier.discountValue })),
          stackPeers: rule.peers.map((peer) => ({ peerKind: peer.kind, peerCampaignId: peer.campaignId })),
        }),
  };
}

function sameTierRule(a: TierRuleInput, b: TierRuleInput): boolean {
  const selection = (rule: TierRuleInput) => (rule.discountedUnits === "FROM_REACHED_THRESHOLD" ? rule.selectionPriority : null);
  const ladder = (rule: TierRuleInput) =>
    [...rule.tiers].sort((x, y) => x.minQuantity - y.minQuantity).map((tier) => `${tier.minQuantity}:${tier.discountValue}`).join(",");
  const peers = (rule: TierRuleInput) => rule.peers.map((peer) => `${peer.kind}|${peer.campaignId}`).sort().join(",");
  return (
    a.unit === b.unit &&
    a.discountedUnits === b.discountedUnits &&
    selection(a) === selection(b) &&
    a.stackingEnabled === b.stackingEnabled &&
    a.stackPriority === b.stackPriority &&
    ladder(a) === ladder(b) &&
    peers(a) === peers(b)
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return other.size === b.length && a.every((value) => other.has(value));
}

/**
 * A material edit to a Scheduled campaign.
 *
 * - Scope-material change (mode, categories, includes, excludes): revalidated, and a Fixed scope's
 *   snapshot is **replaced** in this transaction; moving away from Fixed clears it.
 * - Anything else except the name (window, priority, stacking): the frozen ids are kept untouched.
 * - Name only: not effective, so neither revision moves.
 * A refused edit leaves the stored campaign exactly as it was.
 */
export async function editScheduledGiftQuantityCampaign({
  campaignId,
  now,
  session,
  patch,
  client = prisma,
  env = process.env,
  validateRule = validateRuleForPublish,
}: GiftQuantityActivationInput & Readonly<{ patch: ScheduledEditPatch }>): Promise<GiftQuantityActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  // A key that is present but `undefined` means "not provided", never "clear it". Whether a provided
  // value is a *change* is decided inside the transaction against the stored row: a form re-sends
  // every field on every save, and an unchanged field is not an edit.
  const touchesStart = patch.startsAt !== undefined;
  const touchesEnd = patch.endsAt !== undefined;

  const normalizedName = patch.name === undefined ? null : normalizePromotionCampaignName(patch.name);
  if (normalizedName !== null && !normalizedName.ok) {
    return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["INVALID_NAME"] } };
  }

  // Malformed or unbounded rule input is refused before anything is locked or read, whatever the
  // gate says: it is not a business question and it can never be stored.
  if (patch.tierRule !== undefined) {
    const structure = validateTierRuleStructure(patch.tierRule);
    if (structure.length > 0) return { ok: false, failure: { reason: "INVALID_INPUT", errors: structure } };
    if (
      (patch.stackPriority !== undefined && patch.stackPriority !== patch.tierRule.stackPriority) ||
      (patch.stackingEnabled !== undefined && patch.stackingEnabled !== patch.tierRule.stackingEnabled)
    ) {
      return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["STACK_FIELDS_CONFLICT"] } };
    }
  }

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);

    const row = await loadCampaign(tx, campaignId);
    if (row === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    // What actually changes, measured against the stored campaign. A form re-sends every field on
    // every save, so a provided value is only an edit when it differs.
    const instant = (date: Date | null) => (date === null ? null : date.getTime());
    const startsAt = touchesStart ? patch.startsAt ?? null : row.startsAt;
    const endsAt = touchesEnd ? patch.endsAt ?? null : row.endsAt;
    const startsAtChanged = touchesStart && instant(startsAt) !== instant(row.startsAt);
    const endsAtChanged = touchesEnd && instant(endsAt) !== instant(row.endsAt);
    // The stacking fields as they will be: a whole-rule patch dictates them (and was checked above
    // to agree with any scalar patch); otherwise the scalar patch, otherwise what is stored.
    const nextPriority =
      patch.tierRule !== undefined ? patch.tierRule.stackPriority : patch.stackPriority !== undefined ? patch.stackPriority : row.stackPriority;
    const nextStacking =
      patch.tierRule !== undefined ? patch.tierRule.stackingEnabled : patch.stackingEnabled !== undefined ? patch.stackingEnabled : row.stackingEnabled;
    const priorityChanged = nextPriority !== row.stackPriority;
    const stackingChanged = nextStacking !== row.stackingEnabled;
    // Compared as a rule, so re-sending the stored ladder (in any order) is not an edit.
    const tierRuleChanged = patch.tierRule !== undefined && !sameTierRule(patch.tierRule, tierRuleOfRow(row));
    const currentInclude = row.targets.filter((t) => t.role === "INCLUDE").map((t) => t.productId);
    const currentExclude = row.targets.filter((t) => t.role === "EXCLUDE").map((t) => t.productId);
    // Exclude wins, so a product named on both lists is compared (and later persisted) once, as excluded.
    const scopeChanged =
      patch.scope !== undefined &&
      (patch.scope.scopeMode !== row.scopeMode ||
        (patch.scope.scopeMode !== "GLOBAL_ALL_PAID_LINES" &&
          (!sameSet(patch.scope.categoryKeys, row.categoryKeys) ||
            !sameSet(applyExcludeWins(patch.scope.includeProductIds, patch.scope.excludeProductIds), currentInclude) ||
            !sameSet(patch.scope.excludeProductIds, currentExclude))));
    const effective = startsAtChanged || endsAtChanged || priorityChanged || stackingChanged || scopeChanged || tierRuleChanged;

    // The gate is decided by what the edit would change, before anything else about the campaign.
    if (effective && !isGiftQuantityPromotionsEnabled(env)) return { ok: false, failure: { reason: "FEATURE_DISABLED" } } as const;

    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    if (lifecycle.status !== "SCHEDULED") {
      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;
    }

    // Identity is not editable here: refuse a mismatch loudly rather than drop it.
    if (patch.kind !== undefined && patch.kind !== row.kind) {
      return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["KIND_IMMUTABLE"] } } as const;
    }
    if (
      row.kind === "GIFT_ITEM" &&
      ((patch.giftTrigger !== undefined && patch.giftTrigger !== row.giftTrigger) ||
        (patch.subtotalScope !== undefined && patch.subtotalScope !== row.subtotalScope))
    ) {
      return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["GIFT_TRIGGER_NOT_EDITABLE_WHEN_SCHEDULED"] } } as const;
    }

    // A tier rule belongs to a tier campaign; a gift campaign has none to replace.
    if (patch.tierRule !== undefined && row.kind !== "QUANTITY_TIER") {
      return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["TIER_FIELDS_ON_GIFT"] } } as const;
    }

    const scopeValidation = validateScopeConfig(scopeFromRow(row, patch.scope), { allowGlobal: allowsGlobalScope(row) });
    if (!scopeValidation.ok) {
      return { ok: false, failure: { reason: "INVALID_SCOPE", issues: scopeValidation.issues } } as const;
    }
    const normalizedScope = scopeValidation.scope;

    // Only a real change to what a buyer is charged is gated, window-checked and rule-validated. A
    // rename, or a save that re-sends the stored values, is neither.
    if (effective) {
      if (!isGiftQuantityPromotionsEnabled(env)) return { ok: false, failure: { reason: "FEATURE_DISABLED" } } as const;
      const windowErrors = validateWindow(startsAt, endsAt, now, { startMustBeFuture: true });
      if (windowErrors.length > 0) return { ok: false, failure: { reason: "INVALID_INPUT", errors: windowErrors } } as const;
      // Validate the campaign as it will be after the edit, not the stored row it replaces: a
      // patch that turns stacking on without a priority must be refused here, not stored.
      const after = applyRulePatch(row, patch, nextPriority, nextStacking);
      if (tierRuleChanged && patch.tierRule !== undefined) {
        const peerErrors = await invalidStackPeers(tx, patch.tierRule, row.id);
        if (peerErrors.length > 0) return { ok: false, failure: { reason: "INVALID_INPUT", errors: peerErrors } } as const;
      }
      const ruleErrors = validateRule(ruleInputOf(after));
      if (ruleErrors.length > 0) return { ok: false, failure: { reason: "INVALID_RULE", errors: ruleErrors } } as const;
      const crossRowErrors = await crossRowRuleErrors(tx, row.id, after, normalizedScope, now);
      if (crossRowErrors.length > 0) return { ok: false, failure: { reason: "INVALID_RULE", errors: crossRowErrors } } as const;
    }

    const campaignRevision = effective ? row.revision + 1 : row.revision;
    let frozenProductCount: number | null = null;

    if (scopeChanged && patch.scope !== undefined) {
      // A frozen snapshot is only valid on a FIXED_PRODUCT_SET campaign (database CHECK), so moving
      // away from Fixed clears it *before* the mode changes.
      if (scopeValidation.scope.mode !== FIXED_PRODUCT_SET) await clearFrozenSet(tx, row.id);
      await tx.giftQuantityTarget.deleteMany({ where: { campaignId: row.id } });
      // The normalized scope is what is persisted: a product on both lists is stored once, as EXCLUDE.
      const persistedInclude = normalizedScope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : normalizedScope.includeProductIds;
      const persistedExclude = normalizedScope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : normalizedScope.excludeProductIds;
      await tx.giftQuantityTarget.createMany({
        data: [
          ...persistedInclude.map((productId) => ({ campaignId: row.id, productId, role: "INCLUDE" as const })),
          ...persistedExclude.map((productId) => ({ campaignId: row.id, productId, role: "EXCLUDE" as const })),
        ],
      });
      await tx.giftQuantityCampaign.update({
        where: { id: row.id },
        data: {
          scopeMode: normalizedScope.mode,
          categoryKeys: normalizedScope.mode === "GLOBAL_ALL_PAID_LINES" ? [] : [...normalizedScope.categoryKeys],
        },
      });
      if (scopeValidation.scope.mode === FIXED_PRODUCT_SET) {
        const frozen = await writeFrozenSet(tx, row.id, scopeValidation.scope, now, campaignRevision);
        if (!frozen.ok) {
          // Throwing rolls the whole transaction back, so the refused edit leaves nothing behind.
          throw new FrozenSetRefusal(frozen.code);
        }
        frozenProductCount = frozen.count;
      }
    }

    if (tierRuleChanged && patch.tierRule !== undefined) {
      const rule = patch.tierRule;
      // The old ladder goes first: a ladder row's `unit` follows the parent's `tierUnit`.
      await tx.quantityTier.deleteMany({ where: { campaignId: row.id } });
      await tx.giftQuantityStackPeer.deleteMany({ where: { campaignId: row.id } });
      await tx.giftQuantityCampaign.update({
        where: { id: row.id },
        data: {
          tierUnit: rule.unit,
          tierDiscountedUnits: rule.discountedUnits,
          tierSelectionPriority: rule.discountedUnits === "FROM_REACHED_THRESHOLD" ? rule.selectionPriority : null,
          // Nested creates must not pass `unit`: it is filled from the parent campaign.
          tiers: { create: rule.tiers.map((tier) => ({ minQuantity: tier.minQuantity, discountValue: tier.discountValue })) },
          stackPeers: { create: rule.peers.map((peer) => ({ peerKind: peer.kind, peerCampaignId: peer.campaignId })) },
        },
      });
    }

    await tx.giftQuantityCampaign.update({
      where: { id: row.id },
      data: {
        ...(normalizedName !== null && normalizedName.ok ? { name: normalizedName.name } : {}),
        ...(startsAtChanged ? { startsAt } : {}),
        ...(endsAtChanged ? { endsAt } : {}),
        ...(priorityChanged ? { stackPriority: nextPriority } : {}),
        ...(stackingChanged ? { stackingEnabled: nextStacking } : {}),
        revision: campaignRevision,
      },
    });

    const revision = effective ? await advanceRevision(tx, currentRevision) : currentRevision;
    return { ok: true, campaignId: row.id, revision, campaignRevision, frozenProductCount } as const;
  }).catch((error: unknown) => {
    if (error instanceof FrozenSetRefusal) {
      return { ok: false, failure: { reason: "FROZEN_SET_INVALID", code: error.code } } as const;
    }
    throw error;
  });
}

class FrozenSetRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Frozen scope set refused");
    this.code = code;
  }
}
