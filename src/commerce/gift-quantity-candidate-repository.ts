/**
 * Reads the gift / quantity-tier campaigns that can apply to a cart (GQ04).
 *
 * This is the membership half of the new rules, the counterpart of
 * `promotion-candidate-repository.ts` for the legacy ones. It is gated first: with
 * `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` OFF it returns an empty result **without touching the
 * database**, so a disabled feature costs nothing and cannot influence any quote.
 *
 * Bounded on every axis because it runs on cart and checkout paths: a bounded number of active
 * campaigns (more than the bound fails closed rather than silently dropping a campaign), and
 * frozen-set membership looked up only for the products actually in the cart, never the whole set.
 * It never decides between campaigns; stacking and priority belong to the pricing orchestrator.
 */

import { prisma } from "../db/prisma.ts";
import type { Prisma } from "../generated/prisma/client.ts";

import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import type { FrozenProductSet, ScopeConfig, ScopeProductFacts } from "./gift-quantity-scope.ts";
import { deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";

export const MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS = 50;
export const MAX_CANDIDATE_PRODUCTS_PER_LOOKUP = 200;

export class GiftQuantityCandidateLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiftQuantityCandidateLookupError";
  }
}

/** The one selection both the candidate read and the lifecycle service use, so they cannot drift. */
export const giftQuantityCampaignSelection = {
  id: true,
  kind: true,
  name: true,
  startsAt: true,
  endsAt: true,
  isEnabled: true,
  enabledAt: true,
  disabledAt: true,
  revision: true,
  stackPriority: true,
  stackingEnabled: true,
  scopeMode: true,
  categoryKeys: true,
  frozenAt: true,
  frozenCampaignRevision: true,
  giftTrigger: true,
  minimumQuantity: true,
  minimumSubtotalVnd: true,
  subtotalScope: true,
  awardMode: true,
  maxGiftsPerOrder: true,
  allowDuplicateGifts: true,
  tierUnit: true,
  tierDiscountedUnits: true,
  tierSelectionPriority: true,
  targets: { select: { productId: true, role: true } },
  tiers: { select: { minQuantity: true, discountValue: true }, orderBy: { minQuantity: "asc" } },
  giftOptions: { select: { variantId: true } },
  stackPeers: { select: { peerKind: true, peerCampaignId: true } },
} satisfies Prisma.GiftQuantityCampaignSelect;

export type GiftQuantityCampaignRecord = Prisma.GiftQuantityCampaignGetPayload<{ select: typeof giftQuantityCampaignSelection }>;
type CampaignRecord = GiftQuantityCampaignRecord;

/** The subset of the client this lookup needs, so a transaction client can be passed. */
export type GiftQuantityCandidateReadClient = {
  giftQuantityCampaign: { findMany: (args: unknown) => Promise<CampaignRecord[]> };
  giftQuantityFrozenProduct: {
    findMany: (args: unknown) => Promise<Array<{ campaignId: string; productId: string }>>;
  };
  productCategoryMembership: {
    findMany: (args: unknown) => Promise<Array<{ productId: string; categoryKey: string }>>;
  };
};

export type ActiveGiftQuantityCampaign = Readonly<{
  campaign: CampaignRecord;
  scope: ScopeConfig;
  /**
   * Fixed scopes: the frozen products that are in this cart, with the audit of the snapshot. Empty
   * for other modes. Only cart products are listed because that is all evaluation asks about.
   */
  frozen: FrozenProductSet | null;
}>;

export type GiftQuantityCandidateLookup = Readonly<{
  /** false when the gate is OFF; nothing was read. */
  enabled: boolean;
  campaigns: readonly ActiveGiftQuantityCampaign[];
}>;

const DISABLED_LOOKUP: GiftQuantityCandidateLookup = Object.freeze({ enabled: false, campaigns: Object.freeze([]) });

function scopeOf(record: CampaignRecord): ScopeConfig {
  if (record.scopeMode === "GLOBAL_ALL_PAID_LINES") return { mode: "GLOBAL_ALL_PAID_LINES" };
  return {
    mode: record.scopeMode,
    categoryKeys: record.categoryKeys,
    includeProductIds: record.targets.filter((target) => target.role === "INCLUDE").map((target) => target.productId),
    excludeProductIds: record.targets.filter((target) => target.role === "EXCLUDE").map((target) => target.productId),
  };
}

