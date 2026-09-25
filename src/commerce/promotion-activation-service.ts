/**
 * The transactional boundary for effective promotion mutations.
 *
 * "Effective" means a mutation that can change what a buyer is charged now or later: publish,
 * re-enable, disable, and a material edit to a Scheduled campaign. Every one of them must do two
 * things atomically — change the campaign, and advance the durable pricing revision — because a
 * Merchant cache decision orders itself against that revision. If the revision could lag the
 * mutation, stale sale bytes could be served as current.
 *
 * Race safety comes from the revision row itself. Every effective mutation takes `FOR UPDATE` on
 * that single row *before* it reads anything else, which serializes all of them globally. That is
 * what makes the overlap check trustworthy: two concurrent publishes cannot both read a
 * conflict-free world and then both commit. Locking a variant set instead would need the set to be
 * known before it is computed, and would not cover PRODUCT targets whose coverage changes.
 *
 * Serializing every effective mutation is a deliberate throughput trade. Promotion publishes are
 * rare administrative actions, and correctness under concurrency is worth far more here than
 * parallelism.
 *
 * The revision lock alone is not enough, because catalog sync never takes it. A coverage-validating
 * mutation therefore also locks, in one fixed order, the campaign row, then its owning product
 * rows, then the variant rows the expansion probe produced, and re-reads every fact it decides on
 * *after* holding those locks. The order is fixed so concurrent mutations cannot deadlock against
 * each other, and each set is taken with `ORDER BY "id"` so two callers with overlapping sets queue
 * rather than cross.
 *
 * That boundary has a known limit worth stating rather than implying: `FOR UPDATE` cannot lock a row
 * that does not exist yet, so a variant inserted for an already-locked product during validation is
 * not covered by it. Locking the owning product row is the mitigation — a sync that adds a variant
 * touches its product — and per-variant runtime health is what catches whatever still slips through.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import { prisma } from "../db/prisma.ts";

import {
  isBoundedPromotionIdentifier,
  isPromotionActivationEnabled,
  validateCampaignForActivation,
  validateDraftInput,
  type CampaignActivationError,
  type CampaignTargetInput,
  type DraftInputError,
} from "./promotion-activation.ts";
import {
  buildCopyCampaignName,
  deriveCampaignLifecycle,
  type CampaignLifecycleStatus,
} from "./promotion-campaign-lifecycle.ts";
import {
  resolvePromotionPricing,
  type ApplicablePromotionCampaign,
  type PromotionCampaignKind,
  type PromotionDiscountType,
} from "./promotion-pricing.ts";
import {
  assessCampaignRuntimeHealth,
  type VariantPricingOutcome,
} from "./promotion-runtime-health.ts";
import type { PromotionSignalWriter } from "../operations/promotion-observability.ts";

/**
 * Coverage-validating writes expand PRODUCT targets to their current variants. The bound protects
 * that expensive work; it is not a limit on how many variants a campaign may ultimately cover.
 */
export const MAX_EXPANDED_VARIANTS_PER_CAMPAIGN = 2000;

export const PROMOTION_REVISION_ID = "current";

export type ActivationFailure =
  | { reason: "ACTIVATION_DISABLED" }
  | { reason: "CAMPAIGN_NOT_FOUND" }
  /**
   * The lifecycle status the operation was refused from. Typed as the derived status rather than a
   * free string: every producer supplies one, and a caller that logs or branches on it should not
   * have to defend against an arbitrary value reaching it.
   */
  | { reason: "ILLEGAL_TRANSITION"; from: CampaignLifecycleStatus }
  | { reason: "INVALID_CAMPAIGN"; errors: readonly CampaignActivationError[] }
  /** Syntactic/storage/input bounds, refused on every write including a Draft. */
  | { reason: "INVALID_DRAFT_INPUT"; errors: readonly DraftInputError[] }
  | { reason: "TARGET_EXPANSION_LIMIT_EXCEEDED" }
  /** No currently covered variant would actually be discounted by this campaign. */
  | { reason: "NO_EFFECTIVE_DISCOUNT"; invalidVariantIds: readonly string[] }
  /** A currently covered variant has no usable mirrored base price. Names the catalog rows to fix. */
  | { reason: "UNUSABLE_BASE_PRICE"; variantIds: readonly string[] }
  | { reason: "OVERLAPPING_CAMPAIGN"; conflictingCampaignIds: readonly string[] }
  | { reason: "DUPLICATE_TARGET" };

