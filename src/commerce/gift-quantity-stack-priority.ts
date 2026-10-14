/**
 * Stack priority is a position in the price chain: lower runs first, and it must be unique among
 * the campaigns that are or will be effective (ADR 0016 D-01, spec R-01), otherwise the order would
 * depend on row order. This is the one shared check; the lifecycle service (tier publish) and the
 * legacy consent writer both call it inside their revision-locked transaction.
 */

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
