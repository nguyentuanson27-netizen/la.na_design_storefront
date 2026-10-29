import { readListPriceConfig } from "./list-price-config.ts";
/**
 * Runtime campaign health, derived from pricing outcomes.
 *
 * A campaign is not simply valid or invalid at runtime. Catalog drift affects individual variants:
 * one variant's base price becomes unusable, another gets covered by a second campaign, the rest are
 * fine. The reviewed contract is that healthy siblings keep their promotion while only the offending
 * variant loses it, so health is per variant and the campaign-level status summarises it.
 *
 * Nothing is stored. Health is recomputed from current outcomes, which is what makes recovery
 * automatic: a variant that becomes valid again during the campaign interval is simply healthy on
 * the next read, with no repair write and no chance of a stale invalid flag outliving its cause.
 *
 * No money appears here. This feeds an admin diagnostic, and a report that carried prices would be
 * a second place for pricing to be read from.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import { prisma } from "../db/prisma.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import {
  isActiveAt,
  resolvePromotionPricing,
  type ApplicablePromotionCampaign,
  type PromotionPricingReason,
} from "./promotion-pricing.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import {
  describeCampaignRuntimeHealth,
  emitPromotionSignal,
  type PromotionRuntimeHealthSignal,
  type PromotionSignalWriter,
} from "../operations/promotion-observability.ts";

/** Bounded so one broken catalog import cannot turn a diagnostic into an unbounded payload. */
export const MAX_REPORTED_AFFECTED_VARIANTS = 50;

export type VariantPricingOutcome = Readonly<{
  variantId: string;
  isDiscounted: boolean;
  reason: PromotionPricingReason | null;
  /** Every campaign competing for this variant, so an admin can see what to change. */
  conflictingCampaignIds: readonly string[];
}>;

export type AffectedVariant = Readonly<{
  variantId: string;
  reason: PromotionPricingReason | null;
  conflictingCampaignIds: readonly string[];
}>;

export type CampaignRuntimeStatus =
  /** Every currently covered variant takes the promotion. */
  | "HEALTHY"
  /** Some covered variants take it and some cannot; the healthy ones continue. */
  | "PARTIALLY_INVALID"
  /** No covered variant can take it right now. */
  | "FULLY_INVALID"
  /** The campaign currently covers no variant at all. */
  | "NO_COVERAGE";

export type CampaignRuntimeHealth = Readonly<{
  campaignId: string;
  status: CampaignRuntimeStatus;
  coveredVariants: number;
  discountedVariants: number;
  affectedVariants: number;
  affected: readonly AffectedVariant[];
  affectedTruncated: boolean;
}>;

type FinalizeCampaignRuntimeHealthInput = Readonly<{
  campaignId: string;
  coveredVariants: number;
  discountedVariants: number;
  affectedVariants: number;
  affected: readonly AffectedVariant[];
  emit?: (signal: PromotionRuntimeHealthSignal) => void;
  writer?: PromotionSignalWriter;
}>;

function finalizeCampaignRuntimeHealth({
  campaignId,
  coveredVariants,
  discountedVariants,
  affectedVariants,
  affected,
  emit,
  writer,
}: FinalizeCampaignRuntimeHealthInput): CampaignRuntimeHealth {
  const status: CampaignRuntimeStatus = coveredVariants === 0
    ? "NO_COVERAGE"
    : affectedVariants === 0
      ? "HEALTHY"
      : discountedVariants === 0
        ? "FULLY_INVALID"
        : "PARTIALLY_INVALID";

  const health = Object.freeze({
    campaignId,
    status,
    coveredVariants,
    discountedVariants,
    affectedVariants,
    affected: Object.freeze([...affected]),
    affectedTruncated: affectedVariants > affected.length,
  });

  try {
    const signal = describeCampaignRuntimeHealth(health);
    if (emit) {
      emit(signal);
    } else if (writer) {
      emitPromotionSignal(signal, writer);
    } else {
      emitPromotionSignal(signal);
    }
  } catch {
    // Observability emission failures are swallowed to protect caller execution.
  }

  return health;
}

