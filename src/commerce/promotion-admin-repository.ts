/**
 * Bounded reads for the promotion admin surface.
 *
 * Read-only by design: every mutation goes through the P4 activation service, which owns
 * authorization, validation, locking and the pricing revision. Nothing here writes.
 *
 * Lifecycle is derived from persisted intent plus the caller's instant rather than read from a
 * status column, so a scheduled window that opened while nobody was looking is reported correctly
 * on the next page load.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import type { PromotionCampaignKind } from "./promotion-pricing.ts";
import {
  deriveCampaignLifecycle,
  type CampaignLifecycleStatus,
} from "./promotion-campaign-lifecycle.ts";
import {
  ADMIN_TARGET_SEARCH_LIMIT,
  MAX_ADMIN_PROMOTION_PAGE_SIZE,
  parseAdminPromotionPageSize,
  parseAdminTargetSearchLimit,
} from "./promotion-admin-feedback.ts";
import {
  isBoundedPromotionIdentifier,
  MAX_PROMOTION_IDENTIFIER_LENGTH,
} from "./promotion-activation.ts";

/** Bounds the operator-supplied search text before it reaches a query. */
const MAX_ADMIN_SEARCH_LENGTH = 120;

export type AdminPromotionCampaignRow = Readonly<{
  id: string;
  name: string;
  kind: PromotionCampaignKind;
  discountType: "PERCENTAGE" | "FIXED_PRICE";
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
  status: CampaignLifecycleStatus;
  canReEnable: boolean;
  isTerminal: boolean;
  targetCount: number;
}>;

