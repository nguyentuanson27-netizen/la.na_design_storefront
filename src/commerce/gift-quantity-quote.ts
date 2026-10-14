/**
 * Cart-level quantity-tier quote (GQ08).
 *
 * Takes the lines the existing cart repository already priced through the legacy authority and, only
 * when `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` is exactly `"true"`, applies the active tier campaigns
 * on top through the stacking orchestrator. It is deliberately a *separate result* from the legacy
 * per-variant line prices:
 *
 * - With the gate OFF it returns `{ enabled: false }` after reading nothing, so cart output is the
 *   legacy output byte for byte, whatever `LA_PROMOTION_ACTIVATION_ENABLED` says.
 * - A cart-level tier price is never put on a per-variant price rule. The PDP, listings, Merchant
 *   feed and structured data keep reading only the legacy resolver, so a price that exists only
 *   once a cart reaches a quantity can never be published as an unconditional product price.
 * - Failure is explicit and fail-closed: `ok: false` tells the caller the benefits could not be
 *   established; it is never silently converted into "no tier applies".
 *
 * Group keys: a paid group's `lineKey` is always the cart line's `VariantMirror.id`. A tier that
 * splits a line yields `${lineKey}|disc` / `${lineKey}|full` group keys; a line left whole keeps its
 * own key. Nothing that already consumes the cart sees these keys -- `getQuote().lines` is the
 * unchanged legacy projection -- and a consumer that wants a per-line view groups by `lineKey`.
 *
 * Reads are bounded: one active-campaign query, one frozen-set query limited to the cart's
 * products and one membership query for the same products -- a fixed number of statements however
 * many lines the cart has.
 */

import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import {
  GiftQuantityCandidateLookupError,
  readActiveGiftQuantityCampaigns,
  readScopeProductFacts,
  type ActiveGiftQuantityCampaign,
  type GiftQuantityCandidateReadClient,
} from "./gift-quantity-candidate-repository.ts";
import { buildScopeResolver, type ScopeProductFacts } from "./gift-quantity-scope.ts";
import {
  priceStack,
  type StackDroppedCampaign,
  type StackedGroup,
  type StackInputLine,
  type StackLegacyCampaign,
  type StackLegacyConsent,
  type StackPeer,
  type StackTierParticipant,
} from "./gift-quantity-stack.ts";
import type { QuantityTierConfig } from "./gift-quantity-tier.ts";
import type { ApplicablePromotionCampaign } from "./promotion-pricing.ts";

/** A purchasable, priced cart line as the legacy authority resolved it. */
export type QuoteCartLine = Readonly<{
  /** Stable key of the line: the internal `VariantMirror.id`, unique within a cart. */
  variantId: string;
  pancakeVariationId: string;
  /** `ProductMirror.id`, internal; never exposed to a browser. */
  productId: string;
  quantity: number;
  /** `pancakeRetailPrice`, the legacy resolver's starting point. */
  basePriceVnd: number;
  /** The single discounting legacy campaign and the price it produced, if any. */
  legacy: Readonly<{ campaign: ApplicablePromotionCampaign; effectivePriceVnd: number }> | null;
}>;

export type GiftQuantityQuote =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      ok: true;
      groups: readonly StackedGroup[];
      /** Paid merchandise total in whole VND after every step. */
      subtotalVnd: number;
      dropped: readonly StackDroppedCampaign[];
      /** Revisions of the tier campaigns that were evaluated, for quote provenance. */
      campaignRevisions: ReadonlyMap<string, number>;
    }>
  | Readonly<{ enabled: true; ok: false; reason: "LOOKUP_FAILED" | "INPUT_INVALID" }>;

/** Reads the consents legacy campaigns have given to stack (GQ09a). Absent consent = not stackable. */
export type LegacyConsentReader = (campaignIds: readonly string[]) => Promise<StackLegacyConsent>;

export const readNoLegacyConsents: LegacyConsentReader = async () => new Map();

function tierConfigOf(record: ActiveGiftQuantityCampaign["campaign"]): QuantityTierConfig {
  return {
    // An incomplete campaign carries nulls; the tier validator rejects it and the stack drops it
    // with TIER_CONFIG_INVALID rather than pricing from a guess.
    unit: record.tierUnit as QuantityTierConfig["unit"],
    discountedUnits: record.tierDiscountedUnits as QuantityTierConfig["discountedUnits"],
    selectionPriority: record.tierSelectionPriority,
    tiers: record.tiers,
  };
}

