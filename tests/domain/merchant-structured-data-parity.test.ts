/**
 * Wave 5 convergence gate — U26/M4 Merchant feed ↔ U27 ProductGroup JSON-LD parity.
 *
 * Two public consumers describe the same standalone variant to two different vendors. This file
 * proves they never publish two different truths about the facts they share: variation identity,
 * product/family identity, ADR 0008 manufacturer MPN, the exact U12 variant URL, the exact
 * promotion-aware price, and availability.
 *
 * The method matters as much as the assertions. Every case starts from ONE catalog fixture and ONE
 * storefront projection built by the real pricing rule, then hands that single source to each
 * consumer's own existing entry point:
 *
 *   catalog facts → buildStorefrontProductProjection (real promotion pricing)
 *                 ├→ mapMerchantOffers → serializeMerchantFeed → parsed RSS items
 *                 └→ buildStorefrontProductStructuredData → ProductGroup.hasVariant / exact Product
 *
 * Neither side can be tuned independently to make a case pass, and the Merchant side is read back
 * from the serialized bytes a vendor would actually fetch rather than from the mapper's in-memory
 * result. The parity tuple below is an assertion vehicle only: it is not a third mapper, it owns no
 * business rule, and neither production consumer imports it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PersistedMerchantApparelOverrides } from "../../src/commerce/merchant-apparel-facts.ts";
import { serializeMerchantFeed } from "../../src/commerce/merchant-feed-serializer.ts";
import {
  mapMerchantOffers,
  type MerchantCandidateProduct,
  type MerchantCandidateVariation,
  type MerchantExclusionReason,
  type MerchantMarketPolicy,
} from "../../src/commerce/merchant-offer-mapper.ts";
import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import {
  resolveVariantAvailabilityFromWarehouseStocks,
  type StorefrontVariantFacts,
} from "../../src/commerce/storefront-product.ts";
import {
  buildStorefrontProductProjection,
  type StorefrontProductProjection,
} from "../../src/commerce/storefront-projection.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import {
  resolveDeepLinkedVariantSelection,
  VARIANT_QUERY_PARAM,
} from "../../src/commerce/storefront-variant-deep-link.ts";
import { buildStorefrontProductStructuredData } from "../../src/seo/storefront-product-structured-data.ts";
import type { MerchantAvailability } from "../../src/commerce/availability-projection.ts";

const ORIGIN = "https://shop.example.test";
const NOW = new Date("2026-09-05T09:00:00.000Z");

/**
 * A market shape used ONLY to exercise RSS serialization in these tests.
 *
 * This is not an O2 approval and grants none. Owner gate O2 is unresolved, `APPROVED_MERCHANT_MARKET`
 * stays `null`, and the production route keeps failing closed with `MERCHANT_MARKET_UNRESOLVED`.
 * The serializer needs *some* currency token to render `<g:price>`, and passing one directly here
 * is what lets price parity be read from real serialized bytes. Nothing in `src/` imports this, so
 * it cannot make `/feeds/google-merchant` answer `200`.
 */
const TEST_ONLY_MERCHANT_MARKET: MerchantMarketPolicy = {
  targetCountry: "VN",
  contentLanguage: "vi",
  currency: "VND",
};

/** The shared vocabulary the two formats are compared in. Neither consumer speaks it natively. */
type VariantCommerceParity = Readonly<{
  variantExternalId: string;
  /** Standalone JSON-LD has no ProductGroup identity; Merchant still carries item_group_id. */
  productExternalId: string | null;
  mpn: string;
  url: string;
  priceVnd: number;
  availability: MerchantAvailability;
}>;

type CatalogVariant = Readonly<{
  /** Internal `VariantMirror.id`. Neither consumer may publish it. */
  variantId: string;
  pancakeVariationId: string;
  /** ADR 0008 manufacturer MPN candidate. */
  pancakeDisplayId: string | null;
  /** Website-local SKU, deliberately different from the MPN and never publishable as one. */
  localSku: string;
  color: string | null;
  size: string | null;
  sellableStock: number;
  /**
   * Raw mirrored warehouse rows, when a case needs them.
   *
   * The two repositories reduce these rows by different rules, so a case about malformed inventory
   * has to start from the rows themselves rather than from an already-summed total: `[5, -3]` sums
   * to a perfectly ordinary `2`, and a fixture that only carried the total could not express it.
   * When absent, `sellableStock` stands alone and every row is treated as well-formed.
   */
  warehouseQuantities?: readonly number[];
  retailPrice: number | null;
  retailPriceAfterDiscount: number | null;
  isComposite?: boolean;
  campaigns?: readonly ApplicablePromotionCampaign[];
}>;

type CatalogProduct = Readonly<{
  pancakeProductId: string;
  slug: string;
  name: string;
  publishedDescription: string | null;
  gallery: readonly string[];
  variants: readonly CatalogVariant[];
  apparelOverrides?: PersistedMerchantApparelOverrides;
}>;

