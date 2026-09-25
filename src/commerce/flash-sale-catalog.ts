import { buildVariantStockCte } from "./storefront-catalog.ts";
import type { StorefrontDiscoveryQuery } from "./storefront-discovery.ts";
import {
  resolveStorefrontProductMedia,
  type StorefrontProductMedia,
} from "./product-media.ts";
import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";

const MAX_FLASH_SALE_PAGE_SIZE = 48;
const MAX_STOREFRONT_OFFSET = 50_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

type FlashSaleCountRow = { count: bigint };
type FlashSaleBoundaryRow = { boundary: Date | null };
type FlashSaleIdRow = {
  id: string;
  representativeVariantId: string;
  basePrice: number;
  sortPrice: number;
  endsAt: Date;
  hasCheaperCurrentVariant: boolean;
};
type SaleCampaignKind = "PROMOTION" | "FLASH_SALE";
type SaleIdRow = Omit<FlashSaleIdRow, "endsAt"> & {
  kind: SaleCampaignKind;
  endsAt: Date | null;
};

const flashProductSelection = {
  id: true,
  pancakeProductId: true,
  slug: true,
  name: true,
  primaryImageUrl: true,
  variants: {
    where: { isPresent: true, isActive: true },
    orderBy: [{ pancakeVariationId: "asc" }],
    select: {
      id: true,
      pancakeVariationId: true,
      color: true,
      size: true,
      pancakeRetailPrice: true,
      pancakeRetailPriceAfterDiscount: true,
      pancakeImageUrls: true,
      warehouseStocks: {
        orderBy: [{ pancakeWarehouseId: "asc" }],
        select: { quantity: true },
      },
    },
  },
} satisfies Prisma.ProductMirrorSelect;

type SelectedFlashProduct = Prisma.ProductMirrorGetPayload<{ select: typeof flashProductSelection }>;

function parseShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new RangeError("Storefront shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

function parsePageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_FLASH_SALE_PAGE_SIZE) {
    throw new RangeError(
      `Flash Sale page size must be between 1 and ${MAX_FLASH_SALE_PAGE_SIZE}`,
    );
  }
  return pageSize;
}

function parsePageOffset(page: number, pageSize: number): number {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError("Storefront product page must be a positive integer");
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > MAX_STOREFRONT_OFFSET) {
    throw new RangeError("Storefront product page is outside the supported catalog window");
  }
  return offset;
}

function parseJsonStringArray(value: Prisma.JsonValue): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) {
      throw new Error("Flash Sale catalog contains malformed warehouse quantity");
    }
    total += stock.quantity;
    if (!Number.isFinite(total)) {
      throw new Error("Flash Sale catalog stock total is outside numeric bounds");
    }
  }
  return total;
}

function toFlashProduct(product: SelectedFlashProduct) {
  const media: StorefrontProductMedia = resolveStorefrontProductMedia({
    productName: product.name,
    primaryImageUrl: product.primaryImageUrl,
    variantImageUrls: product.variants.map((variant) =>
      parseJsonStringArray(variant.pancakeImageUrls),
    ),
  });

  return {
    id: product.id,
    pancakeProductId: product.pancakeProductId,
    slug: product.slug,
    name: product.name,
    media,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      color: variant.color,
      size: variant.size,
      retailPrice: variant.pancakeRetailPrice,
      retailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
      sellableStock: sumWarehouseStocks(variant.warehouseStocks),
    })),
  };
}

/**
 * Sale membership reuses the one sanctioned SQL pricing projection. This layer adds only
 * purchasability and the requirement that the single resolved campaign produces a real discount.
 */