function toLegacy(campaign: ApplicablePromotionCampaign): StackLegacyCampaign {
  return {
    id: campaign.id,
    kind: campaign.kind,
    discountType: campaign.discountType,
    percentageValue: campaign.percentageValue,
    fixedPriceVnd: campaign.fixedPriceVnd,
  };
}

function validConsents(consents: StackLegacyConsent): boolean {
  for (const [id, consent] of consents) {
    if (typeof id !== "string" || !Number.isSafeInteger(consent.priority)) return false;
  }
  return true;
}

export async function resolveGiftQuantityQuote({
  lines,
  now,
  client,
  env = process.env,
  readLegacyConsents = readNoLegacyConsents,
}: Readonly<{
  lines: readonly QuoteCartLine[];
  now: Date;
  client?: GiftQuantityCandidateReadClient;
  env?: Readonly<Record<string, string | undefined>>;
  readLegacyConsents?: LegacyConsentReader;
}>): Promise<GiftQuantityQuote> {
  // The gate is decided first and alone: OFF reads nothing and computes nothing.
  if (!isGiftQuantityPromotionsEnabled(env)) return { enabled: false };

  // A cart with nothing purchasable has no paid lines to price; that is a valid, empty quote.
  if (lines.length === 0) {
    return { enabled: true, ok: true, groups: [], subtotalVnd: 0, dropped: [], campaignRevisions: new Map() };
  }

  const productIds = [...new Set(lines.map((line) => line.productId))];
  let tierCampaigns: ActiveGiftQuantityCampaign[];
  let facts: readonly ScopeProductFacts[] = [];
  try {
    const lookup = await readActiveGiftQuantityCampaigns({ now, productIds, client, env });
    if (!lookup.enabled) return { enabled: false };
    // Gift campaigns are read by the same bounded lookup but price nothing here (GQ10).
    tierCampaigns = lookup.campaigns.filter((entry) => entry.campaign.kind === "QUANTITY_TIER");
    if (tierCampaigns.length > 0) facts = await readScopeProductFacts({ productIds, client });
  } catch (error) {
    if (error instanceof GiftQuantityCandidateLookupError) return { enabled: true, ok: false, reason: "LOOKUP_FAILED" };
    throw error;
  }
  const factsByProduct = new Map(facts.map((fact) => [fact.productId, fact]));

  const legacyIds = [...new Set(lines.flatMap((line) => (line.legacy === null ? [] : [line.legacy.campaign.id])))];
  const legacyConsents = legacyIds.length === 0 || tierCampaigns.length === 0 ? new Map() : await readLegacyConsents(legacyIds);
  if (!validConsents(legacyConsents)) return { enabled: true, ok: false, reason: "INPUT_INVALID" };

  const tiers: StackTierParticipant[] = tierCampaigns.map((entry): StackTierParticipant => ({
    id: entry.campaign.id,
    config: tierConfigOf(entry.campaign),
    resolve: buildScopeResolver(entry.scope, entry.frozen),
    priority: entry.campaign.stackPriority,
    stackingEnabled: entry.campaign.stackingEnabled,
    peers: entry.campaign.stackPeers.map((peer): StackPeer => ({ kind: peer.peerKind, campaignId: peer.peerCampaignId })),
  }));

  const stackLines: StackInputLine[] = lines.map((line) => ({
    lineKey: line.variantId,
    pancakeVariationId: line.pancakeVariationId,
    quantity: line.quantity,
    product: factsByProduct.get(line.productId) ?? { productId: line.productId, categoryKeys: [] },
    basePriceVnd: line.basePriceVnd,
    legacy: line.legacy === null ? null : { campaign: toLegacy(line.legacy.campaign), effectivePriceVnd: line.legacy.effectivePriceVnd },
  }));

  const result = priceStack({ lines: stackLines, tiers, legacyConsents });
  if (!result.ok) return { enabled: true, ok: false, reason: "INPUT_INVALID" };

  return {
    enabled: true,
    ok: true,
    groups: result.groups,
    subtotalVnd: result.subtotalVnd,
    dropped: result.dropped,
    campaignRevisions: new Map(tierCampaigns.map((entry) => [entry.campaign.id, entry.campaign.revision])),
  };
}