export type ActivationOutcome =
  | Readonly<{ ok: true; campaignId: string; revision: bigint }>
  | Readonly<{ ok: false; failure: ActivationFailure }>;

type Tx = Prisma.TransactionClient;

/**
 * Shaped like the sessions the rest of the admin domain takes, so authorization is the same check
 * here as everywhere else rather than a promotion-specific rule.
 */
export type AdminSessionCandidate =
  | { user: { id: string; role?: string | null }; session: { id: string } }
  | null
  | undefined;

/**
 * Authorization is checked before the gate and before any transaction opens.
 *
 * Deliberately throws rather than returning a typed failure: an unauthorized caller is not a
 * business outcome an admin screen should render, and mixing it into `ActivationFailure` would
 * invite a caller to handle it as one. It matches `AuthorizationError` everywhere else in admin.
 */
function authorize(session: AdminSessionCandidate): void {
  requireAdminSession(session);
}

/**
 * The pre-lookup gate every operation runs: authorize, then bound the identifier, then open a
 * transaction. Returning a failure rather than throwing keeps an oversized id a typed outcome an
 * admin screen can render, the same as any other refused input.
 */
function refuseUnboundedCampaignId(campaignId: string): ActivationFailure | null {
  return isBoundedPromotionIdentifier(campaignId)
    ? null
    : { reason: "INVALID_DRAFT_INPUT", errors: ["IDENTIFIER_TOO_LONG"] };
}

/**
 * Takes the global effective-mutation lock and returns the current revision.
 *
 * This is the first statement of every effective mutation, so ordering is established before any
 * decision is read.
 */
async function lockRevision(tx: Tx): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ revision: bigint }>>`
    SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID} FOR UPDATE
  `;
  const revision = rows[0]?.revision;
  if (revision === undefined) {
    throw new Error("Promotion pricing revision row is missing; migrations are not deployed");
  }
  return revision;
}

async function advanceRevision(tx: Tx, current: bigint): Promise<bigint> {
  const next = current + BigInt(1);
  await tx.$executeRaw`
    UPDATE "PromotionPricingRevision"
    SET "revision" = ${next}, "updatedAt" = NOW()
    WHERE "id" = ${PROMOTION_REVISION_ID}
  `;
  return next;
}

/** Current variants covered by a campaign's explicit targets, bounded by one probe row. */
async function expandCoverage(
  tx: Tx,
  targets: readonly { productId: string | null; variantId: string | null }[],
): Promise<string[] | null> {
  const productIds = targets.flatMap((t) => (t.productId === null ? [] : [t.productId]));
  const directVariantIds = targets.flatMap((t) => (t.variantId === null ? [] : [t.variantId]));

  const owned = productIds.length === 0
    ? []
    : await tx.variantMirror.findMany({
        where: { productId: { in: productIds } },
        select: { id: true },
        take: MAX_EXPANDED_VARIANTS_PER_CAMPAIGN + 1,
      });

  const covered = new Set<string>([...directVariantIds, ...owned.map((variant) => variant.id)]);
  // Probing one past the bound is what lets this report the limit instead of silently truncating.
  return covered.size > MAX_EXPANDED_VARIANTS_PER_CAMPAIGN ? null : [...covered];
}

/**
 * Locks a set of rows in one deterministic order.
 *
 * `ORDER BY "id"` is what keeps two callers holding overlapping sets from crossing: they queue on
 * the same first row instead of each holding what the other still needs.
 */
