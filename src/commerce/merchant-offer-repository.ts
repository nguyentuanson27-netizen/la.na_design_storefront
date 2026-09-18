import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { vietnamCalendarDate } from "./availability-cycle.ts";
import { readVariantAvailabilityDates } from "./availability-cycle-repository.ts";
import { resolveSellingPolicy } from "./capacity-policy.ts";

import {
  mapMerchantOffers,
  type MerchantCandidateProduct,
  type MerchantCandidateVariation,
  type MerchantMappingResult,
} from "./merchant-offer-mapper.ts";
import { MAX_MERCHANT_CANDIDATE_VARIANTS } from "./merchant-feed-limits.ts";
import type { ApplicablePromotionCampaign } from "./promotion-pricing.ts";
import {
  resolveStorefrontProductMedia,
  resolveVariantGalleryIndexes,
} from "./product-media.ts";
import { buildStorefrontProductProjection } from "./storefront-projection.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import type {
  StorefrontAvailabilityDates,
  StorefrontVariantFacts,
} from "./storefront-product.ts";
import { toMerchantApparelWireValues } from "./merchant-apparel-facts.ts";
import { INHERITED_APPAREL_OVERRIDES } from "./product-merchant-facts-repository.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
export const MAX_MERCHANT_CANDIDATE_PRODUCTS = 5_000;
export class MerchantOfferReadError extends Error {}

/**
 * U26 keeps the public feed inside eight whole-generation DB operations without enabling Prisma's
 * preview relation-join feature. The coordinator owns two durable promotion-revision reads (capture
 * and pre-publish recheck), so this repository is capped at six flat/bounded data reads. Two pairs
 * that used to need separate Prisma model reads are deliberately folded into parameterized SQL:
 * product editorial+Merchant facts, and promotion target+enabled-campaign facts.
 */
const productSelection = {
  id: true,
  pancakeProductId: true,
  slug: true,
  name: true,
  primaryImageUrl: true,
  // I9 — the feed must know the selling mode, or `isPreorderSale` is false for every variant and
  // ADR 0011's backorder row can never appear however good the date is. Read through
  // `resolveSellingPolicy` below so a missing row means the approved default, not "unknown".
  sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
} satisfies Prisma.ProductMirrorSelect;

const variantSelection = {
  id: true,
  productId: true,
  pancakeVariationId: true,
  pancakeDisplayId: true,
  color: true,
  size: true,
  pancakeRetailPrice: true,
  pancakeRetailPriceAfterDiscount: true,
  pancakeImageUrls: true,
} satisfies Prisma.VariantMirrorSelect;

const contentSelection = {
  productId: true,
  status: true,
  editorialDescription: true,
} satisfies Prisma.ProductContentSelect;

const merchantFactsSelection = {
  productId: true,
  gender: true,
  ageGroup: true,
  condition: true,
} satisfies Prisma.ProductMerchantFactsSelect;

const stockSelection = {
  variantId: true,
  pancakeWarehouseId: true,
  quantity: true,
} satisfies Prisma.WarehouseStockSelect;

const compositeSelection = {
  parentVariantId: true,
  componentVariantId: true,
} satisfies Prisma.CompositeComponentMirrorSelect;

type SelectedProduct = Prisma.ProductMirrorGetPayload<{ select: typeof productSelection }>;
type SelectedVariant = Prisma.VariantMirrorGetPayload<{ select: typeof variantSelection }>;
type SelectedProductContent = Prisma.ProductContentGetPayload<{ select: typeof contentSelection }>;
type SelectedMerchantFacts = Prisma.ProductMerchantFactsGetPayload<{
  select: typeof merchantFactsSelection;
}>;
type SelectedWarehouseStock = Prisma.WarehouseStockGetPayload<{ select: typeof stockSelection }>;

type ProductFactRow = Readonly<{
  productId: string;
  contentStatus: SelectedProductContent["status"] | null;
  editorialDescription: string | null;
  merchantFactsPresent: boolean;
  merchantGender: SelectedMerchantFacts["gender"] | null;
  merchantAgeGroup: SelectedMerchantFacts["ageGroup"] | null;
  merchantCondition: SelectedMerchantFacts["condition"] | null;
}>;

type JoinedPromotionRow = Readonly<{
  campaignId: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  kind: ApplicablePromotionCampaign["kind"];
  discountType: ApplicablePromotionCampaign["discountType"];
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
}>;

type LoadedCandidateVariant = SelectedVariant &
  Readonly<{
    warehouseStocks: readonly SelectedWarehouseStock[];
    isCompositeParent: boolean;
    isCompositeComponent: boolean;
  }>;