/**
 * The storefront's own reduction: a plain sum of finite quantities.
 *
 * Deliberately unchanged by U27a — the shopper-facing PDP keeps treating a malformed negative row as
 * ordinary arithmetic, so `[5, -3]` is still 2 units and still purchasable on the page.
 */
function storefrontSellableStock(row: CatalogVariant): number {
  const quantities = row.warehouseQuantities;
  return quantities === undefined
    ? row.sellableStock
    : quantities.reduce((total, quantity) => total + quantity, 0);
}

/**
 * M1's reduction, as `merchant-offer-repository.aggregateWarehouseStock` performs it.
 *
 * Modeled here the same way this file already models the rest of that repository's plumbing: any
 * non-finite or negative row makes the whole variant's availability unresolvable, which is a
 * stronger rule than "the total came out negative".
 */
function merchantStockQuantity(row: CatalogVariant): number {
  const quantities = row.warehouseQuantities;
  if (quantities === undefined) return row.sellableStock;
  for (const quantity of quantities) {
    if (!Number.isFinite(quantity) || quantity < 0) return Number.NaN;
  }
  return quantities.reduce((total, quantity) => total + quantity, 0);
}

const RESOLVED_APPAREL: PersistedMerchantApparelOverrides = {
  gender: "male",
  ageGroup: "adult",
  condition: "new",
};

function variant(overrides: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    variantId: "cuid-black-m",
    pancakeVariationId: "pv-black-m",
    pancakeDisplayId: "LA-OXF-BLK-M",
    localSku: "SKU-INTERNAL-0001",
    color: "Đen",
    size: "M",
    sellableStock: 7,
    retailPrice: 890_000,
    retailPriceAfterDiscount: null,
    ...overrides,
  };
}

/** A two-variant standalone family that varies by size — the ordinary publishable shape. */
function catalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    pancakeProductId: "pancake-product-1",
    slug: "ao-oxford-relaxed",
    name: "Áo Oxford Relaxed",
    publishedDescription: "Áo sơ mi vải cotton, dáng suông.",
    gallery: [
      "https://cdn.example.test/oxford-den.jpg",
      "https://cdn.example.test/oxford-kem.jpg",
    ],
    variants: [
      variant(),
      variant({
        variantId: "cuid-black-l",
        pancakeVariationId: "pv-black-l",
        pancakeDisplayId: "LA-OXF-BLK-L",
        localSku: "SKU-INTERNAL-0002",
        size: "L",
      }),
    ],
    ...overrides,
  };
}

/**
 * The one projection both consumers read.
 *
 * Built by the production projection builder with the production promotion rule, so promotion-aware
 * price and stock-derived availability are decided exactly once, by the code the PDP renders with.
 */
function buildSharedProjection(product: CatalogProduct): StorefrontProductProjection {
  const parentVariants: StorefrontVariantFacts[] = product.variants.map((row) => ({
    id: row.variantId,
    pancakeVariationId: row.pancakeVariationId,
    color: row.color,
    size: row.size,
    sellableStock: storefrontSellableStock(row),
    retailPrice: row.retailPrice,
    retailPriceAfterDiscount: row.retailPriceAfterDiscount,
  }));

  const campaignsByVariantId = new Map<string, readonly ApplicablePromotionCampaign[]>(
    product.variants
      .filter((row) => row.campaigns !== undefined)
      .map((row) => [row.variantId, row.campaigns!]),
  );

  return buildStorefrontProductProjection({
    parentVariants,
    componentGroups: [],
    hasCompositeGraph: false,
    pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW }),
  });
}

function galleryIndexEntries(product: CatalogProduct): [string, number][] {
  return product.variants.map((row, index) => [
    row.variantId,
    Math.min(index, Math.max(product.gallery.length - 1, 0)),
  ]);
}

function toMerchantCandidate(
  product: CatalogProduct,
  projection: StorefrontProductProjection,
): MerchantCandidateProduct {
  const variations: MerchantCandidateVariation[] = product.variants.map((row) => ({
    variantId: row.variantId,
    pancakeVariationId: row.pancakeVariationId,
    pancakeDisplayId: row.pancakeDisplayId,
    isComposite: row.isComposite ?? false,
    stockQuantity: merchantStockQuantity(row),
  }));

  return {
    pancakeProductId: product.pancakeProductId,
    slug: product.slug,
    name: product.name,
    publishedDescription: product.publishedDescription,
    media: {
      primary: product.gallery[0] === undefined
        ? null
        : { url: product.gallery[0], alt: product.name },
      gallery: product.gallery.map((url, index) => ({
        url,
        alt: `${product.name} ${index + 1}`,
      })),
    } as MerchantCandidateProduct["media"],
    galleryIndexByVariantId: new Map(galleryIndexEntries(product)),
    projection,
    apparelOverrides: product.apparelOverrides ?? RESOLVED_APPAREL,
    variations,
  };
}