async function lockRows(
  tx: Tx,
  table: "PromotionCampaign" | "ProductMirror" | "VariantMirror",
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "${table}" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`,
    [...ids].sort(),
  );
}

/** Owning products of a campaign's targets: the named products, plus owners of the named variants. */
async function owningProductIds(
  tx: Tx,
  targets: readonly { productId: string | null; variantId: string | null }[],
): Promise<string[]> {
  const named = targets.flatMap((t) => (t.productId === null ? [] : [t.productId]));
  const variantIds = targets.flatMap((t) => (t.variantId === null ? [] : [t.variantId]));
  const owners = variantIds.length === 0
    ? []
    : await tx.variantMirror.findMany({
        where: { id: { in: variantIds } },
        select: { productId: true },
      });
  return [...new Set([...named, ...owners.map((variant) => variant.productId)])];
}

type CandidateMoney = Readonly<{
  discountType: "PERCENTAGE" | "FIXED_PRICE";
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
}>;

/**
 * Runs the campaign's money rule over every variant it currently covers, through the central pricing
 * authority rather than a comparison written here — activation and the storefront must not be able
 * to disagree about what counts as a discount.
 *
 * Every current affected variant must come out discounted. An unusable mirrored base fails
 * activation exactly as a mis-specified discount does; the two are reported apart only because they
 * point at different things to fix — a catalog row versus the campaign.
 *
 * Partial validity is a *post-activation* concept. It covers catalog drift and variants newly
 * covered after the campaign was enabled, which is what per-variant runtime health reports. It is
 * not a licence to enable a campaign over a variant that is already unpriceable: that ships a
 * promotion known to be broken for part of its coverage from the moment it goes live.
 */
async function findVariantsTheCampaignCannotDiscount(
  tx: Tx,
  candidate: CandidateMoney,
  coveredVariantIds: readonly string[],
  now: Date,
): Promise<{
  invalid: string[];
  unusableBase: string[];
  discounted: number;
  outcomes: VariantPricingOutcome[];
}> {
  if (coveredVariantIds.length === 0) return { invalid: [], unusableBase: [], discounted: 0, outcomes: [] };

  const variants = await tx.variantMirror.findMany({
    where: { id: { in: [...coveredVariantIds] } },
    select: { id: true, pancakeRetailPrice: true },
  });

  // The window is deliberately dropped. Activation asks whether this campaign *could* discount these
  // variants, not whether it is running at this instant: a Scheduled campaign must be validated
  // before its window opens.
  const applicable: ApplicablePromotionCampaign = {
    id: "candidate",
    name: "candidate",
    kind: "PROMOTION",
    discountType: candidate.discountType,
    percentageValue: candidate.percentageValue,
    fixedPriceVnd: candidate.fixedPriceVnd,
    startsAt: null,
    endsAt: null,
  };

  const invalid: string[] = [];
  const unusableBase: string[] = [];
  const outcomes: VariantPricingOutcome[] = [];
  let discounted = 0;
  for (const variant of variants) {
    const pricing = resolvePromotionPricing({
      basePriceVnd: variant.pancakeRetailPrice,
      campaigns: [applicable],
      now,
    });
    outcomes.push({
      variantId: variant.id,
      isDiscounted: pricing.isDiscounted,
      reason: pricing.reason,
      conflictingCampaignIds: [],
    });
    if (pricing.isDiscounted) {
      discounted += 1;
      continue;
    }
    if (pricing.reason === "BASE_PRICE_UNAVAILABLE") unusableBase.push(variant.id);
    else invalid.push(variant.id);
  }

  return { invalid, unusableBase, discounted, outcomes };
}

function windowsOverlap(
  a: { startsAt: Date | null; endsAt: Date | null },
  b: { startsAt: Date | null; endsAt: Date | null },
): boolean {
  const startA = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const endA = a.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const startB = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const endB = b.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  // Half-open, so B may start exactly when A ends without overlapping.
  return startA < endB && startB < endA;
}

async function findOverlappingCampaigns(
  tx: Tx,
  campaignId: string,
  window: { startsAt: Date | null; endsAt: Date | null },
  coveredVariantIds: readonly string[],
): Promise<string[]> {
  const others = await tx.promotionCampaign.findMany({
    where: { isEnabled: true, id: { not: campaignId } },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      targets: { select: { productId: true, variantId: true } },
    },
  });

  const covered = new Set(coveredVariantIds);
  const conflicting: string[] = [];

  for (const other of others) {
    if (!windowsOverlap(window, other)) continue;
    const otherCoverage = await expandCoverage(tx, other.targets);
    // An unbounded competitor cannot be proved disjoint, so it is treated as conflicting rather
    // than waved through.
    if (otherCoverage === null || otherCoverage.some((id) => covered.has(id))) {
      conflicting.push(other.id);
    }
  }

  return conflicting;
}

export type PublishInput = Readonly<{
  campaignId: string;
  now: Date;
  session: AdminSessionCandidate;
  client?: PrismaClient;
  env?: Readonly<Record<string, string | undefined>>;
  writer?: PromotionSignalWriter;
}>;

/** The campaign fields an effective mutation needs to re-validate what it is about to enable. */
const campaignFacts = {
  id: true, kind: true, name: true, discountType: true, percentageValue: true,
  fixedPriceVnd: true, startsAt: true, endsAt: true, isEnabled: true,
  enabledAt: true, disabledAt: true,
  targets: { select: { productId: true, variantId: true } },
} as const;

type CampaignFacts = Prisma.PromotionCampaignGetPayload<{ select: typeof campaignFacts }>;

/**
 * Re-validate, expand and check overlap for the state a campaign is about to be committed in.
 *
 * Shared by publish and the Scheduled material edit because they ask exactly the same question of
 * different candidate states: publish asks it of the stored row, an edit asks it of the row with a
 * patch applied. Two copies of this would be two places for the overlap rule to drift.
 */
type CandidateState = Omit<
  CampaignFacts,
  "id" | "isEnabled" | "enabledAt" | "disabledAt" | "targets"
> & Readonly<{ targets: readonly CampaignTargetInput[] }>;

async function validateEffectiveState(
  tx: Tx,
  campaignId: string,
  candidate: CandidateState,
  now: Date,
  writer?: PromotionSignalWriter,
): Promise<ActivationFailure | null> {
  // Owning products, then the variants the probe finds. The caller has already locked the campaign
  // row; everything below is read after these locks are held, so catalog sync cannot move a fact
  // between validation and commit.
  await lockRows(tx, "ProductMirror", await owningProductIds(tx, candidate.targets));
  const probe = await expandCoverage(tx, candidate.targets);
  if (probe === null) return { reason: "TARGET_EXPANSION_LIMIT_EXCEEDED" };
  await lockRows(tx, "VariantMirror", probe);

  const variantOwnerProductIds = new Map<string, string>();
  const targetedVariantIds = candidate.targets.flatMap((t) => (t.variantId === null ? [] : [t.variantId]));
  if (targetedVariantIds.length > 0) {
    for (const variant of await tx.variantMirror.findMany({
      where: { id: { in: targetedVariantIds } },
      select: { id: true, productId: true },
    })) {
      variantOwnerProductIds.set(variant.id, variant.productId);
    }
  }

  const validation = validateCampaignForActivation({ ...candidate, now, variantOwnerProductIds });
  if (!validation.ok) return { reason: "INVALID_CAMPAIGN", errors: validation.errors };

  // Re-expanded under the locks. The probe above decided which rows to lock; this is the coverage
  // the decision is actually made on, and it cannot move before commit.
  const coverage = await expandCoverage(tx, candidate.targets);
  if (coverage === null) return { reason: "TARGET_EXPANSION_LIMIT_EXCEEDED" };

  const conflicting = await findOverlappingCampaigns(tx, campaignId, candidate, coverage);
  if (conflicting.length > 0) {
    return { reason: "OVERLAPPING_CAMPAIGN", conflictingCampaignIds: conflicting };
  }

  const money = await findVariantsTheCampaignCannotDiscount(tx, candidate, coverage, now);

  try {
    assessCampaignRuntimeHealth({
      campaignId,
      outcomes: money.outcomes,
      writer,
    });
  } catch {
    // Telemetry emission failures are swallowed to safeguard business path execution.
  }

  // Reported before the discount mismatch: an unusable base is a catalog fact the admin must fix
  // first, and surfacing it as a campaign problem would send them to the wrong screen.
  if (money.unusableBase.length > 0) {
    return { reason: "UNUSABLE_BASE_PRICE", variantIds: money.unusableBase };
  }
  if (money.invalid.length > 0 || money.discounted === 0) {
    return { reason: "NO_EFFECTIVE_DISCOUNT", invalidVariantIds: money.invalid };
  }

  return null;
}

/**
 * Publish or re-enable a campaign.
 *
 * Re-enable is only legal for a campaign that was disabled before it was ever active; anything that
 * has run is terminal and must be copied instead. That check uses the derived lifecycle rather than
 * a stored flag, so it stays correct after a restart and for a window nobody observed.
 */
export async function publishPromotionCampaign({
  campaignId,
  now,
  session,
  client = prisma,
  env = process.env,
  writer,
}: PublishInput): Promise<ActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };
  if (!isPromotionActivationEnabled(env)) {
    return { ok: false, failure: { reason: "ACTIVATION_DISABLED" } };
  }

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: campaignFacts,
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }

    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
    if (lifecycle.status !== "DRAFT" && !lifecycle.canReEnable) {
      return {
        ok: false,
        failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status },
      } as const;
    }

    const failure = await validateEffectiveState(tx, campaign.id, campaign, now, writer);
    if (failure !== null) return { ok: false, failure } as const;
    await tx.promotionCampaign.update({
      where: { id: campaign.id },
      // Re-enable writes a fresh enabledAt and clears disabledAt, so the enabled interval that
      // decides "ever active" starts now rather than reaching back through the disabled gap.
      data: { isEnabled: true, enabledAt: now, disabledAt: null },
    });

    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: campaign.id, revision } as const;
  });
}

/**
 * Disable a campaign.
 *
 * Deliberately does not expand coverage: disable must stay available even when a PRODUCT target has
 * grown past the expansion bound, because the alternative is a campaign that cannot be switched off.
 * It is the rollback path, so it must never be the thing that fails.
 */
export async function disablePromotionCampaign({
  campaignId,
  now,
  session,
  client = prisma,
}: Omit<PublishInput, "env">): Promise<ActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    // Campaign row next, before its state is read: the decision below must be made on state that
    // cannot change before commit, not on the snapshot a plain read would see.
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, isEnabled: true },
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }
    if (!campaign.isEnabled) {
      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "DISABLED" } } as const;
    }

    await tx.promotionCampaign.update({
      where: { id: campaign.id },
      data: { isEnabled: false, disabledAt: now },
    });

    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: campaign.id, revision } as const;
  });
}

/**
 * End a running campaign early.
 *
 * Effective — it changes what buyers are charged from this instant — so it advances the revision.
 * Like disable it is deliberately bounded to the campaign row: it can only ever *shrink* a window,
 * which can remove overlaps but never create one, so re-expanding coverage would be work that
 * cannot change the answer and could fail on a campaign that has grown past the bound.
 */
export async function endPromotionCampaignEarly({
  campaignId,
  now,
  session,
  client = prisma,
}: Omit<PublishInput, "env">): Promise<ActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    // Campaign row next, before its state is read: the decision below must be made on state that
    // cannot change before commit, not on the snapshot a plain read would see.
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: campaignFacts,
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }

    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
    if (lifecycle.status !== "ACTIVE") {
      return {
        ok: false,
        failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status },
      } as const;
    }

    // The campaign stays enabled and simply ends. Disabling instead would lose the distinction
    // between "this ran and finished" and "an admin switched it off", which is what decides whether
    // re-enable or Copy is the legal next move.
    await tx.promotionCampaign.update({
      where: { id: campaign.id },
      data: { endsAt: now },
    });

    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: campaign.id, revision } as const;
  });
}

/**
 * The fields a material edit may change. Absent means unchanged; `null` is a real value for the
 * nullable ones, which is why this is keyed on presence rather than on nullishness.
 */
export type CampaignPatch = Readonly<{
  name?: string;
  kind?: PromotionCampaignKind;
  discountType?: PromotionDiscountType;
  percentageValue?: number | null;
  fixedPriceVnd?: bigint | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** Replace-all. Absent leaves the existing target rows untouched. */
  targets?: readonly CampaignTargetInput[];
}>;

export type EditInput = PublishInput & Readonly<{ patch: CampaignPatch }>;

function applyPatch(campaign: CampaignFacts, patch: CampaignPatch) {
  return {
    kind: patch.kind ?? campaign.kind,
    name: patch.name ?? campaign.name,
    discountType: patch.discountType ?? campaign.discountType,
    percentageValue: "percentageValue" in patch ? patch.percentageValue ?? null : campaign.percentageValue,
    fixedPriceVnd: "fixedPriceVnd" in patch ? patch.fixedPriceVnd ?? null : campaign.fixedPriceVnd,
    startsAt: "startsAt" in patch ? patch.startsAt ?? null : campaign.startsAt,
    endsAt: "endsAt" in patch ? patch.endsAt ?? null : campaign.endsAt,
    targets: patch.targets ?? campaign.targets,
  };
}

async function writePatch(tx: Tx, campaignId: string, patch: CampaignPatch): Promise<void> {
  const { targets, ...scalars } = patch;
  if (Object.keys(scalars).length > 0) {
    await tx.promotionCampaign.update({ where: { id: campaignId }, data: scalars });
  }
  if (targets === undefined) return;
  // Replace-all rather than diff: the target set is small and bounded, and a diff would be a second
  // place for the one-scope-per-row rule to be enforced.
  await tx.promotionTarget.deleteMany({ where: { campaignId } });
  await tx.promotionTarget.createMany({
    data: targets.map((target) => ({
      campaignId,
      productId: target.productId,
      variantId: target.variantId,
    })),
  });
}

/**
 * A material edit to a Scheduled campaign.
 *
 * Scheduled means enabled but not yet started, so the edit changes money nobody has been charged
 * yet but everybody will be — which makes it effective, and makes it subject to exactly the same
 * validation and overlap rules as the publish that created it. The candidate state is validated
 * *before* it is written, so a refused edit leaves the stored campaign untouched.
 *
 * A running campaign is not editable here. Changing the price of something buyers are looking at
 * right now is a different decision with different audit consequences; ending it early and
 * publishing a replacement is the supported path.
 */
export async function editScheduledPromotionCampaign({
  campaignId,
  now,
  session,
  patch,
  client = prisma,
  env = process.env,
  writer,
}: EditInput): Promise<ActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };
  if (!isPromotionActivationEnabled(env)) {
    return { ok: false, failure: { reason: "ACTIVATION_DISABLED" } };
  }

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    // Campaign row next, before its state is read: the decision below must be made on state that
    // cannot change before commit, not on the snapshot a plain read would see.
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: campaignFacts,
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }

    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
    if (lifecycle.status !== "SCHEDULED") {
      return {
        ok: false,
        failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status },
      } as const;
    }

    const bounds = validateDraftInput(patch);
    if (!bounds.ok) {
      return { ok: false, failure: { reason: "INVALID_DRAFT_INPUT", errors: bounds.errors } } as const;
    }

    const failure = await validateEffectiveState(tx, campaign.id, applyPatch(campaign, patch), now, writer);
    if (failure !== null) return { ok: false, failure } as const;

    await writePatch(tx, campaign.id, patch);

    const revision = await advanceRevision(tx, currentRevision);
    return { ok: true, campaignId: campaign.id, revision } as const;
  });
}

/**
 * Edit a Draft.
 *
 * Not effective: a Draft is never storefront-effective, so this must **not** advance the revision.
 * Advancing it here would invalidate every Merchant cache entry every time an admin saved a
 * half-finished form. For the same reason the patch is not validated — a Draft may legitimately be
 * incomplete or business-invalid at rest, and activation is where that gets enforced.
 */
export async function editDraftPromotionCampaign({
  campaignId,
  now,
  session,
  patch,
  client = prisma,
}: Omit<EditInput, "env">): Promise<ActivationOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  // Bounds first, outside the transaction: an oversized name or identifier is refused before a
  // connection is taken, not after a lookup has already been sent with it.
  const bounds = validateDraftInput(patch);
  if (!bounds.ok) {
    return { ok: false, failure: { reason: "INVALID_DRAFT_INPUT", errors: bounds.errors } };
  }

  if (patch.targets !== undefined) {
    const seen = new Set<string>();
    for (const target of patch.targets) {
      const key = target.productId !== null ? `p:${target.productId}` : `v:${target.variantId}`;
      if (seen.has(key)) {
        return { ok: false, failure: { reason: "DUPLICATE_TARGET" } };
      }
      seen.add(key);
    }
  }

  return client.$transaction(async (tx) => {
    // The campaign row is locked before its lifecycle is read, so "this is a Draft" is a fact that
    // holds until commit rather than an observation a concurrent publish can invalidate. Without it
    // a publish committing in between would leave this write landing a material change — discount,
    // window, targets — on an enabled campaign, with no activation validation and no revision
    // advance: a lost update against the durable pricing contract.
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: campaignFacts,
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }

    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
    if (lifecycle.status !== "DRAFT") {
      return {
        ok: false,
        failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status },
      } as const;
    }

    await writePatch(tx, campaign.id, patch);

    // Read back rather than reuse the pre-write value: this path takes no revision lock, so the
    // number it reports is a snapshot, not a claim that it advanced anything.
    const [row] = await tx.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}
    `;
    return { ok: true, campaignId: campaign.id, revision: row?.revision ?? BigInt(0) } as const;
  });
}