export type AssessCampaignRuntimeHealthInput = Readonly<{
  campaignId: string;
  outcomes: readonly VariantPricingOutcome[];
  emit?: (signal: PromotionRuntimeHealthSignal) => void;
  writer?: PromotionSignalWriter;
}>;

export function assessCampaignRuntimeHealth({
  campaignId,
  outcomes,
  emit,
  writer,
}: AssessCampaignRuntimeHealthInput): CampaignRuntimeHealth {
  const affected: AffectedVariant[] = [];
  let discountedVariants = 0;
  let affectedVariants = 0;

  for (const outcome of outcomes) {
    if (outcome.isDiscounted) {
      discountedVariants += 1;
      continue;
    }
    affectedVariants += 1;
    if (affected.length < MAX_REPORTED_AFFECTED_VARIANTS) {
      affected.push(
        Object.freeze({
          variantId: outcome.variantId,
          // The resolver's typed reason is passed through rather than reinterpreted, so an
          // unusable base price stays a base-price problem instead of looking like a promotion defect.
          reason: outcome.reason,
          conflictingCampaignIds: Object.freeze([...outcome.conflictingCampaignIds]),
        }),
      );
    }
  }

  return finalizeCampaignRuntimeHealth({
    campaignId,
    coveredVariants: outcomes.length,
    discountedVariants,
    affectedVariants,
    affected,
    emit,
    writer,
  });
}

export type EvaluateCampaignRuntimeHealthInput = Readonly<{
  campaignId: string;
  client?: Pick<PrismaClient, "promotionCampaign" | "variantMirror"> & {
    promotionTarget?: unknown;
  };
  now?: Date;
  writer?: PromotionSignalWriter;
}>;

/**
 * Evaluates current runtime health on-demand for a persisted, price-effective campaign.
 * Disabled campaigns and enabled campaigns outside their active window have no current pricing
 * effect, so they return unavailable before coverage reads and do not emit a misleading
 * promotion.runtime_health signal. This uses the same `isEnabled` + `isActiveAt` eligibility split
 * as the production candidate/pricing path instead of introducing a second lifecycle rule.
 * Resolves current variant outcomes against the database mirror without coverage truncation,
 * discovers concurrent competing campaign conflicts via candidate batching, invokes the shared
 * health finalizer, and emits promotion.runtime_health signal. Coverage is aggregated one bounded
 * page at a time so catalog growth does not turn an admin diagnostic into unbounded process state.
 * Telemetry failures are swallowed to safeguard caller execution; candidate-authority failures are
 * not, because incomplete promotion truth must never masquerade as HEALTHY.
 */
