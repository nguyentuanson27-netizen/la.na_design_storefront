/**
 * A legacy promotion's consent to stack with quantity-tier campaigns (GQ09a, ADR 0016 D-10).
 *
 * Stacking needs both sides to agree (R-01): a tier lists the legacy campaign as a peer, and the
 * legacy campaign has opted in here with a position in the stack. The legacy campaign row itself is
 * never changed -- consent lives in `LegacyPromotionStackConsent`, so without a row a legacy
 * campaign behaves exactly as before and no tier ever stacks with it.
 *
 * Writing consent changes what a buyer can be charged once a tier references it, so it is gated by
 * `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED`, takes the shared pricing-revision lock and advances the
 * revision (when the campaign is live or pending). *Withdrawing* consent is never gated: it only
 * removes a discount stack, and it must work while the feature is being switched off.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import { prisma } from "../db/prisma.ts";

import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { hasStackPriorityConflict, MAX_STACK_PRIORITY } from "./gift-quantity-stack-priority.ts";
import type { StackLegacyConsent } from "./gift-quantity-stack.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import { advanceRevision, lockRevision, lockRows } from "./promotion-activation-service.ts";
import { deriveCampaignLifecycle, type CampaignLifecycleStatus } from "./promotion-campaign-lifecycle.ts";

export type LegacyConsentFailure =
  | { reason: "FEATURE_DISABLED" }
  | { reason: "CAMPAIGN_NOT_FOUND" }
  | { reason: "ILLEGAL_TRANSITION"; from: CampaignLifecycleStatus }
  | { reason: "INVALID_INPUT"; errors: readonly string[] }
  | { reason: "INVALID_RULE"; errors: readonly string[] };

export type LegacyConsentOutcome =
  | Readonly<{ ok: true; campaignId: string; revision: bigint; changed: boolean }>
  | Readonly<{ ok: false; failure: LegacyConsentFailure }>;

type AdminSessionCandidate =
  | { user: { id: string; role?: string | null }; session: { id: string } }
  | null
  | undefined;

type ConsentInput = Readonly<{
  campaignId: string;
  now: Date;
  session: AdminSessionCandidate;
  client?: PrismaClient;
  env?: Readonly<Record<string, string | undefined>>;
}>;

const MAX_CONSENT_LOOKUP = 200;

/** Reads consents for the given legacy campaigns. One bounded query; absent = not stackable. */
export function createLegacyConsentReader(client: {
  legacyPromotionStackConsent: {
    findMany: (args: unknown) => Promise<Array<{ campaignId: string; stackPriority: number }>>;
  };
}) {
  return async (campaignIds: readonly string[]): Promise<StackLegacyConsent> => {
    const ids = [...new Set(campaignIds)];
    if (ids.length === 0) return new Map();
    if (ids.length > MAX_CONSENT_LOOKUP) throw new Error(`Legacy consent lookup is bounded to ${MAX_CONSENT_LOOKUP} campaigns`);
    const rows = await client.legacyPromotionStackConsent.findMany({
      where: { campaignId: { in: ids } },
      select: { campaignId: true, stackPriority: true },
    });
    return new Map(rows.map((row) => [row.campaignId, { priority: row.stackPriority }] as const));
  };
}

/** Opt a legacy campaign in to stacking, or change its position. Gated and revision-advancing. */
export async function setLegacyPromotionStackConsent({
  campaignId,
  stackPriority,
  now,
  session,
  client = prisma,
  env = process.env,
}: ConsentInput & Readonly<{ stackPriority: number }>): Promise<LegacyConsentOutcome> {
  requireAdminSession(session);
  if (!isBoundedPromotionIdentifier(campaignId)) return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] } };
  if (!Number.isSafeInteger(stackPriority) || stackPriority < 0 || stackPriority > MAX_STACK_PRIORITY) {
    return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["STACK_PRIORITY_OUT_OF_RANGE"] } };
  }
  if (!isGiftQuantityPromotionsEnabled(env)) return { ok: false, failure: { reason: "FEATURE_DISABLED" } };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "PromotionCampaign", [campaignId]);
    const campaign = await tx.promotionCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, isEnabled: true, enabledAt: true, disabledAt: true, startsAt: true, endsAt: true },
    });
    if (campaign === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
    // An ended or disabled-after-running campaign can never price again, so consenting is pointless.
    if (lifecycle.isTerminal) return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;

    const existing = await tx.legacyPromotionStackConsent.findUnique({ where: { campaignId } });
    if (existing?.stackPriority === stackPriority) return { ok: true, campaignId, revision: currentRevision, changed: false } as const;

    // Uniqueness is checked as of this transaction; every effective write holds the same lock.
    if (await hasStackPriorityConflict(tx, { campaignId, priority: stackPriority, now, ignoreLegacyCampaignId: campaignId })) {
      return { ok: false, failure: { reason: "INVALID_RULE", errors: ["STACK_PRIORITY_CONFLICT"] } } as const;
    }
    await tx.legacyPromotionStackConsent.upsert({
      where: { campaignId },
      create: { campaignId, stackPriority },
      update: { stackPriority },
    });
    // Only a campaign that can be charging (or about to) changes quotes; a Draft is just config.
    const revision = campaign.isEnabled ? await advanceRevision(tx, currentRevision) : currentRevision;
    return { ok: true, campaignId, revision, changed: true } as const;
  });
}

/** Withdraw consent. Never gated: it only removes a stack. Absent consent is a successful no-op. */
export async function clearLegacyPromotionStackConsent({
  campaignId,
  session,
  client = prisma,
}: Omit<ConsentInput, "now" | "env">): Promise<LegacyConsentOutcome> {
  requireAdminSession(session);
  if (!isBoundedPromotionIdentifier(campaignId)) return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] } };

  return client.$transaction(async (tx) => {
    const currentRevision = await lockRevision(tx);
    await lockRows(tx, "PromotionCampaign", [campaignId]);
    const campaign = await tx.promotionCampaign.findUnique({ where: { id: campaignId }, select: { id: true, isEnabled: true } });
    if (campaign === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    const removed = await tx.legacyPromotionStackConsent.deleteMany({ where: { campaignId } });
    if (removed.count === 0) return { ok: true, campaignId, revision: currentRevision, changed: false } as const;
    const revision = campaign.isEnabled ? await advanceRevision(tx, currentRevision) : currentRevision;
    return { ok: true, campaignId, revision, changed: true } as const;
  });
}
