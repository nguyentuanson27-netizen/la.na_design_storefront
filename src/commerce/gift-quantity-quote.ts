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
  readActiveGiftQuantityCampaigns,
  readScopeProductFacts,
  type ActiveGiftQuantityCampaign,
  type GiftQuantityCandidateReadClient,
} from "./gift-quantity-candidate-repository.ts";
import { buildScopeResolver, type ScopeProductFacts } from "./gift-quantity-scope.ts";
import {
  isValidTierConfig,
  orderValueTierInputSubtotal,
  priceStack,
  STACK_LINE_KEY_PATTERN,
  type StackDroppedCampaign,
  type StackedGroup,
  type StackInputLine,
  type StackLegacyCampaign,
  type StackLegacyConsent,
  type StackPeer,
  type StackTierParticipant,
} from "./gift-quantity-stack.ts";
import type { QuantityTierConfig, TierDiscountUnit } from "./gift-quantity-tier.ts";
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

/**
 * How far the cart is from the next rung of an order-value ladder (a "spend X more to take Y off" nudge).
 * Only ever produced for a ladder that would genuinely apply on this cart: one that would be dropped for
 * not being allowed to stack with what the cart already carries is never advertised.
 */
export type OrderValueProgress = Readonly<{
  campaignId: string;
  /** The paid order value the ladder is judged on, at its place in the chain (after every other step). */
  currentVnd: number;
  /** The highest rung already reached, or `null` before the first. */
  reachedThresholdVnd: number | null;
  next: Readonly<{ thresholdVnd: number; unit: TierDiscountUnit; value: number; shortfallVnd: number }>;
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
      /** Admin-given names of those campaigns, for display only (never part of any proof). */
      campaignNames: ReadonlyMap<string, string>;
      /** Display only: the next rung of each order-value ladder that could still apply. Never part of a proof. */
      orderValueProgress: readonly OrderValueProgress[];
    }>
  | Readonly<{ enabled: true; ok: false; reason: "LOOKUP_FAILED" | "INPUT_INVALID" }>;

/** Reads the consents legacy campaigns have given to stack (GQ09a). Absent consent = not stackable. */
export type LegacyConsentReader = (campaignIds: readonly string[]) => Promise<StackLegacyConsent>;

export const readNoLegacyConsents: LegacyConsentReader = async () => new Map();

function tierConfigOf(record: ActiveGiftQuantityCampaign["campaign"]): QuantityTierConfig {
  return {
    // NULL is a ladder written before the order-value basis existed: it counts units.
    ...(record.tierBasis === "ORDER_SUBTOTAL" ? { basis: "ORDER_SUBTOTAL" as const } : {}),
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

/** A cart item as the cart repository receives it, before any availability decision. */
export type QuoteCartItem = Readonly<{ variantId: string; quantity: number }>;

/** The most distinct lines a cart quote accepts; the same bound the anonymous cart enforces. */
export const MAX_QUOTE_CART_ITEMS = 50;
/** PostgreSQL INTEGER, the domain a stored cart quantity lives in. */
export const MAX_QUOTE_ITEM_QUANTITY = 2_147_483_647;

/**
 * Validates the RAW cart items a quote is asked for, before availability filtering can hide a
 * defect (an unavailable duplicate or a zero quantity would otherwise just drop out of the quote).
 *
 * Rules, all required: an array of at most `MAX_QUOTE_CART_ITEMS` entries; each `variantId` a
 * well-formed line key (`STACK_LINE_KEY_PATTERN`, the same token the stack uses as its line key);
 * every `variantId` unique across the list; each `quantity` a positive safe integer no greater than
 * `MAX_QUOTE_ITEM_QUANTITY`. An empty list is valid (an empty cart). Pure; reads nothing and echoes
 * nothing of the input.
 */
export function validateQuoteCartItems(items: unknown): items is readonly QuoteCartItem[] {
  if (!Array.isArray(items) || items.length > MAX_QUOTE_CART_ITEMS) return false;
  const seen = new Set<string>();
  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) return false;
    const { variantId, quantity } = item as { variantId?: unknown; quantity?: unknown };
    if (typeof variantId !== "string" || !STACK_LINE_KEY_PATTERN.test(variantId) || seen.has(variantId)) return false;
    seen.add(variantId);
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUOTE_ITEM_QUANTITY) return false;
  }
  return true;
}

function validConsents(consents: StackLegacyConsent): boolean {
  if (!(consents instanceof Map)) return false;
  for (const [id, consent] of consents) {
    if (typeof id !== "string" || !Number.isSafeInteger(consent.priority)) return false;
  }
  return true;
}

/** An order-value ladder forced to apply to any non-empty cart, to ask the stack whether it may stack. */
const FORCED_ORDER_LADDER: QuantityTierConfig = {
  basis: "ORDER_SUBTOTAL", unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 1, discountValue: 1 }],
};