export async function readActiveGiftQuantityCampaigns({
  now,
  productIds,
  client = prisma as unknown as GiftQuantityCandidateReadClient,
  env = process.env,
}: Readonly<{
  now: Date;
  /** Distinct products in the cart; bounds the frozen-set lookup. */
  productIds: readonly string[];
  client?: GiftQuantityCandidateReadClient;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<GiftQuantityCandidateLookup> {
  if (!isGiftQuantityPromotionsEnabled(env)) return DISABLED_LOOKUP;

  if (!Array.isArray(productIds)) {
    throw new GiftQuantityCandidateLookupError("Gift/quantity candidate lookup needs a product list");
  }
  // Bounded by *distinct* products: the same product on 201 cart lines is a valid cart.
  const requested = [...new Set(productIds)];
  if (requested.length > MAX_CANDIDATE_PRODUCTS_PER_LOOKUP) {
    throw new GiftQuantityCandidateLookupError(
      `Gift/quantity candidate lookup is bounded to ${MAX_CANDIDATE_PRODUCTS_PER_LOOKUP} products per call`,
    );
  }

  // The window is filtered here as a cheap pre-filter and then decided by the lifecycle derivation,
  // which owns the half-open interval contract; the two can never disagree in a harmful direction
  // because the derivation is applied to every row that survives the filter.
  const records = await client.giftQuantityCampaign.findMany({
    where: {
      isEnabled: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    select: giftQuantityCampaignSelection,
    orderBy: [{ stackPriority: "asc" }, { id: "asc" }],
    take: MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS + 1,
  });
  if (records.length > MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS) {
    throw new GiftQuantityCandidateLookupError("Too many active gift/quantity campaigns to evaluate safely");
  }

  const active = records.filter((record) => deriveCampaignLifecycle({ ...record, now }).status === "ACTIVE");

  const fixedIds = active.filter((record) => record.scopeMode === "FIXED_PRODUCT_SET").map((record) => record.id);
  const frozenByCampaign = new Map<string, string[]>();
  if (fixedIds.length > 0 && requested.length > 0) {
    const rows = await client.giftQuantityFrozenProduct.findMany({
      where: { campaignId: { in: fixedIds }, productId: { in: requested } },
      select: { campaignId: true, productId: true },
    });
    for (const row of rows) {
      const list = frozenByCampaign.get(row.campaignId);
      if (list === undefined) frozenByCampaign.set(row.campaignId, [row.productId]);
      else list.push(row.productId);
    }
  }

  return Object.freeze({
    enabled: true,
    campaigns: Object.freeze(
      active.map((record): ActiveGiftQuantityCampaign => ({
        campaign: record,
        scope: scopeOf(record),
        // A Fixed campaign that was never frozen has no snapshot and no audit to invent: `null`
        // makes the scope match nothing (fail closed).
        frozen:
          record.scopeMode === "FIXED_PRODUCT_SET" && record.frozenAt !== null && record.frozenCampaignRevision !== null
            ? {
                productIds: frozenByCampaign.get(record.id) ?? [],
                frozenAt: record.frozenAt,
                campaignRevision: record.frozenCampaignRevision,
              }
            : null,
      })),
    ),
  });
}

/**
 * Category membership for the cart's products, in the shape the scope resolver reads. Dynamic scopes
 * evaluate against this at the time of the call, so a membership change is visible immediately.
 *
 * Not gated by itself: callers reach it only after `readActiveGiftQuantityCampaigns` reported
 * `enabled`, so a disabled feature still costs nothing.
 */
export async function readScopeProductFacts({
  productIds,
  client = prisma as unknown as GiftQuantityCandidateReadClient,
}: Readonly<{
  productIds: readonly string[];
  client?: GiftQuantityCandidateReadClient;
}>): Promise<readonly ScopeProductFacts[]> {
  if (!Array.isArray(productIds)) {
    throw new GiftQuantityCandidateLookupError("Scope facts lookup needs a product list");
  }
  const requested = [...new Set(productIds)];
  if (requested.length > MAX_CANDIDATE_PRODUCTS_PER_LOOKUP) {
    throw new GiftQuantityCandidateLookupError(
      `Scope facts lookup is bounded to ${MAX_CANDIDATE_PRODUCTS_PER_LOOKUP} products per call`,
    );
  }
  if (requested.length === 0) return [];

  const rows = await client.productCategoryMembership.findMany({
    where: { productId: { in: requested } },
    select: { productId: true, categoryKey: true },
  });
  const byProduct = new Map<string, string[]>(requested.map((id) => [id, []]));
  for (const row of rows) byProduct.get(row.productId)?.push(row.categoryKey);
  return requested.map((productId) => ({ productId, categoryKeys: byProduct.get(productId) ?? [] }));
}