type StructuredDataProductInput = Parameters<
  typeof buildStorefrontProductStructuredData
>[0]["product"];

function toStructuredDataProduct(
  product: CatalogProduct,
  projection: StorefrontProductProjection,
): StructuredDataProductInput {
  return {
    pancakeProductId: product.pancakeProductId,
    slug: product.slug,
    name: product.name,
    editorialDescription: product.publishedDescription,
    media: {
      gallery: product.gallery.map((url, index) => ({
        url,
        alt: `${product.name} ${index + 1}`,
      })),
    },
    galleryIndexByVariantId: Object.fromEntries(galleryIndexEntries(product)),
    variantMpnById: Object.fromEntries(
      product.variants.map((row) => [row.variantId, row.pancakeDisplayId]),
    ),
    variantSkuById: {},
    // Server-only, keyed by internal id exactly like `variantMpnById`, and produced by the catalog
    // read that still holds the raw warehouse rows.
    variantAvailabilityResolvedById: Object.fromEntries(
      product.variants.map((row) => [
        row.variantId,
        resolveVariantAvailabilityFromWarehouseStocks(
          (row.warehouseQuantities ?? [row.sellableStock]).map((quantity) => ({ quantity })),
        ),
      ]),
    ),
    projection,
  };
}

/**
 * Reads the RSS a vendor would actually fetch.
 *
 * Scoped to `<item>` blocks and entity-decoded, so parity compares real values rather than escaped
 * source text — `&amp;` in a link must not read as a different URL from the JSON-LD one. The repo
 * carries no XML parser dependency and the serializer emits a fixed, non-nested element shape, so a
 * bounded reader here is the standards-faithful option without adding a dependency for tests.
 */
function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readItemElement(itemXml: string, element: string): string {
  const match = itemXml.match(new RegExp(`<${element}>([\\s\\S]*?)</${element}>`));
  assert.ok(match !== null, `serialized Merchant item is missing <${element}>`);
  return decodeXmlText(match[1]!);
}

function parseMerchantFeedParity(body: string): VariantCommerceParity[] {
  return [...body.matchAll(/<item>[\s\S]*?<\/item>/g)].map((match) => {
    const item = match[0];
    const rawPrice = readItemElement(item, "g:price");
    const [amount, currency] = rawPrice.split(" ");
    assert.equal(
      currency,
      TEST_ONLY_MERCHANT_MARKET.currency,
      "serialized price must carry the market currency token",
    );

    const availability = readItemElement(item, "g:availability");
    assert.ok(
      availability === "in_stock" ||
        availability === "out_of_stock" ||
        availability === "backorder",
      `unexpected Merchant availability ${availability}`,
    );

    return Object.freeze({
      variantExternalId: readItemElement(item, "g:id"),
      productExternalId: readItemElement(item, "g:item_group_id"),
      mpn: readItemElement(item, "g:mpn"),
      url: readItemElement(item, "g:link"),
      priceVnd: Number(amount),
      availability: availability as MerchantAvailability,
    });
  });
}

type JsonRecord = Record<string, unknown>;

function productGroupNode(document: unknown): JsonRecord | null {
  const graph = (document as JsonRecord)["@graph"];
  if (!Array.isArray(graph)) return null;
  return (
    (graph.find(
      (node) => (node as JsonRecord)["@type"] === "ProductGroup",
    ) as JsonRecord | undefined) ?? null
  );
}

function exactStandaloneProductNode(document: unknown): JsonRecord | null {
  const graph = (document as JsonRecord)["@graph"];
  if (!Array.isArray(graph)) return null;
  const product = graph.find(
    (node) => (node as JsonRecord)["@type"] === "Product",
  ) as JsonRecord | undefined;
  if (product === undefined || typeof product.url !== "string") return null;

  // An ordinary product-level fallback has the base PDP URL. Only a U12 variant deep-link proves
  // this top-level Product represents one exact survivor rather than generic product-level facts.
  return new URL(product.url).searchParams.has(VARIANT_QUERY_PARAM) ? product : null;
}

/**
 * The JSON-LD side's variation identity is not published as a bare field: it lives in the exact U12
 * deep link. Reading it back through the reviewed query-parameter name — rather than by slicing the
 * string — keeps this comparison inside the addressing contract that wrote the URL.
 */
function readVariationIdFromUrl(url: string): string {
  const value = new URL(url).searchParams.get(VARIANT_QUERY_PARAM);
  assert.ok(value !== null, `published variant URL carries no ?${VARIANT_QUERY_PARAM}`);
  return value;
}