function buildSaleCte(now: Date) {
  return Prisma.sql`
    ${buildVariantStockCte(now)},
    "sale_variant_dimension" AS (
      SELECT
        vs.*,
        vc."candidateCount",
        BOOL_OR(NULLIF(BTRIM(vs."color"), '') IS NOT NULL)
          OVER (PARTITION BY vs."productId") AS "hasColorDimension"
      FROM "variant_stock" vs
      JOIN "variant_candidate" vc ON vc."id" = vs."id"
    ),
    "sale_variant_mapping" AS (
      SELECT
        svd.*,
        COUNT(*) OVER (
          PARTITION BY
            svd."productId",
            CASE
              WHEN svd."hasColorDimension" THEN LOWER(BTRIM(svd."color"))
              ELSE ''
            END,
            LOWER(BTRIM(svd."size"))
        ) AS "optionCount"
      FROM "sale_variant_dimension" svd
    ),
    "sale_variant_eligible" AS (
      SELECT
        svm.*,
        (
          NULLIF(BTRIM(svm."size"), '') IS NOT NULL
          AND (
            NOT svm."hasColorDimension"
            OR NULLIF(BTRIM(svm."color"), '') IS NOT NULL
          )
          AND svm."optionCount" = 1
          AND svm."sellableStock" > 0
          AND svm."resolvedPrice" IS NOT NULL
        ) AS "isPurchasable"
      FROM "sale_variant_mapping" svm
    ),
    "sale_variant" AS (
      SELECT
        sve."id",
        sve."productId",
        sve."basePrice"::float8 AS "basePrice",
        sve."resolvedPrice",
        c."kind"::text AS "kind",
        c."startsAt",
        c."endsAt"
      FROM "sale_variant_eligible" sve
      JOIN "variant_campaign" vc ON vc."variantId" = sve."id"
      JOIN "PromotionCampaign" c ON c."id" = vc."campaignId"
      WHERE sve."isPurchasable" = TRUE
        AND sve."candidateCount" = 1
        AND sve."basePrice" IS NOT NULL
        AND sve."resolvedPrice" < sve."basePrice"::float8
        AND c."kind" IN (
          'PROMOTION'::"PromotionCampaignKind",
          'FLASH_SALE'::"PromotionCampaignKind"
        )
    )
  `;
}

/**
 * What makes a `sale_variant` row a Flash Sale: the kind and a complete, ordered window. The
 * promotion contract requires both bounds, so a Flash row missing either fails closed here rather
 * than being read as unbounded the way the generic active-window check reads it.
 */
function flashSaleEligibility(alias: string) {
  const column = (name: string) => Prisma.raw(`${alias}."${name}"`);
  return Prisma.sql`${column("kind")} = 'FLASH_SALE'
        AND ${column("startsAt")} IS NOT NULL
        AND ${column("endsAt")} IS NOT NULL
        AND ${column("endsAt")} > ${column("startsAt")}`;
}

function buildFlashSaleCte(now: Date) {
  return Prisma.sql`
    ${buildSaleCte(now)},
    "flash_sale_variant" AS (
      SELECT *
      FROM "sale_variant" sv
      WHERE ${flashSaleEligibility("sv")}
    )
  `;
}

function parseSaleCampaignKind(kind: SaleCampaignKind | undefined): SaleCampaignKind | null {
  if (kind === undefined) return null;
  if (kind !== "PROMOTION" && kind !== "FLASH_SALE") {
    throw new RangeError("Sale campaign kind must be PROMOTION or FLASH_SALE");
  }
  return kind;
}

/**
 * Narrows `sale_variant` to one campaign kind, or leaves it whole. Flash Sale reuses the Flash
 * listing's own eligibility, window invariant included; `sale_variant."kind"` is already projected
 * as text, so the Promotion parameter compares without a cast.
 */
function saleKindFilter(alias: string, kind: SaleCampaignKind | null) {
  if (kind === null) return Prisma.empty;
  if (kind === "FLASH_SALE") return Prisma.sql`AND ${flashSaleEligibility(alias)}`;
  return Prisma.sql`AND ${Prisma.raw(alias)}."kind" = ${kind}`;
}

function assertProjectedMoney(row: Pick<FlashSaleIdRow, "basePrice" | "sortPrice">) {
  if (
    !Number.isSafeInteger(row.basePrice)
    || !Number.isSafeInteger(row.sortPrice)
    || row.basePrice <= 0
    || row.sortPrice <= 0
    || row.sortPrice >= row.basePrice
  ) {
    throw new Error("Sale projection returned invalid representative money");
  }
}

