import assert from "node:assert/strict";
import test from "node:test";

import { vietnamCalendarDate } from "../../src/commerce/availability-cycle.ts";
import { serializeMerchantFeed } from "../../src/commerce/merchant-feed-serializer.ts";
import { mapMerchantOffers } from "../../src/commerce/merchant-offer-mapper.ts";
import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import {
  buildStorefrontProductProjection,
  deriveStorefrontProjectionSelection,
} from "../../src/commerce/storefront-projection.ts";
import { buildStorefrontProductStructuredData } from "../../src/seo/storefront-product-structured-data.ts";

/**
 * I9 — Merchant, JSON-LD and the product page, from one projection.
 *
 * The other suites test each piece. This one exists because ADR 0011's actual requirement is a
 * relationship *between* pieces: "Merchant feed and JSON-LD must consume the same canonical
 * projection/date". A bug that satisfied every module test and still published `backorder` in the
 * feed while the markup said `InStock` would be invisible to all of them.
 *
 * So everything below builds ONE projection and reads all three surfaces off it, exactly as the
 * repositories do.
 */

const ORIGIN = "https://la.example.test";
const NOW = new Date("2026-09-18T03:00:00.000Z");
const TODAY = vietnamCalendarDate(NOW)!;
const IMAGE = "https://content.pancake.vn/web-media/1/2/3/primary.jpg";
const MARKET = { targetCountry: "VN", contentLanguage: "vi", currency: "VND" } as const;

const SIZE_M = "variant-m";
const SIZE_L = "variant-l";

function projectionFor(
  stockBySize: Readonly<{ m: number; l: number }>,
  datesByVariantId: ReadonlyMap<string, string | null>,
  sellingMode: "STANDARD" | "PREORDER" = "PREORDER",
) {
  const parentVariants: StorefrontVariantFacts[] = [
    {
      id: SIZE_M,
      pancakeVariationId: "pv-m",
      color: "Đen",
      size: "M",
      sellableStock: stockBySize.m,
      retailPrice: 890_000,
      retailPriceAfterDiscount: 890_000,
    },
    {
      id: SIZE_L,
      pancakeVariationId: "pv-l",
      color: "Đen",
      size: "L",
      sellableStock: stockBySize.l,
      retailPrice: 890_000,
      retailPriceAfterDiscount: 890_000,
    },
  ];

  return buildStorefrontProductProjection({
    parentVariants,
    componentGroups: [],
    hasCompositeGraph: false,
    sellingPolicy: { sellingMode, negativeStockLimit: -20 },
    availabilityDates: { byVariantId: datesByVariantId, today: TODAY },
  });
}

function surfaces(projection: ReturnType<typeof projectionFor>) {
  const media = resolveStorefrontProductMedia({
    productName: "Áo sơ mi Oxford",
    primaryImageUrl: IMAGE,
    variantImageUrls: [[IMAGE]],
  });

  const merchant = mapMerchantOffers({
    products: [
      {
        pancakeProductId: "pp-1",
        slug: "ao-so-mi-oxford",
        name: "Áo sơ mi Oxford",
        publishedDescription: "Áo sơ mi vải cotton.",
        media,
        galleryIndexByVariantId: new Map([
          [SIZE_M, 0],
          [SIZE_L, 0],
        ]),
        projection,
        apparelOverrides: { gender: null, ageGroup: null, condition: null },
        variations: [
          {
            variantId: SIZE_M,
            pancakeVariationId: "pv-m",
            pancakeDisplayId: "LA-OXF-M",
            isComposite: false,
            stockQuantity: 0,
          },
          {
            variantId: SIZE_L,
            pancakeVariationId: "pv-l",
            pancakeDisplayId: "LA-OXF-L",
            isComposite: false,
            stockQuantity: 0,
          },
        ],
      },
    ],
    origin: ORIGIN,
  });

  const structuredData = buildStorefrontProductStructuredData({
    product: {
      pancakeProductId: "pp-1",
      slug: "ao-so-mi-oxford",
      name: "Áo sơ mi Oxford",
      editorialDescription: "Áo sơ mi vải cotton.",
      media,
      galleryIndexByVariantId: { [SIZE_M]: 0, [SIZE_L]: 0 },
      variantMpnById: { [SIZE_M]: "LA-OXF-M", [SIZE_L]: "LA-OXF-L" },
      variantSkuById: { [SIZE_M]: null, [SIZE_L]: null },
      variantAvailabilityResolvedById: { [SIZE_M]: true, [SIZE_L]: true },
      projection,
    },
    origin: ORIGIN,
  });

  return { merchant, structuredData };
}

/** Every `Offer` node anywhere in the JSON-LD, keyed by the variant URL it belongs to. */
function offersByUrl(structuredData: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const offers = record.offers;
    if (offers !== null && typeof offers === "object" && !Array.isArray(offers)) {
      const offer = offers as Record<string, unknown>;
      if (typeof offer.url === "string") found.set(offer.url, offer);
    }
    Object.values(record).forEach(walk);
  };
  walk(structuredData);
  return found;
}

test("I9 a preorder sell-out publishes backorder and the same date on both surfaces", () => {
  const projection = projectionFor(
    { m: 0, l: 0 },
    new Map([
      [SIZE_M, "2026-10-03"],
      [SIZE_L, "2026-10-03"],
    ]),
  );
  const { merchant, structuredData } = surfaces(projection);

  assert.deepEqual(merchant.excluded, []);
  const offer = merchant.offers.find((row) => row.id === "pv-m")!;
  assert.equal(offer.availability, "backorder");
  assert.equal(offer.availabilityDate, "2026-10-03");

  const feed = serializeMerchantFeed({ offers: merchant.offers, market: MARKET, origin: ORIGIN });
  assert.match(
    feed.body,
    /<g:availability_date>2026-10-03T00:00\+0700<\/g:availability_date>/,
    "Merchant serializes the canonical Vietnam day with its required timezone",
  );

  const jsonLd = offersByUrl(structuredData).get(`${ORIGIN}/shop/ao-so-mi-oxford?variant=pv-m`)!;
  assert.equal(jsonLd.availability, "https://schema.org/BackOrder");
  assert.equal(
    jsonLd.availabilityStarts,
    "2026-10-03T00:00:00+07:00",
    "JSON-LD serializes the same canonical day as a timezone-qualified DateTime",
  );
});