function parseStructuredDataParity(document: unknown): VariantCommerceParity[] {
  const group = productGroupNode(document);
  const standalone = group === null ? exactStandaloneProductNode(document) : null;
  if (group === null && standalone === null) return [];

  const productExternalId = group === null ? null : String(group.productGroupID);
  const variants = group === null
    ? [standalone!]
    : ((group.hasVariant ?? []) as JsonRecord[]);

  return variants.map((node) => {
    const offer = node.offers as JsonRecord;
    const availability = String(offer.availability);
    assert.ok(
      availability.endsWith("/InStock") ||
        availability.endsWith("/OutOfStock") ||
        availability.endsWith("/BackOrder"),
      `unexpected JSON-LD availability ${availability}`,
    );
    assert.equal(offer.priceCurrency, "VND");

    const url = node.url as string;
    assert.equal(offer.url, url, "JSON-LD Offer.url must be the variant's own exact URL");

    return Object.freeze({
      variantExternalId: readVariationIdFromUrl(url),
      productExternalId,
      mpn: String(node.mpn),
      url,
      priceVnd: offer.price as number,
      // Normalised into the Merchant vocabulary so the two sides are compared as one fact rather
      // than through a mapping table the test itself owns.
      availability: availability.endsWith("/InStock")
        ? ("in_stock" as const)
        : availability.endsWith("/BackOrder")
          ? ("backorder" as const)
          : ("out_of_stock" as const),
    });
  });
}

type ParityRun = Readonly<{
  merchant: VariantCommerceParity[];
  jsonLd: VariantCommerceParity[];
  merchantExclusions: ReadonlyMap<string, readonly MerchantExclusionReason[]>;
  projection: StorefrontProductProjection;
}>;

function runParity(product: CatalogProduct): ParityRun {
  const projection = buildSharedProjection(product);

  const mapped = mapMerchantOffers({
    products: [toMerchantCandidate(product, projection)],
    origin: ORIGIN,
  });
  const feed = serializeMerchantFeed({
    offers: mapped.offers,
    market: TEST_ONLY_MERCHANT_MARKET,
    origin: ORIGIN,
  });

  const document = buildStorefrontProductStructuredData({
    origin: ORIGIN,
    product: toStructuredDataProduct(product, projection),
  });

  const byId = (left: VariantCommerceParity, right: VariantCommerceParity) =>
    left.variantExternalId.localeCompare(right.variantExternalId, "en");

  return Object.freeze({
    merchant: parseMerchantFeedParity(feed.body).sort(byId),
    jsonLd: parseStructuredDataParity(document).sort(byId),
    merchantExclusions: new Map(
      mapped.excluded.map((row) => [row.pancakeVariationId ?? "<none>", row.reasons]),
    ),
    projection,
  });
}

function publishedIds(rows: readonly VariantCommerceParity[]): string[] {
  return rows.map((row) => row.variantExternalId);
}