function readOrderValueProgress({
  tierCampaigns,
  tiers,
  stackLines,
  legacyConsents,
  result,
}: Readonly<{
  tierCampaigns: readonly ActiveGiftQuantityCampaign[];
  tiers: readonly StackTierParticipant[];
  stackLines: readonly StackInputLine[];
  legacyConsents: StackLegacyConsent;
  result: Extract<ReturnType<typeof priceStack>, { ok: true }>;
}>): readonly OrderValueProgress[] {
  const dropped = new Set(result.dropped.map((entry) => entry.campaignId));
  const progress: OrderValueProgress[] = [];
  for (const entry of tierCampaigns) {
    const config = tierConfigOf(entry.campaign);
    const id = entry.campaign.id;
    if (config.basis !== "ORDER_SUBTOTAL" || dropped.has(id) || !isValidTierConfig(config)) continue;

    const currentVnd = orderValueTierInputSubtotal(result.groups, id, tiers.filter((tier) => tier.config.basis === "ORDER_SUBTOTAL").map((tier) => ({ id: tier.id, priority: tier.priority })));
    if (!Number.isSafeInteger(currentVnd)) continue;

    const rungs = [...config.tiers].sort((a, b) => a.minQuantity - b.minQuantity);
    const reached = [...rungs].reverse().find((rung) => rung.minQuantity <= currentVnd) ?? null;
    const next = rungs.find((rung) => rung.minQuantity > currentVnd);
    if (next === undefined) continue; // already on the top rung: nothing left to advertise

    // A ladder still under its first rung took no part in conflict detection, so the real run cannot say
    // whether it may stack with this cart. Ask the same engine with the ladder forced on: if it would be
    // set aside, promising it would be a promise the checkout then breaks.
    if (reached === null) {
      const forced = priceStack({
        lines: stackLines,
        tiers: tiers.map((tier) => (tier.id === id ? { ...tier, config: FORCED_ORDER_LADDER } : tier)),
        legacyConsents,
      });
      if (!forced.ok || forced.dropped.some((entry) => entry.campaignId === id)) continue;
    }

    progress.push(Object.freeze({
      campaignId: id,
      currentVnd,
      reachedThresholdVnd: reached === null ? null : reached.minQuantity,
      next: Object.freeze({ thresholdVnd: next.minQuantity, unit: config.unit, value: next.discountValue, shortfallVnd: next.minQuantity - currentVnd }),
    }));
  }
  return progress.sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
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
    return { enabled: true, ok: true, groups: [], subtotalVnd: 0, dropped: [], campaignRevisions: new Map(), campaignNames: new Map(), orderValueProgress: [] };
  }

  const productIds = [...new Set(lines.map((line) => line.productId))];
  const legacyIds = [...new Set(lines.flatMap((line) => (line.legacy === null ? [] : [line.legacy.campaign.id])))];

  // Every read boundary -- active campaigns, scope facts, legacy consents -- is inside this one
  // try. Anything those reads throw (a database or transport error, a bound exceeded, a failing
  // injected reader) is an abnormal read and becomes the typed LOOKUP_FAILED. The caught cause is
  // deliberately discarded: it may carry connection details, and callers need only the reason.
  // It is never converted into "no tier applies" or a legacy-priced paid quote. Only these I/O
  // calls are covered; the pure computation after them is not, so a programming error there
  // still throws instead of being reported as an outage.
  let tierCampaigns: ActiveGiftQuantityCampaign[];
  let facts: readonly ScopeProductFacts[] = [];
  let legacyConsents: StackLegacyConsent = new Map();
  try {
    const lookup = await readActiveGiftQuantityCampaigns({ now, productIds, client, env });
    if (!lookup.enabled) return { enabled: false };
    // Gift campaigns are read by the same bounded lookup but price nothing here (GQ10).
    tierCampaigns = lookup.campaigns.filter((entry) => entry.campaign.kind === "QUANTITY_TIER");
    if (tierCampaigns.length > 0) {
      facts = await readScopeProductFacts({ productIds, client });
      if (legacyIds.length > 0) legacyConsents = await readLegacyConsents(legacyIds);
    }
  } catch {
    return { enabled: true, ok: false, reason: "LOOKUP_FAILED" };
  }
  const factsByProduct = new Map(facts.map((fact) => [fact.productId, fact]));
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

  const orderValueProgress = readOrderValueProgress({ tierCampaigns, tiers, stackLines, legacyConsents, result });

  return {
    enabled: true,
    ok: true,
    groups: result.groups,
    subtotalVnd: result.subtotalVnd,
    dropped: result.dropped,
    campaignRevisions: new Map(tierCampaigns.map((entry) => [entry.campaign.id, entry.campaign.revision])),
    campaignNames: new Map(tierCampaigns.map((entry) => [entry.campaign.id, entry.campaign.name])),
    orderValueProgress,
  };
}