export function createFlashSaleCatalogRepository(client: PrismaClient) {
  async function hydrateProducts(shopId: number, idRows: readonly Readonly<{ id: string }>[]) {
    const ids = idRows.map((row) => row.id);
    const products = ids.length === 0
      ? []
      : await client.productMirror.findMany({
          where: {
            pancakeShopId: shopId,
            isPresent: true,
            isActive: true,
            id: { in: ids },
          },
          select: flashProductSelection,
        });
    return new Map(products.map((product) => [product.id, product]));
  }

  async function listFlashSalePage({
    shopId,
    pageSize,
    discovery,
    now = new Date(),
  }: {
    shopId: number;
    pageSize: number;
    discovery: StorefrontDiscoveryQuery;
    now?: Date;
  }) {
    const safeShopId = parseShopId(shopId);
    const safePageSize = parsePageSize(pageSize);
    const offset = parsePageOffset(discovery.page, safePageSize);
    const cte = buildFlashSaleCte(now);

    const [countRows, idRows] = await Promise.all([
      client.$queryRaw<FlashSaleCountRow[]>(Prisma.sql`
        ${cte}
        SELECT COUNT(*)::bigint AS "count"
        FROM "ProductMirror" p
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
          AND EXISTS (
            SELECT 1 FROM "flash_sale_variant" fsv WHERE fsv."productId" = p."id"
          )
      `),
      client.$queryRaw<FlashSaleIdRow[]>(Prisma.sql`
        ${cte}
        SELECT
          p."id",
          representative."representativeVariantId",
          representative."basePrice",
          representative."sortPrice",
          representative."endsAt",
          representative."hasCheaperCurrentVariant"
        FROM "ProductMirror" p
        JOIN LATERAL (
          SELECT
            fsv."id" AS "representativeVariantId",
            fsv."basePrice",
            fsv."resolvedPrice" AS "sortPrice",
            fsv."endsAt",
            EXISTS (
              SELECT 1
              FROM "sale_variant_eligible" current_variant
              WHERE current_variant."productId" = p."id"
                AND current_variant."isPurchasable" = TRUE
                AND current_variant."resolvedPrice" < fsv."resolvedPrice"
            ) AS "hasCheaperCurrentVariant"
          FROM "flash_sale_variant" fsv
          WHERE fsv."productId" = p."id"
          ORDER BY fsv."resolvedPrice" ASC, fsv."id" ASC
          LIMIT 1
        ) representative ON TRUE
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
        ORDER BY representative."sortPrice" ASC, p."name" ASC, p."id" ASC
        LIMIT ${safePageSize}
        OFFSET ${offset}
      `),
    ]);

    const totalCount = countRows[0] ? Number(countRows[0].count) : 0;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error("Flash Sale result count is outside safe integer bounds");
    }
    for (const row of idRows) assertProjectedMoney(row);

    const byId = await hydrateProducts(safeShopId, idRows);
    const orderedProducts = idRows.map((row) => {
      const product = byId.get(row.id);
      if (!product) throw new Error("Flash Sale result changed during read");
      return {
        ...toFlashProduct(product),
        flashSale: Object.freeze({
          representativeVariantId: row.representativeVariantId,
          basePriceVnd: row.basePrice,
          effectivePriceVnd: row.sortPrice,
          hasCheaperCurrentVariant: row.hasCheaperCurrentVariant,
          remainingMs: Math.max(0, row.endsAt.getTime() - now.getTime()),
        }),
      };
    });

    return {
      products: orderedProducts,
      page: discovery.page,
      pageSize: safePageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / safePageSize),
      hasPrevious: discovery.page > 1,
      hasNext: offset + orderedProducts.length < totalCount,
    };
  }

  /**
   * `/sale` and its sub-listings. Without `kind` every active discount is listed; with it, only
   * products whose discount comes from that campaign kind, and the representative price is chosen
   * among that kind's variants so the card shows the discount the listing is about.
   */
  async function listSalePage({
    shopId,
    pageSize,
    discovery,
    kind,
    now = new Date(),
  }: {
    shopId: number;
    pageSize: number;
    discovery: StorefrontDiscoveryQuery;
    kind?: SaleCampaignKind;
    now?: Date;
  }) {
    const safeShopId = parseShopId(shopId);
    const safePageSize = parsePageSize(pageSize);
    const offset = parsePageOffset(discovery.page, safePageSize);
    const safeKind = parseSaleCampaignKind(kind);
    const cte = buildSaleCte(now);

    const [countRows, idRows] = await Promise.all([
      client.$queryRaw<FlashSaleCountRow[]>(Prisma.sql`
        ${cte}
        SELECT COUNT(*)::bigint AS "count"
        FROM "ProductMirror" p
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
          AND EXISTS (
            SELECT 1 FROM "sale_variant" sv
            WHERE sv."productId" = p."id" ${saleKindFilter("sv", safeKind)}
          )
      `),
      client.$queryRaw<SaleIdRow[]>(Prisma.sql`
        ${cte}
        SELECT
          p."id",
          representative."representativeVariantId",
          representative."basePrice",
          representative."sortPrice",
          representative."kind",
          representative."endsAt",
          representative."hasCheaperCurrentVariant"
        FROM "ProductMirror" p
        JOIN LATERAL (
          SELECT
            sv."id" AS "representativeVariantId",
            sv."basePrice",
            sv."resolvedPrice" AS "sortPrice",
            sv."kind",
            sv."endsAt",
            EXISTS (
              SELECT 1
              FROM "sale_variant_eligible" current_variant
              WHERE current_variant."productId" = p."id"
                AND current_variant."isPurchasable" = TRUE
                AND current_variant."resolvedPrice" < sv."resolvedPrice"
            ) AS "hasCheaperCurrentVariant"
          FROM "sale_variant" sv
          WHERE sv."productId" = p."id" ${saleKindFilter("sv", safeKind)}
          ORDER BY sv."resolvedPrice" ASC, sv."id" ASC
          LIMIT 1
        ) representative ON TRUE
        WHERE p."pancakeShopId" = ${safeShopId}
          AND p."isPresent" = TRUE
          AND p."isActive" = TRUE
        ORDER BY representative."sortPrice" ASC, p."name" ASC, p."id" ASC
        LIMIT ${safePageSize}
        OFFSET ${offset}
      `),
    ]);

    const totalCount = countRows[0] ? Number(countRows[0].count) : 0;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error("Sale result count is outside safe integer bounds");
    }
    for (const row of idRows) assertProjectedMoney(row);

    const byId = await hydrateProducts(safeShopId, idRows);
    const orderedProducts = idRows.map((row) => {
      const product = byId.get(row.id);
      if (!product) throw new Error("Sale result changed during read");
      const base = toFlashProduct(product);
      if (row.kind !== "FLASH_SALE" || row.endsAt === null || row.endsAt <= now) return base;
      return {
        ...base,
        flashSale: Object.freeze({
          representativeVariantId: row.representativeVariantId,
          basePriceVnd: row.basePrice,
          effectivePriceVnd: row.sortPrice,
          hasCheaperCurrentVariant: row.hasCheaperCurrentVariant,
          remainingMs: Math.max(0, row.endsAt.getTime() - now.getTime()),
        }),
      };
    });

    return {
      products: orderedProducts,
      page: discovery.page,
      pageSize: safePageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / safePageSize),
      hasPrevious: discovery.page > 1,
      hasNext: offset + orderedProducts.length < totalCount,
    };
  }

  async function readNextFlashSaleBoundary({
    now = new Date(),
  }: { now?: Date } = {}): Promise<Date | null> {
    const rows = await client.$queryRaw<FlashSaleBoundaryRow[]>(Prisma.sql`
      SELECT MIN("boundary") AS "boundary" FROM (
        SELECT "startsAt" AS "boundary"
        FROM "PromotionCampaign"
        WHERE "isEnabled" = TRUE
          AND "kind" = 'FLASH_SALE'::"PromotionCampaignKind"
          AND "startsAt" IS NOT NULL
          AND "startsAt" > ${now}
        UNION ALL
        SELECT "endsAt" AS "boundary"
        FROM "PromotionCampaign"
        WHERE "isEnabled" = TRUE
          AND "kind" = 'FLASH_SALE'::"PromotionCampaignKind"
          AND "endsAt" IS NOT NULL
          AND "endsAt" > ${now}
      ) boundaries
    `);
    return rows[0]?.boundary ?? null;
  }

  async function readNextSaleBoundary({
    now = new Date(),
    kind,
  }: { now?: Date; kind?: SaleCampaignKind } = {}): Promise<Date | null> {
    const safeKind = parseSaleCampaignKind(kind);
    const kindFilter = safeKind === null
      ? Prisma.sql`"kind" IN (
            'PROMOTION'::"PromotionCampaignKind",
            'FLASH_SALE'::"PromotionCampaignKind"
          )`
      : Prisma.sql`"kind"::text = ${safeKind}`;
    const rows = await client.$queryRaw<FlashSaleBoundaryRow[]>(Prisma.sql`
      SELECT MIN("boundary") AS "boundary" FROM (
        SELECT "startsAt" AS "boundary"
        FROM "PromotionCampaign"
        WHERE "isEnabled" = TRUE
          AND ${kindFilter}
          AND "startsAt" IS NOT NULL
          AND "startsAt" > ${now}
        UNION ALL
        SELECT "endsAt" AS "boundary"
        FROM "PromotionCampaign"
        WHERE "isEnabled" = TRUE
          AND ${kindFilter}
          AND "endsAt" IS NOT NULL
          AND "endsAt" > ${now}
      ) boundaries
    `);
    return rows[0]?.boundary ?? null;
  }

  return {
    listFlashSalePage,
    listSalePage,
    readNextFlashSaleBoundary,
    readNextSaleBoundary,
  };
}
