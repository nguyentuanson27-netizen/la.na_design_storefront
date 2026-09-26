import {
  isPromotionCampaignKind,
  PROMOTION_CAMPAIGN_KINDS,
  type PromotionCampaignKind,
} from "./promotion-pricing.ts";
import { buildVariantStockCte } from "./storefront-catalog.ts";
import { LAST_SIZES_TOTAL_STOCK_LIMIT } from "./storefront-product.ts";
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
type SaleCampaignKind = PromotionCampaignKind;
type SaleIdRow = Omit<FlashSaleIdRow, "endsAt"> & {
  kind: SaleCampaignKind;
  endsAt: Date | null;
  /** Only on `/sale/xa-hang-le-size`: this product's valid Flash Sale variants, when it was admitted. */
  admittedFlashVariantIds: string[];
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
        AND c."kind"::text IN (${Prisma.join([...PROMOTION_CAMPAIGN_KINDS])})
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

/**
 * `/sale/xa-hang-le-size` also lists a product running a Flash Sale when its stock proves it really
 * is "lẻ size" (owner decision, 2026-09-26). The Flash campaign is untouched: the product stays on
 * `/sale/flash-sale` as well, priced and badged as a Flash Sale on both listings.
 *
 * The proof is the one the `Lẻ size - Chỉ còn ít` tag makes (`provesLastSizesLeft`), read from the
 * same projection the sale membership uses:
 *
 * - at least one **size** is sold out -- every option of that size is a mapped, unambiguous option
 *   with no stock left, so a sold-out colour of a size that still sells in another colour does not
 *   count, and neither does a size that is merely unmapped;
 * - at least one option is still purchasable;
 * - the ready pieces left across the purchasable options total fewer than
 *   `LAST_SIZES_TOTAL_STOCK_LIMIT`.
 *
 * Stock is read the way the capacity authority (`evaluateVariantCapacity`) reads it: only a safe
 * integer counts, and a fractional or out-of-range mirrored sum proves neither "sold out" nor "for
 * sale", so a product is never admitted on stock commerce itself refuses to sell.
 *
 * Only a product that sells as `STANDARD` (no stored policy, or a `STANDARD` row) can prove it. Under
 * `OVERSELL` or `PREORDER` a size at zero stock may still be for sale, so stock alone proves nothing
 * and the product stays off this listing. A composite (FULL SET) product -- any variant with
 * component rows -- is never admitted this way either: its capacity comes from its components, not
 * from the parent stock this proof reads. An explicit `CLEARANCE` campaign still lists it.
 */
function buildClearanceLastSizesCte() {
  return Prisma.sql`,
    "clearance_variant" AS (
      SELECT
        sve.*,
        -- The capacity authority counts stock only as a safe integer: a fractional or out-of-range
        -- mirrored sum is refused as invalid-stock, never floored. Neither sold out nor for sale.
        (
          sve."sellableStock" IS NOT NULL
          AND sve."sellableStock" = TRUNC(sve."sellableStock")
          AND ABS(sve."sellableStock") <= 9007199254740991::float8
        ) AS "hasCountStock"
      FROM "sale_variant_eligible" sve
    ),
    "clearance_variant_state" AS (
      SELECT
        cv.*,
        -- STANDARD sells one more unit only when at least one whole unit is left.
        (cv."isPurchasable" AND cv."hasCountStock" AND cv."sellableStock" >= 1) AS "isCountPurchasable"
      FROM "clearance_variant" cv
    ),
    "clearance_size_state" AS (
      SELECT
        cvs."productId",
        BOOL_AND(
          NULLIF(BTRIM(cvs."size"), '') IS NOT NULL
          AND (
            NOT cvs."hasColorDimension"
            OR NULLIF(BTRIM(cvs."color"), '') IS NOT NULL
          )
          AND cvs."optionCount" = 1
          AND cvs."hasCountStock"
          AND cvs."sellableStock" <= 0
        ) AS "isSoldOut"
      FROM "clearance_variant_state" cvs
      GROUP BY cvs."productId", LOWER(BTRIM(COALESCE(cvs."size", '')))
    ),
    "clearance_last_sizes_product" AS (
      SELECT cvs."productId"
      FROM "clearance_variant_state" cvs
      LEFT JOIN "ProductSellingPolicy" psp ON psp."productId" = cvs."productId"
      WHERE (
          psp."productId" IS NULL
          OR psp."sellingMode" = 'STANDARD'::"SellingMode"
        )
        -- A composite (FULL SET) sells from its components' capacity, not the parent rows summed
        -- here, so parent stock proves nothing about its sizes. Fail closed until this proof reads
        -- component-derived capacity.
        AND NOT EXISTS (
          SELECT 1
          FROM "CompositeComponentMirror" ccm
          JOIN "VariantMirror" parent ON parent."id" = ccm."parentVariantId"
          WHERE parent."productId" = cvs."productId"
        )
      GROUP BY cvs."productId"
      HAVING BOOL_OR(cvs."isCountPurchasable")
        AND SUM(
          CASE WHEN cvs."isCountPurchasable" THEN cvs."sellableStock" ELSE 0 END
        ) < ${LAST_SIZES_TOTAL_STOCK_LIMIT}
        AND EXISTS (
          SELECT 1
          FROM "clearance_size_state" css
          WHERE css."productId" = cvs."productId"
            AND css."isSoldOut"
        )
    ),
    "clearance_admitted_flash_variant" AS (
      -- The Flash variants that may represent, and be priced on, an admitted product: valid Flash
      -- Sale rows the capacity authority would actually sell.
      SELECT sv."id", sv."productId"
      FROM "sale_variant" sv
      JOIN "clearance_variant_state" cvs ON cvs."id" = sv."id"
      WHERE ${flashSaleEligibility("sv")}
        AND cvs."isCountPurchasable"
        AND sv."productId" IN (SELECT clsp."productId" FROM "clearance_last_sizes_product" clsp)
    )
  `;
}

function parseSaleCampaignKind(kind: SaleCampaignKind | undefined): SaleCampaignKind | null {
  if (kind === undefined) return null;
  if (!isPromotionCampaignKind(kind)) {
    throw new RangeError(`Sale campaign kind must be one of ${PROMOTION_CAMPAIGN_KINDS.join(", ")}`);
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
  if (kind === "CLEARANCE") {
    // Needs `buildClearanceLastSizesCte` in the same statement.
    return Prisma.sql`AND (
      ${Prisma.raw(alias)}."kind" = 'CLEARANCE'
      OR ${Prisma.raw(alias)}."id" IN (SELECT cafv."id" FROM "clearance_admitted_flash_variant" cafv)
    )`;
  }
  return Prisma.sql`AND ${Prisma.raw(alias)}."kind" = ${kind}`;
}

/**
 * The campaign kinds whose discounts a listing shows. `/sale/xa-hang-le-size` shows Flash Sale too,
 * but only on the Flash variants of the products `buildClearanceLastSizesCte` admitted; see
 * `listSalePage`.
 */
export function saleListingCampaignKinds(kind: SaleCampaignKind): readonly SaleCampaignKind[] {
  return kind === "CLEARANCE" ? ["CLEARANCE", "FLASH_SALE"] : [kind];
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
   *
   * `CLEARANCE` is the one listing that also shows a second kind: a Flash Sale product whose stock
   * proves it is "lẻ size" (`buildClearanceLastSizesCte`). Such a product carries
   * `admittedFlashVariantIds` -- exactly its valid Flash Sale variants -- so the route lets those
   * variants' Flash price, and nothing else, through the listing's pricing scope; a product that is
   * only on Clearance never shows a Flash sibling's price.
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
    const cte = safeKind === "CLEARANCE"
      ? Prisma.sql`${buildSaleCte(now)}${buildClearanceLastSizesCte()}`
      : buildSaleCte(now);
    const admittedFlashVariantIds = safeKind === "CLEARANCE"
      ? Prisma.sql`ARRAY(
          SELECT cafv."id"
          FROM "clearance_admitted_flash_variant" cafv
          WHERE cafv."productId" = p."id"
          ORDER BY cafv."id"
        )`
      : Prisma.sql`ARRAY[]::text[]`;

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
          representative."hasCheaperCurrentVariant",
          ${admittedFlashVariantIds} AS "admittedFlashVariantIds"
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
      const base = row.admittedFlashVariantIds.length > 0
        ? { ...toFlashProduct(product), admittedFlashVariantIds: Object.freeze([...row.admittedFlashVariantIds]) }
        : toFlashProduct(product);
      if (row.kind === "CLEARANCE") return { ...base, isClearance: true as const };
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
    // A listing refreshes on the boundaries of every kind it can show: a Flash window opening or
    // closing changes `/sale/xa-hang-le-size` as well as `/sale/flash-sale`.
    const kinds = safeKind === null ? PROMOTION_CAMPAIGN_KINDS : saleListingCampaignKinds(safeKind);
    const kindFilter = Prisma.sql`"kind"::text IN (${Prisma.join([...kinds])})`;
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