type LoadedCandidateProduct = SelectedProduct &
  Readonly<{
    content: SelectedProductContent | null;
    merchantFacts: SelectedMerchantFacts | null;
    variants: readonly LoadedCandidateVariant[];
  }>;

type LoadedMerchantCandidates = Readonly<{
  products: readonly MerchantCandidateProduct[];
  nextPricingTransitionAtMs: number | null;
}>;

function aggregateWarehouseStock(quantities: readonly number[]): number {
  for (const quantity of quantities) {
    if (!Number.isFinite(quantity) || quantity < 0) return Number.NaN;
  }
  return quantities.reduce((total, quantity) => total + quantity, 0);
}

function parseJsonStringArray(value: Prisma.JsonValue): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function buildCampaignsByVariantId({
  variants,
  promotionRows,
}: Readonly<{
  variants: readonly SelectedVariant[];
  promotionRows: readonly JoinedPromotionRow[];
}>): ReadonlyMap<string, readonly ApplicablePromotionCampaign[]> {
  const knownVariantIds = new Set(variants.map((variant) => variant.id));
  const variantsByProductId = new Map<string, string[]>();
  for (const variant of variants) {
    const owned = variantsByProductId.get(variant.productId);
    if (owned === undefined) variantsByProductId.set(variant.productId, [variant.id]);
    else owned.push(variant.id);
  }

  const campaignsByVariantId = new Map<string, ApplicablePromotionCampaign[]>();
  const seenByVariantId = new Map<string, Set<string>>();
  for (const variantId of knownVariantIds) {
    campaignsByVariantId.set(variantId, []);
    seenByVariantId.set(variantId, new Set());
  }

  const attach = (variantId: string, campaign: ApplicablePromotionCampaign) => {
    const seen = seenByVariantId.get(variantId);
    if (seen === undefined || seen.has(campaign.id)) return;
    seen.add(campaign.id);
    campaignsByVariantId.get(variantId)?.push(campaign);
  };

  for (const row of promotionRows) {
    const campaign: ApplicablePromotionCampaign = Object.freeze({
      id: row.campaignId,
      name: row.name,
      kind: row.kind,
      discountType: row.discountType,
      percentageValue: row.percentageValue,
      fixedPriceVnd: row.fixedPriceVnd,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    });
    if (row.variantId !== null) {
      attach(row.variantId, campaign);
      continue;
    }
    if (row.productId === null) continue;
    for (const variantId of variantsByProductId.get(row.productId) ?? []) {
      attach(variantId, campaign);
    }
  }

  return campaignsByVariantId;
}

function nextRelevantPricingTransitionAtMs(
  promotionRows: readonly JoinedPromotionRow[],
  now: Date,
): number | null {
  const nowMs = now.getTime();
  let nextMs: number | null = null;
  const seenCampaignIds = new Set<string>();

  for (const row of promotionRows) {
    if (seenCampaignIds.has(row.campaignId)) continue;
    seenCampaignIds.add(row.campaignId);
    for (const boundary of [row.startsAt, row.endsAt]) {
      if (boundary === null) continue;
      const boundaryMs = boundary.getTime();
      if (boundaryMs <= nowMs) continue;
      if (nextMs === null || boundaryMs < nextMs) nextMs = boundaryMs;
    }
  }

  return nextMs;
}

function toCandidateProduct(
  product: LoadedCandidateProduct,
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>,
  now: Date,
  availabilityDates: StorefrontAvailabilityDates,
): MerchantCandidateProduct {
  const variantImageUrls = product.variants.map((variant) =>
    parseJsonStringArray(variant.pancakeImageUrls),
  );
  const media = resolveStorefrontProductMedia({
    productName: product.name,
    primaryImageUrl: product.primaryImageUrl,
    variantImageUrls,
  });
  const galleryIndexByVariantId = resolveVariantGalleryIndexes({
    gallery: media.gallery,
    variants: product.variants.map((variant, index) => ({
      id: variant.id,
      imageUrls: variantImageUrls[index] ?? [],
    })),
  });
  const stockByVariantId = new Map(
    product.variants.map((variant) => [
      variant.id,
      aggregateWarehouseStock(variant.warehouseStocks.map((stock) => stock.quantity)),
    ]),
  );
  const parentVariants: StorefrontVariantFacts[] = product.variants.map((variant) => ({
    id: variant.id,
    pancakeVariationId: variant.pancakeVariationId,
    color: variant.color,
    size: variant.size,
    sellableStock: stockByVariantId.get(variant.id) ?? Number.NaN,
    retailPrice: variant.pancakeRetailPrice,
    retailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
  }));
  const hasCompositeGraph = product.variants.some((variant) => variant.isCompositeParent);
  const variations: MerchantCandidateVariation[] = product.variants.map((variant) => ({
    variantId: variant.id,
    pancakeVariationId: variant.pancakeVariationId,
    pancakeDisplayId: variant.pancakeDisplayId,
    isComposite: variant.isCompositeParent || variant.isCompositeComponent,
    stockQuantity: stockByVariantId.get(variant.id) ?? Number.NaN,
  }));

  return {
    pancakeProductId: product.pancakeProductId,
    slug: product.slug,
    name: product.name,
    publishedDescription:
      product.content?.status === "PUBLISHED" ? product.content.editorialDescription : null,
    media,
    galleryIndexByVariantId,
    projection: buildStorefrontProductProjection({
      parentVariants,
      componentGroups: [],
      hasCompositeGraph,
      pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
      sellingPolicy: resolveSellingPolicy(product.sellingPolicy),
      availabilityDates,
    }),
    apparelOverrides:
      product.merchantFacts === null
        ? INHERITED_APPAREL_OVERRIDES
        : toMerchantApparelWireValues(product.merchantFacts),
    variations,
  };
}