export type CreateDraftInput = Readonly<{
  name: string;
  kind?: PromotionCampaignKind;
  discountType?: PromotionDiscountType;
  percentageValue?: number | null;
  fixedPriceVnd?: bigint | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  targets?: readonly CampaignTargetInput[];
  session: AdminSessionCandidate;
  client?: PrismaClient;
}>;

/**
 * Create a new Draft campaign.
 *
 * Non-effective: a Draft is never storefront-effective, so this does NOT advance the revision.
 * Non-expanding: targets are stored verbatim without variant expansion.
 * Re-authorizes on the server and validates input bounds and target uniqueness before persisting.
 */
export async function createDraftPromotionCampaign({
  name,
  kind = "PROMOTION",
  discountType = "PERCENTAGE",
  percentageValue = null,
  fixedPriceVnd = null,
  startsAt = null,
  endsAt = null,
  targets = [],
  session,
  client = prisma,
}: CreateDraftInput): Promise<ActivationOutcome> {
  authorize(session);

  const bounds = validateDraftInput({ name, targets });
  if (!bounds.ok) {
    return { ok: false, failure: { reason: "INVALID_DRAFT_INPUT", errors: bounds.errors } };
  }

  const seenTargets = new Set<string>();
  for (const target of targets) {
    const key = target.productId !== null ? `p:${target.productId}` : `v:${target.variantId}`;
    if (seenTargets.has(key)) {
      return { ok: false, failure: { reason: "DUPLICATE_TARGET" } };
    }
    seenTargets.add(key);
  }

  return client.$transaction(async (tx) => {
    const campaign = await tx.promotionCampaign.create({
      data: {
        kind,
        name: name.trim(),
        discountType,
        percentageValue,
        fixedPriceVnd,
        startsAt,
        endsAt,
        isEnabled: false,
        enabledAt: null,
        disabledAt: null,
        targets: {
          create: targets.map((target) => ({
            productId: target.productId,
            variantId: target.variantId,
          })),
        },
      },
      select: { id: true },
    });

    const [row] = await tx.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}
    `;
    return { ok: true, campaignId: campaign.id, revision: row?.revision ?? BigInt(0) } as const;
  });
}

export type CopyOutcome =
  | Readonly<{ ok: true; campaignId: string; revision: bigint }>
  | Readonly<{ ok: false; failure: ActivationFailure }>;

/**
 * Copy a campaign to a new Draft.
 *
 * Non-expanding and non-effective. Target **rows** are copied verbatim, so a PRODUCT target stays
 * one row rather than becoming a frozen list of the variants it happens to cover today — copying a
 * campaign whose product has since grown past the expansion bound therefore still works, and the
 * copy tracks the catalog exactly as the original did. Nothing about a Draft can charge anybody, so
 * the revision is left alone.
 */
export async function copyPromotionCampaign({
  campaignId,
  session,
  client = prisma,
}: Omit<PublishInput, "env" | "now">): Promise<CopyOutcome> {
  authorize(session);
  const unbounded = refuseUnboundedCampaignId(campaignId);
  if (unbounded !== null) return { ok: false, failure: unbounded };

  return client.$transaction(async (tx) => {
    // Locked so the snapshot is of one coherent state rather than of a campaign mid-edit.
    await lockRows(tx, "PromotionCampaign", [campaignId]);

    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: campaignFacts,
    });
    if (campaign === null) {
      return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    }

    const copy = await tx.promotionCampaign.create({
      data: {
        kind: campaign.kind,
        name: buildCopyCampaignName(campaign.name),
        discountType: campaign.discountType,
        percentageValue: campaign.percentageValue,
        fixedPriceVnd: campaign.fixedPriceVnd,
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        // A copy always starts as a Draft, whatever the source was doing.
        isEnabled: false,
        enabledAt: null,
        disabledAt: null,
        targets: {
          create: campaign.targets.map((target) => ({
            productId: target.productId,
            variantId: target.variantId,
          })),
        },
      },
      select: { id: true },
    });

    const [row] = await tx.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}
    `;
    return { ok: true, campaignId: copy.id, revision: row?.revision ?? BigInt(0) } as const;
  });
}