test("I9 two sizes that sold out on different days keep their own dates on both surfaces", () => {
  // Owner rule 1 is per variant, so a product-level date would be wrong for at least one size.
  const projection = projectionFor(
    { m: 0, l: 0 },
    new Map([
      [SIZE_M, "2026-10-03"],
      [SIZE_L, "2026-10-10"],
    ]),
  );
  const { merchant, structuredData } = surfaces(projection);
  const jsonLd = offersByUrl(structuredData);

  for (const [variantId, external, expected] of [
    [SIZE_M, "pv-m", "2026-10-03"],
    [SIZE_L, "pv-l", "2026-10-10"],
  ] as const) {
    const offer = merchant.offers.find((row) => row.id === external)!;
    assert.equal(offer.availabilityDate, expected, `${variantId} keeps its own date in the feed`);
    assert.equal(
      jsonLd.get(`${ORIGIN}/shop/ao-so-mi-oxford?variant=${external}`)!.availabilityStarts,
      expected,
      `${variantId} keeps its own date in the markup`,
    );
  }
});

test("I9 an expired date withholds the offer from both surfaces rather than publishing either half", () => {
  // Owner rule 8. The shopper may still be offered `Đặt trước` by the capacity policy — the two
  // surfaces are allowed to differ there, because only these are making a dated public promise.
  const projection = projectionFor(
    { m: 0, l: 0 },
    new Map([
      [SIZE_M, "2026-09-17"],
      [SIZE_L, "2026-09-17"],
    ]),
  );
  const { merchant, structuredData } = surfaces(projection);

  assert.equal(merchant.offers.length, 0, "no feed offer without a current date");
  assert.deepEqual(
    merchant.excluded.map((row) => row.reasons).flat(),
    ["AVAILABILITY_UNRESOLVED", "AVAILABILITY_UNRESOLVED"],
  );
  for (const offer of offersByUrl(structuredData).values()) {
    assert.notEqual(offer.availability, "https://schema.org/BackOrder");
    // And never relabelled: `OutOfStock` would contradict a checkout still accepting the order.
    assert.notEqual(offer.availability, "https://schema.org/OutOfStock");
  }
});

test("I9 a standard sold-out product is out of stock on both surfaces, with no date", () => {
  const projection = projectionFor({ m: 0, l: 0 }, new Map(), "STANDARD");
  const { merchant, structuredData } = surfaces(projection);

  const offer = merchant.offers.find((row) => row.id === "pv-m")!;
  assert.equal(offer.availability, "out_of_stock");
  assert.equal(offer.availabilityDate, null);

  const jsonLd = offersByUrl(structuredData).get(`${ORIGIN}/shop/ao-so-mi-oxford?variant=pv-m`)!;
  assert.equal(jsonLd.availability, "https://schema.org/OutOfStock");
  assert.equal(Object.hasOwn(jsonLd, "availabilityStarts"), false);
});

test("I9 a preorder variant that still has ready stock is in stock, with no date", () => {
  // ADR 0011: no external preorder label while the product is ready — it is already released, and
  // Google's `preorder` means unreleased.
  const projection = projectionFor({ m: 4, l: 4 }, new Map([[SIZE_M, "2026-10-03"]]));
  const { merchant, structuredData } = surfaces(projection);

  const offer = merchant.offers.find((row) => row.id === "pv-m")!;
  assert.equal(offer.availability, "in_stock");
  assert.equal(offer.availabilityDate, null, "a stale cycle date must not ride an in-stock offer");

  const jsonLd = offersByUrl(structuredData).get(`${ORIGIN}/shop/ao-so-mi-oxford?variant=pv-m`)!;
  assert.equal(jsonLd.availability, "https://schema.org/InStock");
  assert.equal(Object.hasOwn(jsonLd, "availabilityStarts"), false);
});

test("I9 the product page shows only the selected variant's date", () => {
  // Owner rule 10, from the same projection the two published surfaces just used.
  const projection = projectionFor(
    { m: 0, l: 0 },
    new Map([
      [SIZE_M, "2026-10-03"],
      [SIZE_L, "2026-10-10"],
    ]),
  );

  const nothingSelected = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: null,
  });
  assert.equal(nothingSelected.selectedAvailabilityDate, null, "no date before a size is chosen");

  const chosenM = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: "Đen",
    size: "M",
  });
  assert.equal(chosenM.selectedAvailabilityDate, "2026-10-03");

  const chosenL = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: "Đen",
    size: "L",
  });
  assert.equal(chosenL.selectedAvailabilityDate, "2026-10-10", "never the other size's date");
});

test("I9 the product page hides the date once it has lapsed", () => {
  const projection = projectionFor({ m: 0, l: 0 }, new Map([[SIZE_M, "2026-09-17"]]));
  const chosenM = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: "Đen",
    size: "M",
  });

  assert.equal(chosenM.selectedAvailabilityDate, null);
  // The shopper can still buy it — owner rule 8 keeps `Đặt trước` under the capacity policy, and
  // only the dated promise stops.
  assert.equal(chosenM.canAdd, true);
});