describe("Merchant feed ↔ U27 variant JSON-LD parity", () => {
  it("publishes one identical commerce truth for an ordinary in-stock standalone variant", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [variant(), variant({
          variantId: "cuid-black-l",
          pancakeVariationId: "pv-black-l",
          pancakeDisplayId: "LA-OXF-BLK-L",
          localSku: "SKU-INTERNAL-0002",
          size: "L",
        })],
      }),
    );

    assert.deepEqual(merchant, jsonLd);
    assert.equal(merchant.length, 2);

    const first = merchant[0]!;
    assert.equal(first.variantExternalId, "pv-black-l");
    assert.equal(first.productExternalId, "pancake-product-1");
    assert.equal(first.mpn, "LA-OXF-BLK-L");
    assert.equal(first.url, `${ORIGIN}/shop/ao-oxford-relaxed?variant=pv-black-l`);
    assert.equal(first.priceVnd, 890_000);
    assert.equal(first.availability, "in_stock");
  });

  it("keeps a zero-stock variant a valid offer with the same out-of-stock meaning on both sides", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            sellableStock: 0,
          }),
        ],
      }),
    );

    assert.deepEqual(merchant, jsonLd);
    const soldOut = merchant.find((row) => row.variantExternalId === "pv-black-l");
    assert.ok(soldOut !== undefined, "a zero-stock variant stays publishable on both sides");
    assert.equal(soldOut.availability, "out_of_stock");
    // Sold out is a stock fact, not a pricing one: the exact price is still published.
    assert.equal(soldOut.priceVnd, 890_000);
  });

  it("publishes the same promotion-aware price and never falls back to the base price", () => {
    const campaign: ApplicablePromotionCampaign = {
      id: "campaign-flash",
      name: "Flash Sale",
      kind: "FLASH_SALE",
      discountType: "PERCENTAGE",
      percentageValue: 20,
      fixedPriceVnd: null,
      startsAt: new Date("2026-09-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-30T00:00:00.000Z"),
    };

    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant({ campaigns: [campaign] }),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
          }),
        ],
      }),
    );

    assert.deepEqual(merchant, jsonLd);
    const discounted = merchant.find((row) => row.variantExternalId === "pv-black-m");
    assert.ok(discounted !== undefined);
    assert.equal(discounted.priceVnd, 712_000);
    assert.notEqual(discounted.priceVnd, 890_000, "the raw base price must never be published");

    const undiscounted = merchant.find((row) => row.variantExternalId === "pv-black-l");
    assert.equal(undiscounted?.priceVnd, 890_000);
  });

  it("publishes one exact U12 variant URL that reopens the same option on both sides", () => {
    const product = catalogProduct();
    const { merchant, jsonLd, projection } = runParity(product);

    assert.deepEqual(publishedIds(merchant), publishedIds(jsonLd));
    for (const [index, row] of merchant.entries()) {
      const counterpart = jsonLd[index]!;
      assert.equal(row.url, counterpart.url);
      assert.equal(row.variantExternalId, counterpart.variantExternalId);

      const parsed = new URL(row.url);
      assert.equal(parsed.origin, ORIGIN);
      assert.equal(parsed.pathname, "/shop/ao-oxford-relaxed");

      // Not a substring check, and not merely "the resolver answered something": each published
      // identity is fed back through the U12 resolver and must land on the internal option the
      // fixture says owns it. A resolver that ever matched a near neighbour would satisfy a
      // non-null check while silently publishing a link to the wrong variant.
      const expectedVariantId = product.variants.find(
        (candidate) => candidate.pancakeVariationId === row.variantExternalId,
      )?.variantId;
      assert.ok(expectedVariantId !== undefined, "published id must belong to a fixture variant");

      for (const url of [row.url, counterpart.url]) {
        const reselected = resolveDeepLinkedVariantSelection({
          projection,
          variantQuery: new URL(url).searchParams.get(VARIANT_QUERY_PARAM),
        });
        assert.ok(reselected !== null, "a published variant URL must reopen its own variant");
        assert.equal(
          reselected.variantId,
          expectedVariantId,
          "both consumers' URLs must reopen the same internal option, not merely resolve",
        );
      }
    }
  });

  it("publishes the ADR 0008 manufacturer MPN on both sides, never the website-local SKU", () => {
    const product = catalogProduct();
    const { merchant, jsonLd } = runParity(product);

    assert.deepEqual(merchant, jsonLd);
    const localSkus = new Set(product.variants.map((row) => row.localSku));
    const internalIds = new Set(product.variants.map((row) => row.variantId));

    for (const row of merchant) {
      const source = product.variants.find(
        (candidate) => candidate.pancakeVariationId === row.variantExternalId,
      );
      assert.equal(row.mpn, source?.pancakeDisplayId);
      assert.equal(localSkus.has(row.mpn), false, "a local SKU is never a manufacturer MPN");
      assert.equal(internalIds.has(row.mpn), false, "a local CUID is never a manufacturer MPN");
      assert.notEqual(row.mpn, row.variantExternalId, "the variation id is never a fake MPN");
    }
  });

  for (const [label, mpn] of [
    ["missing", null],
    ["blank", ""],
    ["untrimmed", " LA-OXF-BLK-L "],
  ] as const) {
    it(`fails closed on both sides for a ${label} manufacturer MPN`, () => {
      const { merchant, jsonLd } = runParity(
        catalogProduct({
          variants: [
            variant(),
            variant({
              variantId: "cuid-black-l",
              pancakeVariationId: "pv-black-l",
              pancakeDisplayId: mpn,
              size: "L",
            }),
            variant({
              variantId: "cuid-black-xl",
              pancakeVariationId: "pv-black-xl",
              pancakeDisplayId: "LA-OXF-BLK-XL",
              size: "XL",
            }),
          ],
        }),
      );

      assert.equal(
        publishedIds(merchant).includes("pv-black-l"),
        false,
        "Merchant must exclude a variant without a usable MPN",
      );
      assert.equal(
        publishedIds(jsonLd).includes("pv-black-l"),
        false,
        "JSON-LD must not publish a variant without a usable MPN",
      );
      assert.deepEqual(publishedIds(merchant), publishedIds(jsonLd));
    });
  }

  it("fails closed on both sides when two variants claim the same manufacturer MPN", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant({ pancakeDisplayId: "LA-OXF-DUPLICATE" }),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-DUPLICATE",
            size: "L",
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: "LA-OXF-BLK-XL",
            size: "XL",
          }),
          variant({
            variantId: "cuid-black-xxl",
            pancakeVariationId: "pv-black-xxl",
            pancakeDisplayId: "LA-OXF-BLK-XXL",
            size: "XXL",
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), ["pv-black-xl", "pv-black-xxl"]);
    assert.deepEqual(publishedIds(jsonLd), publishedIds(merchant));
  });

  /**
   * MPN uniqueness has to be judged over the same set on both sides.
   *
   * Merchant decides each candidate on its own facts first and only then looks for duplicates among
   * the survivors, so a variant already excluded for unresolved availability or an unresolved price
   * cannot make a sibling's part number ambiguous. U27 counted MPNs across every projection option,
   * so an already-doomed variant still poisoned a perfectly good sibling — and the two consumers
   * published different sets without either one being "wrong" about duplicates.
   */
  for (const [label, brokenOverrides] of [
    ["unresolved availability", { warehouseQuantities: [5, -3] }],
    ["an unresolved price", { retailPrice: null, retailPriceAfterDiscount: null }],
  ] as const) {
    it(`does not let a variant excluded for ${label} poison a sibling's MPN uniqueness`, () => {
      const { merchant, jsonLd } = runParity(
        catalogProduct({
          variants: [
            // A and B share a part number, but B is excluded on its own facts before uniqueness
            // is even a question, so A is the only claimant left and stays publishable.
            variant({ pancakeDisplayId: "LA-OXF-DUP" }),
            variant({
              variantId: "cuid-black-l",
              pancakeVariationId: "pv-black-l",
              pancakeDisplayId: "LA-OXF-DUP",
              size: "L",
              ...brokenOverrides,
            }),
            variant({
              variantId: "cuid-black-xl",
              pancakeVariationId: "pv-black-xl",
              pancakeDisplayId: "LA-OXF-BLK-XL",
              size: "XL",
            }),
            variant({
              variantId: "cuid-black-xxl",
              pancakeVariationId: "pv-black-xxl",
              pancakeDisplayId: "LA-OXF-BLK-XXL",
              size: "XXL",
            }),
          ],
        }),
      );

      assert.deepEqual(
        publishedIds(merchant),
        ["pv-black-m", "pv-black-xl", "pv-black-xxl"],
        "Merchant dedupes among the candidates that survived their own checks",
      );
      assert.deepEqual(
        publishedIds(jsonLd),
        publishedIds(merchant),
        "U27 must judge uniqueness over the same surviving set, not over every option",
      );
      assert.deepEqual(merchant, jsonLd);
    });
  }

  it("still excludes both claimants when two publishable variants share one MPN", () => {
    // The narrowing must not weaken the rule it narrows: when both claimants are otherwise
    // publishable the catalog cannot say which one the part number names, so neither is published.
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant({ pancakeDisplayId: "LA-OXF-DUP" }),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-DUP",
            size: "L",
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: "LA-OXF-BLK-XL",
            size: "XL",
          }),
          variant({
            variantId: "cuid-black-xxl",
            pancakeVariationId: "pv-black-xxl",
            pancakeDisplayId: "LA-OXF-BLK-XXL",
            size: "XXL",
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), ["pv-black-xl", "pv-black-xxl"]);
    assert.deepEqual(publishedIds(jsonLd), publishedIds(merchant));
  });

  it("fails closed on both sides when a variant's price never resolved", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            retailPrice: null,
            retailPriceAfterDiscount: null,
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: "LA-OXF-BLK-XL",
            size: "XL",
          }),
        ],
      }),
    );

    assert.equal(publishedIds(merchant).includes("pv-black-l"), false);
    assert.equal(publishedIds(jsonLd).includes("pv-black-l"), false);
    assert.deepEqual(publishedIds(merchant), publishedIds(jsonLd));
    // No `0`, no minimum, no base-price stand-in anywhere in either output.
    assert.equal(merchant.some((row) => row.priceVnd <= 0), false);
    assert.equal(jsonLd.some((row) => row.priceVnd <= 0), false);
  });

  it("publishes matching availability for every resolvable stock shape", () => {
    // Both consumers reduce the same warehouse rows to the same verdict wherever the quantity is a
    // usable number: no rows and an explicit zero both sum to 0 (out of stock), a positive sum is in
    // stock. This is the whole resolvable domain, and it matches.
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant({ sellableStock: 12 }),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            sellableStock: 0,
          }),
        ],
      }),
    );

    assert.deepEqual(merchant, jsonLd);
    assert.deepEqual(
      merchant.map((row) => [row.variantExternalId, row.availability]),
      [
        ["pv-black-l", "out_of_stock"],
        ["pv-black-m", "in_stock"],
      ],
    );
  });

  /**
   * U27a — the convergence this file previously only documented.
   *
   * A negative mirrored warehouse quantity is not a stock fact. M1 refuses the whole variant, so the
   * feed omits the offer; before U27a the storefront summed the row as ordinary arithmetic and U27
   * published an exact availability claim the feed had already declined to make.
   *
   * The rule is per-row, not per-total, which is why the mixed cases matter more than `[-3]`:
   * `[5, -3]` sums to a perfectly ordinary 2. A convergence keyed on "the total went negative"
   * would pass `[-3]` and still publish a false `InStock` for `[5, -3]`.
   *
   * The shopper-facing page is deliberately untouched: the PDP still prices and sells `[5, -3]` as
   * two units. Only the exact machine-readable claim is withheld.
   */
  for (const [label, warehouseQuantities, storefrontTotal] of [
    ["a single negative row", [-3], -3],
    ["a negative row under a positive total", [5, -3], 2],
    ["a negative row under a zero total", [3, -3], 0],
    ["one tiny negative row under a large total", [100, -1], 99],
  ] as const) {
    it(`omits the exact variant offer on both sides for ${label}`, () => {
      const product = catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            warehouseQuantities,
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: "LA-OXF-BLK-XL",
            size: "XL",
          }),
        ],
      });
      const { merchant, jsonLd, merchantExclusions, projection } = runParity(product);

      assert.deepEqual(
        merchantExclusions.get("pv-black-l"),
        ["AVAILABILITY_UNRESOLVED"],
        "Merchant reports unresolved availability rather than guessing a stock state",
      );
      assert.equal(publishedIds(merchant).includes("pv-black-l"), false);
      assert.equal(
        publishedIds(jsonLd).includes("pv-black-l"),
        false,
        "U27 must not publish an availability claim the feed refused to make",
      );

      // Not translated into some other claim either: the variant is absent, not relabelled.
      assert.equal(
        jsonLd.some((row) => row.variantExternalId === "pv-black-l"),
        false,
      );

      // The shopper-facing projection is untouched — this is a publication rule, not a stock one.
      const option = projection.options.find((candidate) => candidate.id === "cuid-black-l");
      assert.ok(option !== undefined);
      assert.equal(option.price, 890_000, "an unresolved row must not disturb PDP pricing");
      assert.equal(
        option.purchasable,
        storefrontTotal > 0,
        "the PDP keeps its own arithmetic and its own sold-out verdict",
      );

      // Every well-formed sibling still publishes identically on both sides.
      assert.deepEqual(publishedIds(merchant), ["pv-black-m", "pv-black-xl"]);
      assert.deepEqual(merchant, jsonLd);
    });
  }

  for (const [label, warehouseQuantities, availability] of [
    ["no warehouse rows at all", [], "out_of_stock"],
    ["an explicit zero row", [0], "out_of_stock"],
    ["a single positive row", [5], "in_stock"],
    ["several well-formed rows", [2, 3], "in_stock"],
  ] as const) {
    it(`keeps ${label} publishable and identical on both sides`, () => {
      const { merchant, jsonLd } = runParity(
        catalogProduct({
          variants: [
            variant(),
            variant({
              variantId: "cuid-black-l",
              pancakeVariationId: "pv-black-l",
              pancakeDisplayId: "LA-OXF-BLK-L",
              size: "L",
              warehouseQuantities,
            }),
          ],
        }),
      );

      assert.deepEqual(merchant, jsonLd);
      const row = merchant.find((candidate) => candidate.variantExternalId === "pv-black-l");
      assert.ok(row !== undefined, "a well-formed variant stays publishable");
      assert.equal(row.availability, availability);
      assert.equal(row.priceVnd, 890_000);
    });
  }

  /**
   * Owner-approved family-collapse convergence.
   *
   * Merchant still carries `item_group_id`, while the collapsed JSON-LD representation is a
   * standalone Product and therefore has no ProductGroup identity to read back. The exact survivor
   * facts both representations actually share — variation identity, MPN, U12 URL, price and
   * availability — must nevertheless be byte-for-value identical.
   */
  it("publishes the family-collapse survivor as the same exact standalone variant", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            warehouseQuantities: [4, -1],
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), ["pv-black-m"]);
    assert.deepEqual(publishedIds(jsonLd), ["pv-black-m"]);

    const merchantSurvivor = merchant[0]!;
    const jsonLdSurvivor = jsonLd[0]!;
    const { productExternalId: merchantGroupId, ...merchantSharedFacts } = merchantSurvivor;
    const { productExternalId: jsonLdGroupId, ...jsonLdSharedFacts } = jsonLdSurvivor;

    assert.equal(merchantGroupId, "pancake-product-1");
    assert.equal(jsonLdGroupId, null, "a standalone Product must not invent ProductGroup identity");
    assert.deepEqual(
      merchantSharedFacts,
      jsonLdSharedFacts,
      "both consumers must publish the same exact survivor facts they share",
    );
    // The excluded variant is absent from both sides — the availability convergence still holds.
    assert.equal(publishedIds(merchant).includes("pv-black-l"), false);
    assert.equal(publishedIds(jsonLd).includes("pv-black-l"), false);
  });

  it("publishes the promotion-aware survivor price after a family collapse", () => {
    // The approved one-survivor contract names the *promotion-aware* price, not merely a matching
    // one. A collapsed survivor takes a different serialization path from a ProductGroup member, so
    // the discount has to be proved on that path rather than inferred from the family case.
    const campaign: ApplicablePromotionCampaign = {
      id: "campaign-flash",
      name: "Flash Sale",
      kind: "FLASH_SALE",
      discountType: "PERCENTAGE",
      percentageValue: 20,
      fixedPriceVnd: null,
      startsAt: new Date("2026-09-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-30T00:00:00.000Z"),
    };

    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant({ campaigns: [campaign] }),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            // Excluded for unresolvable availability, collapsing the family to one survivor.
            warehouseQuantities: [4, -1],
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), ["pv-black-m"]);
    assert.deepEqual(publishedIds(jsonLd), ["pv-black-m"]);

    const merchantSurvivor = merchant[0]!;
    const jsonLdSurvivor = jsonLd[0]!;
    assert.equal(merchantSurvivor.priceVnd, 712_000);
    assert.equal(
      jsonLdSurvivor.priceVnd,
      712_000,
      "the collapsed standalone survivor must publish the discounted price the page charges",
    );
    assert.notEqual(
      jsonLdSurvivor.priceVnd,
      890_000,
      "the raw base price must never be published for a collapsed survivor",
    );

    const { productExternalId: merchantGroupId, ...merchantSharedFacts } = merchantSurvivor;
    const { productExternalId: jsonLdGroupId, ...jsonLdSharedFacts } = jsonLdSurvivor;
    assert.equal(merchantGroupId, "pancake-product-1");
    assert.equal(jsonLdGroupId, null, "a standalone Product must not invent ProductGroup identity");
    assert.deepEqual(merchantSharedFacts, jsonLdSharedFacts);
  });

  it("fails closed on both sides for an unaddressable variation identity", () => {
    // Two rows claiming one external identity: U12 refuses to say which option the link names, so
    // neither consumer may publish either row as an exact standalone offer.
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-m",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), []);
    assert.deepEqual(publishedIds(jsonLd), []);
  });

  it("publishes no standalone variant offer for a composite set on either side", () => {
    const product = catalogProduct({
      variants: [
        variant({ isComposite: true }),
        variant({
          variantId: "cuid-black-l",
          pancakeVariationId: "pv-black-l",
          pancakeDisplayId: "LA-OXF-BLK-L",
          size: "L",
          isComposite: true,
        }),
      ],
    });

    const projection = buildSharedProjection(product);
    const compositeProjection: StorefrontProductProjection = {
      mode: "composite",
      options: projection.options,
    };

    const mapped = mapMerchantOffers({
      products: [toMerchantCandidate(product, compositeProjection)],
      origin: ORIGIN,
    });
    const document = buildStorefrontProductStructuredData({
      origin: ORIGIN,
      product: toStructuredDataProduct(product, compositeProjection),
    });

    assert.deepEqual(mapped.offers, []);
    for (const excluded of mapped.excluded) {
      assert.deepEqual(excluded.reasons, ["COMPOSITE_DEFERRED"]);
    }
    // The negative invariant is shared; the diagnostic vocabulary deliberately is not.
    assert.equal(productGroupNode(document), null);
  });

  it("groups every published sibling under the same external product identity", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: "LA-OXF-BLK-XL",
            size: "XL",
          }),
        ],
      }),
    );

    assert.deepEqual(merchant, jsonLd);
    assert.equal(merchant.length, 3);

    const product = catalogProduct();
    for (const row of merchant) {
      assert.equal(row.productExternalId, "pancake-product-1");
      assert.notEqual(row.productExternalId, product.slug, "a slug is not a group identity");
      assert.notEqual(row.productExternalId, row.mpn, "an MPN is not a group identity");
      assert.notEqual(
        row.productExternalId,
        row.variantExternalId,
        "a variation id is not a group identity",
      );
    }
    assert.equal(new Set(jsonLd.map((row) => row.productExternalId)).size, 1);
  });

  it("publishes the same eligible standalone variant set from one mixed catalog fixture", () => {
    const { merchant, jsonLd } = runParity(
      catalogProduct({
        variants: [
          variant(),
          variant({
            variantId: "cuid-black-l",
            pancakeVariationId: "pv-black-l",
            pancakeDisplayId: "LA-OXF-BLK-L",
            size: "L",
            sellableStock: 0,
          }),
          variant({
            variantId: "cuid-black-xl",
            pancakeVariationId: "pv-black-xl",
            pancakeDisplayId: null,
            size: "XL",
          }),
          variant({
            variantId: "cuid-black-xxl",
            pancakeVariationId: "pv-black-xxl",
            pancakeDisplayId: "LA-OXF-BLK-XXL",
            size: "XXL",
            retailPrice: null,
            retailPriceAfterDiscount: null,
          }),
        ],
      }),
    );

    assert.deepEqual(publishedIds(merchant), ["pv-black-l", "pv-black-m"]);
    assert.deepEqual(publishedIds(jsonLd), publishedIds(merchant));
    assert.deepEqual(merchant, jsonLd);
  });
});