export function createMerchantOfferRepository(client: PrismaClient) {
  async function loadCandidateProducts({
    shopId,
    now = new Date(),
  }: Readonly<{ shopId: number; now?: Date }>): Promise<LoadedMerchantCandidates> {
    if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
      throw new MerchantOfferReadError("Merchant shop id must fit a positive PostgreSQL INTEGER");
    }

    // 1/6 — bounded product authority.
    const products = await client.productMirror.findMany({
      where: { pancakeShopId: shopId, isPresent: true, isActive: true },
      select: productSelection,
      orderBy: [{ pancakeProductId: "asc" }],
      take: MAX_MERCHANT_CANDIDATE_PRODUCTS + 1,
    });
    if (products.length > MAX_MERCHANT_CANDIDATE_PRODUCTS) {
      throw new MerchantOfferReadError(
        `Catalog exceeds the Merchant candidate bound of ${MAX_MERCHANT_CANDIDATE_PRODUCTS} products; refusing a truncated feed`,
      );
    }
    if (products.length === 0) {
      return Object.freeze({ products: [], nextPricingTransitionAtMs: null });
    }

    const productIds = products.map((product) => product.id);

    // 2/6 — all active/present variants, bounded before any fan-out reads.
    const variants = await client.variantMirror.findMany({
      where: { productId: { in: productIds }, isPresent: true, isActive: true },
      select: variantSelection,
      orderBy: [{ productId: "asc" }, { pancakeVariationId: "asc" }],
      take: MAX_MERCHANT_CANDIDATE_VARIANTS + 1,
    });
    if (variants.length > MAX_MERCHANT_CANDIDATE_VARIANTS) {
      throw new MerchantOfferReadError(
        `Catalog exceeds the Merchant candidate-variant query envelope of ${MAX_MERCHANT_CANDIDATE_VARIANTS}; refusing rather than exceeding the public-feed DB budget`,
      );
    }

    const variantIds = variants.map((variant) => variant.id);

    // 3/6 — both website-owned product-fact tables in one parameterized, product-bounded read.
    const productFacts = await client.$queryRawUnsafe<ProductFactRow[]>(
      `SELECT
         p."id" AS "productId",
         c."status"::text AS "contentStatus",
         c."editorialDescription" AS "editorialDescription",
         (m."id" IS NOT NULL) AS "merchantFactsPresent",
         m."gender"::text AS "merchantGender",
         m."ageGroup"::text AS "merchantAgeGroup",
         m."condition"::text AS "merchantCondition"
       FROM "ProductMirror" p
       LEFT JOIN "ProductContent" c ON c."productId" = p."id"
       LEFT JOIN "ProductMerchantFacts" m ON m."productId" = p."id"
       WHERE p."id" = ANY($1::text[])
       ORDER BY p."id"`,
      productIds,
    );

    // 4/6 and 5/6 — variant inventory and composite membership. Empty variant sets stay cheap.
    const stocks =
      variantIds.length === 0
        ? []
        : await client.warehouseStock.findMany({
            where: { variantId: { in: variantIds } },
            select: stockSelection,
            orderBy: [{ variantId: "asc" }, { pancakeWarehouseId: "asc" }],
          });
    const compositeEdges =
      variantIds.length === 0
        ? []
        : await client.compositeComponentMirror.findMany({
            where: {
              OR: [
                { parentVariantId: { in: variantIds } },
                { componentVariantId: { in: variantIds } },
              ],
            },
            select: compositeSelection,
          });

    // 6/6 — target membership and enabled campaign facts in one parameterized bounded-domain read.
    // This is also where the next known pricing boundary is discovered for cache-expiry capping.
    const promotionRows =
      variantIds.length === 0
        ? []
        : await client.$queryRawUnsafe<JoinedPromotionRow[]>(
            `SELECT
               t."campaignId" AS "campaignId",
               t."productId" AS "productId",
               t."variantId" AS "variantId",
               c."name" AS "name",
               c."kind"::text AS "kind",
               c."discountType"::text AS "discountType",
               c."percentageValue" AS "percentageValue",
               c."fixedPriceVnd" AS "fixedPriceVnd",
               c."startsAt" AS "startsAt",
               c."endsAt" AS "endsAt"
             FROM "PromotionTarget" t
             INNER JOIN "PromotionCampaign" c ON c."id" = t."campaignId"
             WHERE c."isEnabled" = TRUE
               AND (t."variantId" = ANY($1::text[]) OR t."productId" = ANY($2::text[]))
             ORDER BY t."campaignId", t."id"`,
            variantIds,
            productIds,
          );

    const contentByProductId = new Map<string, SelectedProductContent>();
    const merchantFactsByProductId = new Map<string, SelectedMerchantFacts>();
    for (const row of productFacts) {
      if (row.contentStatus !== null) {
        contentByProductId.set(row.productId, {
          productId: row.productId,
          status: row.contentStatus,
          editorialDescription: row.editorialDescription,
        });
      }
      if (row.merchantFactsPresent) {
        merchantFactsByProductId.set(row.productId, {
          productId: row.productId,
          gender: row.merchantGender,
          ageGroup: row.merchantAgeGroup,
          condition: row.merchantCondition,
        });
      }
    }

    const stocksByVariantId = new Map<string, SelectedWarehouseStock[]>();
    for (const stock of stocks) {
      const existing = stocksByVariantId.get(stock.variantId);
      if (existing === undefined) stocksByVariantId.set(stock.variantId, [stock]);
      else existing.push(stock);
    }
    const compositeParentIds = new Set(compositeEdges.map((edge) => edge.parentVariantId));
    const compositeComponentIds = new Set(compositeEdges.map((edge) => edge.componentVariantId));
    const variantsByProductId = new Map<string, LoadedCandidateVariant[]>();
    for (const variant of variants) {
      const loaded: LoadedCandidateVariant = {
        ...variant,
        warehouseStocks: stocksByVariantId.get(variant.id) ?? [],
        isCompositeParent: compositeParentIds.has(variant.id),
        isCompositeComponent: compositeComponentIds.has(variant.id),
      };
      const existing = variantsByProductId.get(variant.productId);
      if (existing === undefined) variantsByProductId.set(variant.productId, [loaded]);
      else existing.push(loaded);
    }

    const campaignsByVariantId = buildCampaignsByVariantId({ variants, promotionRows });

    // I9 — the persisted cycle dates, read once for the whole page of candidates rather than per
    // offer. This is a READ: a feed run must never open, move or close a cycle, or the published
    // date would depend on when the feed last happened to run (ADR 0011's moving product fact).
    const availabilityDates: StorefrontAvailabilityDates = {
      byVariantId: await readVariantAvailabilityDates(
        client,
        variants.map((variant) => variant.id),
      ),
      today: vietnamCalendarDate(now),
    };
    const loadedProducts: LoadedCandidateProduct[] = products.map((product) => ({
      ...product,
      content: contentByProductId.get(product.id) ?? null,
      merchantFacts: merchantFactsByProductId.get(product.id) ?? null,
      variants: variantsByProductId.get(product.id) ?? [],
    }));

    return Object.freeze({
      products: loadedProducts.map((product) =>
        toCandidateProduct(product, campaignsByVariantId, now, availabilityDates),
      ),
      nextPricingTransitionAtMs: nextRelevantPricingTransitionAtMs(promotionRows, now),
    });
  }

  async function readCandidateProducts({
    shopId,
    now = new Date(),
  }: Readonly<{ shopId: number; now?: Date }>): Promise<MerchantCandidateProduct[]> {
    return [...(await loadCandidateProducts({ shopId, now })).products];
  }

  async function readMerchantOffers({
    shopId,
    origin,
    now = new Date(),
  }: Readonly<{ shopId: number; origin: string; now?: Date }>): Promise<MerchantMappingResult> {
    const loaded = await loadCandidateProducts({ shopId, now });
    return mapMerchantOffers({ products: loaded.products, origin });
  }

  async function readMerchantFeedSnapshot({
    shopId,
    origin,
    now = new Date(),
  }: Readonly<{ shopId: number; origin: string; now?: Date }>) {
    const loaded = await loadCandidateProducts({ shopId, now });
    return Object.freeze({
      mapping: mapMerchantOffers({ products: loaded.products, origin }),
      nextPricingTransitionAtMs: loaded.nextPricingTransitionAtMs,
    });
  }

  return { readCandidateProducts, readMerchantOffers, readMerchantFeedSnapshot };
}