export async function evaluateCampaignRuntimeHealth({
  campaignId,
  client = prisma,
  now = new Date(),
  writer,
}: EvaluateCampaignRuntimeHealthInput): Promise<CampaignRuntimeHealth | null> {
  const trimmedId = campaignId.trim();
  if (!isBoundedPromotionIdentifier(trimmedId)) return null;

  const campaign = await client.promotionCampaign.findUnique({
    where: { id: trimmedId },
    select: {
      id: true,
      kind: true,
      name: true,
      discountType: true,
      percentageValue: true,
      fixedPriceVnd: true,
      isEnabled: true,
      startsAt: true,
      endsAt: true,
      targets: {
        select: { productId: true, variantId: true },
      },
    },
  });

  if (campaign === null) return null;

  const applicable: ApplicablePromotionCampaign = {
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    discountType: campaign.discountType,
    percentageValue: campaign.percentageValue,
    fixedPriceVnd: campaign.fixedPriceVnd,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
  };

  if (campaign.isEnabled === false || !isActiveAt(applicable, now)) return null;

  const directVariantIds = campaign.targets.flatMap((t) => (t.variantId === null ? [] : [t.variantId]));
  const productIds = campaign.targets.flatMap((t) => (t.productId === null ? [] : [t.productId]));

  const whereClause =
    directVariantIds.length > 0 && productIds.length > 0
      ? { OR: [{ id: { in: directVariantIds } }, { productId: { in: productIds } }] }
      : directVariantIds.length > 0
        ? { id: { in: directVariantIds } }
        : productIds.length > 0
          ? { productId: { in: productIds } }
          : null;

  if (whereClause === null) {
    return finalizeCampaignRuntimeHealth({
      campaignId: campaign.id,
      coveredVariants: 0,
      discountedVariants: 0,
      affectedVariants: 0,
      affected: [],
      writer,
    });
  }

  const hasPromotionTarget =
    "promotionTarget" in client &&
    typeof (client as Record<string, unknown>).promotionTarget === "object" &&
    (client as Record<string, unknown>).promotionTarget !== null;

  const BATCH_SIZE = 500;
  let cursorId: string | undefined = undefined;
  let coveredVariants = 0;
  let discountedVariants = 0;
  let affectedVariants = 0;
  const affected: AffectedVariant[] = [];

  while (true) {
    const batch = (await client.variantMirror.findMany({
      where: whereClause,
      select: { id: true, pancakeRetailPrice: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })) as Array<{ id: string; pancakeRetailPrice: number | null }>;

    if (!Array.isArray(batch) || batch.length === 0) break;

    let competingCampaignsByVariant = new Map<string, readonly ApplicablePromotionCampaign[]>();
    if (hasPromotionTarget) {
      try {
        const lookup = await readApplicablePromotionCampaignsBatched({
          variantIds: batch.map((variant) => variant.id),
          client: client as unknown as Parameters<typeof readApplicablePromotionCampaignsBatched>[0]["client"],
        });
        if (lookup.unknownVariantIds.length > 0) return null;
        competingCampaignsByVariant = new Map(lookup.campaignsByVariantId);
      } catch {
        // Source-data truth is unavailable. Do not emit a partial or falsely healthy diagnostic.
        return null;
      }
    }

    for (const variant of batch) {
      coveredVariants += 1;
      const competing = competingCampaignsByVariant.get(variant.id) ?? [];
      const combinedCandidates = [
        applicable,
        ...competing.filter((candidate) => candidate.id !== applicable.id),
      ];

      const pricing = resolvePromotionPricing({
        campaignBasis: readListPriceConfig().campaignBasis,
        basePriceVnd: variant.pancakeRetailPrice,
        campaigns: combinedCandidates,
        now,
      });

      if (pricing.isDiscounted) {
        discountedVariants += 1;
        continue;
      }

      affectedVariants += 1;
      if (affected.length >= MAX_REPORTED_AFFECTED_VARIANTS) continue;

      const activeOtherCampaigns = combinedCandidates.filter(
        (candidate) => candidate.id !== applicable.id && isActiveAt(candidate, now),
      );
      const conflictingCampaignIds = pricing.reason === "PROMOTION_CONFLICT"
        ? activeOtherCampaigns.map((candidate) => candidate.id)
        : [];

      affected.push(
        Object.freeze({
          variantId: variant.id,
          reason: pricing.reason,
          conflictingCampaignIds: Object.freeze(conflictingCampaignIds),
        }),
      );
    }

    if (batch.length < BATCH_SIZE) break;
    const nextCursorId = batch[batch.length - 1]?.id;
    if (!nextCursorId || nextCursorId === cursorId) {
      // A non-advancing cursor means coverage completeness is unknown; never return a partial health.
      return null;
    }
    cursorId = nextCursorId;
  }

  return finalizeCampaignRuntimeHealth({
    campaignId: campaign.id,
    coveredVariants,
    discountedVariants,
    affectedVariants,
    affected,
    writer,
  });
}