export function createPromotionAdminRepository(client: PrismaClient) {
  async function listCampaigns({
    search,
    pageSize = MAX_ADMIN_PROMOTION_PAGE_SIZE,
    now = new Date(),
  }: Readonly<{ search?: string | null; pageSize?: number; now?: Date }> = {}) {
    const take = parseAdminPromotionPageSize(pageSize);
    const trimmed = typeof search === "string" ? search.trim().slice(0, MAX_ADMIN_SEARCH_LENGTH) : "";

    const campaigns = await client.promotionCampaign.findMany({
      where: trimmed.length > 0 ? { name: { contains: trimmed, mode: "insensitive" } } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take,
      select: {
        id: true, name: true, kind: true, discountType: true,
        percentageValue: true, fixedPriceVnd: true,
        startsAt: true, endsAt: true, isEnabled: true, enabledAt: true, disabledAt: true,
        _count: { select: { targets: true } },
      },
    });

    return campaigns.map((campaign): AdminPromotionCampaignRow => {
      const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
      return {
        id: campaign.id,
        name: campaign.name,
        kind: campaign.kind,
        discountType: campaign.discountType,
        percentageValue: campaign.percentageValue,
        fixedPriceVnd: campaign.fixedPriceVnd,
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        status: lifecycle.status,
        canReEnable: lifecycle.canReEnable,
        isTerminal: lifecycle.isTerminal,
        targetCount: campaign._count.targets,
      };
    });
  }

  /** Bounded product search for building a campaign's explicit target list. */
  async function searchTargetProducts({
    shopId,
    search,
    limit = ADMIN_TARGET_SEARCH_LIMIT,
  }: Readonly<{ shopId: number; search?: string | null; limit?: number }>) {
    const take = parseAdminTargetSearchLimit(limit);
    const trimmed = typeof search === "string" ? search.trim().slice(0, MAX_ADMIN_SEARCH_LENGTH) : "";

    return client.productMirror.findMany({
      where: {
        pancakeShopId: shopId,
        isPresent: true,
        isActive: true,
        ...(trimmed.length > 0 ? { name: { contains: trimmed, mode: "insensitive" as const } } : {}),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take,
      select: { id: true, name: true, slug: true },
    });
  }

  /** Bounded variant search for building a campaign's explicit target list. */
  async function searchTargetVariants({
    shopId,
    search,
    limit = ADMIN_TARGET_SEARCH_LIMIT,
  }: Readonly<{ shopId: number; search?: string | null; limit?: number }>) {
    const take = parseAdminTargetSearchLimit(limit);
    const trimmed = typeof search === "string" ? search.trim().slice(0, MAX_ADMIN_SEARCH_LENGTH) : "";

    return client.variantMirror.findMany({
      where: {
        product: {
          pancakeShopId: shopId,
          isPresent: true,
        },
        isPresent: true,
        ...(trimmed.length > 0
          ? {
              OR: [
                { sku: { contains: trimmed, mode: "insensitive" as const } },
                { color: { contains: trimmed, mode: "insensitive" as const } },
                { size: { contains: trimmed, mode: "insensitive" as const } },
                { product: { name: { contains: trimmed, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      orderBy: [{ sku: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        sku: true,
        color: true,
        size: true,
        productId: true,
        product: { select: { name: true } },
      },
    });
  }

  /**
   * Load campaign data pre-formatted for edit.
   *
   * Target rows are loaded verbatim (up to 200) without dynamic product variant expansion.
   */
  async function getCampaignForEdit(
    campaignId: string,
    now = new Date(),
  ): Promise<CampaignEditData | null> {
    const trimmedId = campaignId.trim();
    if (!isBoundedPromotionIdentifier(trimmedId)) return null;

    const campaign = await client.promotionCampaign.findUnique({
      where: { id: trimmedId },
      select: {
        id: true,
        name: true,
        kind: true,
        discountType: true,
        percentageValue: true,
        fixedPriceVnd: true,
        startsAt: true,
        endsAt: true,
        isEnabled: true,
        enabledAt: true,
        disabledAt: true,
        targets: {
          take: 200,
          select: {
            id: true,
            productId: true,
            variantId: true,
            product: { select: { id: true, name: true } },
            variant: {
              select: {
                id: true,
                sku: true,
                color: true,
                size: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!campaign) return null;

    const lifecycle = deriveCampaignLifecycle({ ...campaign, now });

    const targets: CampaignEditTarget[] = campaign.targets.map((target) => {
      if (target.productId !== null) {
        return {
          id: target.id,
          productId: target.productId,
          variantId: null,
          label: target.product?.name ?? target.productId,
          scope: "PRODUCT",
        };
      }
      const variant = target.variant;
      const variantDetails = variant
        ? (variant.sku || [variant.color, variant.size].filter(Boolean).join(" / ") || variant.id)
        : (target.variantId ?? "");
      const parentName = variant?.product?.name ? `${variant.product.name} — ` : "";
      return {
        id: target.id,
        productId: null,
        variantId: target.variantId,
        label: `${parentName}${variantDetails}`,
        scope: "VARIANT",
      };
    });

    return {
      id: campaign.id,
      name: campaign.name,
      kind: campaign.kind,
      discountType: campaign.discountType,
      percentageValue: campaign.percentageValue,
      fixedPriceVnd: campaign.fixedPriceVnd,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
      status: lifecycle.status,
      canReEnable: lifecycle.canReEnable,
      isTerminal: lifecycle.isTerminal,
      targets,
    };
  }

  /**
   * Bounded query for campaigns related to a product (direct product target or variant target).
   *
   * Zero pricing calculation. Zero duplicate campaign form logic.
   */
  async function listRelatedCampaignsForProduct({
    productId,
    variantIds = [],
    limit = 20,
    now = new Date(),
  }: Readonly<{
    productId: string;
    variantIds?: readonly string[];
    limit?: number;
    now?: Date;
  }>): Promise<readonly RelatedCampaignSummary[]> {
    const cleanProductId = productId.trim().slice(0, MAX_PROMOTION_IDENTIFIER_LENGTH);
    if (cleanProductId.length === 0) return [];

    const cleanVariantIds = variantIds
      .map((id) => id.trim().slice(0, MAX_PROMOTION_IDENTIFIER_LENGTH))
      .filter((id) => id.length > 0);

    const take = Math.min(Math.max(1, limit), 50);

    const targetFilter = {
      OR: [
        { productId: cleanProductId },
        ...(cleanVariantIds.length > 0
          ? [{ variantId: { in: cleanVariantIds } }]
          : [{ variant: { productId: cleanProductId } }]),
      ],
    };

    const campaigns = await client.promotionCampaign.findMany({
      where: {
        targets: {
          some: targetFilter,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        name: true,
        kind: true,
        startsAt: true,
        endsAt: true,
        isEnabled: true,
        enabledAt: true,
        disabledAt: true,
        targets: {
          where: targetFilter,
          select: {
            productId: true,
            variantId: true,
          },
        },
      },
    });

    return campaigns.map((campaign) => {
      const lifecycle = deriveCampaignLifecycle({ ...campaign, now });
      const hasProductTarget = campaign.targets.some((t) => t.productId === cleanProductId);
      const hasVariantTarget = campaign.targets.some((t) => t.variantId !== null);
      let targetScope: "PRODUCT" | "VARIANT" | "BOTH" = "PRODUCT";
      if (hasProductTarget && hasVariantTarget) {
        targetScope = "BOTH";
      } else if (hasVariantTarget) {
        targetScope = "VARIANT";
      }

      return {
        id: campaign.id,
        name: campaign.name,
        kind: campaign.kind,
        status: lifecycle.status,
        targetScope,
      };
    });
  }

  return {
    listCampaigns,
    searchTargetProducts,
    searchTargetVariants,
    getCampaignForEdit,
    listRelatedCampaignsForProduct,
  };
}

export type CampaignEditTarget = Readonly<{
  id: string;
  productId: string | null;
  variantId: string | null;
  label: string;
  scope: "PRODUCT" | "VARIANT";
}>;

export type CampaignEditData = Readonly<{
  id: string;
  name: string;
  kind: PromotionCampaignKind;
  discountType: "PERCENTAGE" | "FIXED_PRICE";
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
  status: CampaignLifecycleStatus;
  canReEnable: boolean;
  isTerminal: boolean;
  targets: readonly CampaignEditTarget[];
}>;

export type RelatedCampaignSummary = Readonly<{
  id: string;
  name: string;
  kind: PromotionCampaignKind;
  status: CampaignLifecycleStatus;
  targetScope: "PRODUCT" | "VARIANT" | "BOTH";
}>;

