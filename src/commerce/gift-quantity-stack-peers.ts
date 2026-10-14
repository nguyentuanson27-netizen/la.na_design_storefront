/**
 * Existence check for the peers a tier campaign names (GQ09a). It runs on every Draft write and
 * again at publish, so a typo is reported as input rather than as a foreign-key failure.
 */

import { STACK_PEER_ANY } from "./gift-quantity-stack.ts";
import type { TierRuleInput } from "./gift-quantity-tier-rule.ts";
import type { Tx } from "./promotion-activation-service.ts";

/**
 * Stack peers must be real campaigns of the kind they name, and a campaign can never name itself
 * (the database refuses that too). Existence is checked here so a typo is reported as input, not as
 * a foreign-key failure. `*` names every campaign of a kind, so there is nothing to look up.
 */
export async function invalidStackPeers(
  client: Pick<Tx, "promotionCampaign" | "giftQuantityCampaign">,
  rule: TierRuleInput,
  selfId: string | null,
): Promise<readonly string[]> {
  const errors = new Set<string>();
  const named = rule.peers.filter((peer) => peer.campaignId !== STACK_PEER_ANY);
  const legacy = named.filter((peer) => peer.kind !== "QUANTITY_TIER");
  const tiers = named.filter((peer) => peer.kind === "QUANTITY_TIER");
  if (selfId !== null && tiers.some((peer) => peer.campaignId === selfId)) errors.add("STACK_PEER_SELF");
  if (legacy.length > 0) {
    const found = await client.promotionCampaign.findMany({
      where: { id: { in: legacy.map((peer) => peer.campaignId) } },
      select: { id: true, kind: true },
    });
    const byId = new Map(found.map((row) => [row.id, row.kind as string]));
    if (legacy.some((peer) => byId.get(peer.campaignId) !== peer.kind)) errors.add("STACK_PEER_UNKNOWN");
  }
  const others = tiers.filter((peer) => peer.campaignId !== selfId);
  if (others.length > 0) {
    const found = await client.giftQuantityCampaign.findMany({
      where: { id: { in: others.map((peer) => peer.campaignId) }, kind: "QUANTITY_TIER" },
      select: { id: true },
    });
    const known = new Set(found.map((row) => row.id));
    if (others.some((peer) => !known.has(peer.campaignId))) errors.add("STACK_PEER_UNKNOWN");
  }
  return [...errors];
}
