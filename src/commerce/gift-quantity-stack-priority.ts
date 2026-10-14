/**
 * Stack priority is a position in the price chain: lower runs first, and it must be unique among
 * the campaigns that are or will be effective (ADR 0016 D-01, spec R-01), otherwise the order would
 * depend on row order. This is the one shared check; the lifecycle service (tier publish) and the
 * legacy consent writer both call it inside their revision-locked transaction.
 */

import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import type { Tx } from "./promotion-activation-service.ts";

/** Same bound as the `stackPriority` database checks. */
export const MAX_STACK_PRIORITY = 1_000_000;

/** True when another effective-or-pending stacking campaign already uses `priority`. */
export async function hasStackPriorityConflict(
  tx: Pick<Tx, "giftQuantityCampaign" | "legacyPromotionStackConsent">,
  input: Readonly<{
    /** The campaign being written; excluded from the tier lookup. */
    campaignId: string;
    priority: number;
    now: Date;
    /** When the writer is a legacy campaign, its own consent row is not a conflict with itself. */
    ignoreLegacyCampaignId?: string;
  }>,
): Promise<boolean> {
  const notEnded = [{ endsAt: null }, { endsAt: { gt: input.now } }];
  const tier = await tx.giftQuantityCampaign.findFirst({
    where: {
      id: { not: input.campaignId },
      // A gift never changes a price, so its priority orders nothing and cannot collide.
      kind: "QUANTITY_TIER",
      isEnabled: true,
      stackingEnabled: true,
      stackPriority: input.priority,
      OR: notEnded,
    },
    select: { id: true },
  });
  if (tier !== null) return true;
  const legacy = await tx.legacyPromotionStackConsent.findFirst({
    where: {
      stackPriority: input.priority,
      ...(input.ignoreLegacyCampaignId === undefined ? {} : { campaignId: { not: input.ignoreLegacyCampaignId } }),
      campaign: { isEnabled: true, OR: notEnded },
    },
    select: { campaignId: true },
  });
  return legacy !== null;
}

export type StackPriorityPreflight = "AVAILABLE" | "CONFLICT" | "INVALID";

/**
 * The admin form's read-only "is this priority free?" check (GQ09b). Advisory only: publish and
 * Scheduled edits re-check the same priority under the pricing revision lock.
 *
 * The inputs are `unknown` on purpose. This runs behind an exported Server Action, so the caller's
 * TypeScript types prove nothing at runtime: anything that is not a safe integer priority in range,
 * and a campaign id that is neither `null` (create) nor a bounded string naming an existing tier
 * campaign, is `INVALID` -- decided before the database is touched, and never an exception.
 */
export async function preflightStackPriority(
  client: Pick<Tx, "giftQuantityCampaign" | "legacyPromotionStackConsent">,
  input: Readonly<{ priority: unknown; campaignId: unknown; now: Date }>,
): Promise<StackPriorityPreflight> {
  const { priority, campaignId } = input;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0 || priority > MAX_STACK_PRIORITY) return "INVALID";
  if (campaignId !== null && (typeof campaignId !== "string" || !isBoundedPromotionIdentifier(campaignId))) return "INVALID";
  if (campaignId !== null) {
    const campaign = await client.giftQuantityCampaign.findUnique({ where: { id: campaignId }, select: { kind: true } });
    if (campaign?.kind !== "QUANTITY_TIER") return "INVALID";
  }
  const conflict = await hasStackPriorityConflict(client, { campaignId: campaignId ?? "", priority, now: input.now });
  return conflict ? "CONFLICT" : "AVAILABLE";
}
