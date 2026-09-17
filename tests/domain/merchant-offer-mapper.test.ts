/**
 * U25 / #153 M3 — the deterministic standalone Merchant offer mapper.
 *
 * Every fixture below is canonical storefront input: the projection is the one the product page
 * builds, the media is the one the trusted resolver returns, and the price is the one the storefront
 * charges. The mapper's whole job is to turn those facts into a Merchant item or into a bounded
 * exclusion reason, so the tests are written to fail if it ever invents a fact instead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_MERCHANT_MARKET,
  MERCHANT_BRAND,
  MERCHANT_COLOR_MAX_LENGTH,
  MERCHANT_DESCRIPTION_MAX_LENGTH,
  MERCHANT_MARKET_UNRESOLVED,
  MERCHANT_SIZE_MAX_LENGTH,
  MERCHANT_TITLE_MAX_LENGTH,
  mapMerchantOffers,
  type MerchantCandidateProduct,
  type MerchantCandidateVariation,
} from "../../src/commerce/merchant-offer-mapper.ts";
import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import type {
  StorefrontProductProjection,
  StorefrontProjectionOption,
} from "../../src/commerce/storefront-projection.ts";

const ORIGIN = "https://la.example.test";

const TRUSTED_PRIMARY = "https://content.pancake.vn/web-media/1/2/3/primary.jpg";
const TRUSTED_VARIANT_M = "https://content.pancake.vn/web-media/1/2/3/variant-m.jpg";
const TRUSTED_VARIANT_L = "https://content.pancake.vn/web-media/1/2/3/variant-l.jpg";

function option(overrides: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  return {
    id: "variant-m",
    pancakeVariationId: "pv-m",
    color: "Den",
    size: "M",
    price: 890_000,
    basePriceVnd: 890_000,
    isDiscounted: false,
    purchasable: true,
    isPreorderSale: false,
    unavailableReason: null,
    kindKey: null,
    kindLabel: null,
    ...overrides,
  };
}

function variation(
  overrides: Partial<MerchantCandidateVariation> = {},
): MerchantCandidateVariation {
  return {
    variantId: "variant-m",
    pancakeVariationId: "pv-m",
    pancakeDisplayId: "A132-M",
    isComposite: false,
    stockQuantity: 4,
    ...overrides,
  };
}

function media(urls: readonly string[] = [TRUSTED_PRIMARY, TRUSTED_VARIANT_M, TRUSTED_VARIANT_L]) {
  return resolveStorefrontProductMedia({
    productName: "Ao so mi Oxford",
    primaryImageUrl: urls[0] ?? null,
    variantImageUrls: [urls.slice(1)],
  });
}

function product(overrides: Partial<MerchantCandidateProduct> = {}): MerchantCandidateProduct {
  const projection: StorefrontProductProjection = {
    mode: "standalone",
    options: [option()],
  };

  return {
    pancakeProductId: "pp-1",
    slug: "ao-so-mi-oxford",
    name: "Ao so mi Oxford",
    publishedDescription: "Ao so mi vai cotton, dang suong.",
    media: media(),
    galleryIndexByVariantId: new Map([["variant-m", 1]]),
    projection,
    apparelOverrides: { gender: null, ageGroup: null, condition: null },
    variations: [variation()],
    ...overrides,
  };
}

function mapOne(overrides: Partial<MerchantCandidateProduct> = {}) {
  return mapMerchantOffers({ products: [product(overrides)], origin: ORIGIN });
}

function onlyExclusionReasons(overrides: Partial<MerchantCandidateProduct> = {}) {
  const result = mapOne(overrides);
  assert.equal(result.offers.length, 0, "expected the candidate to be excluded");
  assert.equal(result.excluded.length, 1);
  return result.excluded[0]!.reasons;
}

// --- Identity -----------------------------------------------------------------------------------

test("M3 a valid standalone variation maps to a complete Merchant offer", () => {
  const result = mapOne();

  assert.deepEqual(result.excluded, []);
  assert.equal(result.offers.length, 1);
  assert.deepEqual(result.offers[0], {
    id: "pv-m",
    itemGroupId: "pp-1",
    brand: "La.na Design",
    mpn: "A132-M",
    title: "Ao so mi Oxford",
    description: "Ao so mi vai cotton, dang suong.",
    link: "https://la.example.test/shop/ao-so-mi-oxford?variant=pv-m",
    imageLink: TRUSTED_VARIANT_M,
    additionalImageLinks: [TRUSTED_PRIMARY, TRUSTED_VARIANT_L],
    availability: "in_stock",
    priceVnd: 890_000,
    gender: "female",
    ageGroup: "adult",
    condition: "new",
    color: "Den",
    size: "M",
  });
});

test("M3 offer identity is the external variation id and grouping is the external product id", () => {
  const offer = mapOne().offers[0]!;
  assert.equal(offer.id, "pv-m");
  assert.equal(offer.itemGroupId, "pp-1");
  // Never the internal mutation/authorization handle, and never the slug.
  assert.notEqual(offer.id, "variant-m");
  assert.notEqual(offer.itemGroupId, "ao-so-mi-oxford");
});

test("M3 brand is the reviewed Brand Config constant", () => {
  assert.equal(MERCHANT_BRAND, "La.na Design");
  assert.equal(mapOne().offers[0]!.brand, "La.na Design");
});

test("M3 mpn is the ADR 0008 mirrored Pancake display id, never the website-owned local SKU", () => {
  // A local `VariantMirror.sku` is not an input to this mapper at all, so a candidate carrying a
  // different local code cannot change the emitted MPN.
  const offer = mapOne({ variations: [variation({ pancakeDisplayId: "A132-XL" })] }).offers[0]!;
  assert.equal(offer.mpn, "A132-XL");
  assert.equal(Object.hasOwn(offer, "sku"), false);
});

test("M3 a missing manufacturer MPN excludes the offer and never falls back to a local code", () => {
  for (const absent of [null, "", "   ", " A132-M", "A132-M "]) {
    assert.deepEqual(
      onlyExclusionReasons({ variations: [variation({ pancakeDisplayId: absent })] }),
      ["MPN_UNRESOLVED"],
      `expected ${JSON.stringify(absent)} to fail MPN readiness`,
    );
  }

  assert.deepEqual(
    onlyExclusionReasons({
      variations: [variation({ pancakeDisplayId: "A".repeat(71) })],
    }),
    ["MPN_UNRESOLVED"],
  );
});

test("M3 a duplicated manufacturer MPN excludes every offer that claims it", () => {
  const first = product();
  const second = product({
    pancakeProductId: "pp-2",
    slug: "ao-thun",
    galleryIndexByVariantId: new Map([["variant-x", 1]]),
    projection: {
      mode: "standalone",
      options: [option({ id: "variant-x", pancakeVariationId: "pv-x" })],
    },
    variations: [variation({ variantId: "variant-x", pancakeVariationId: "pv-x" })],
  });

  const result = mapMerchantOffers({ products: [first, second], origin: ORIGIN });
  assert.deepEqual(result.offers, []);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.pancakeVariationId, entry.reasons]),
    [
      ["pv-m", ["MPN_DUPLICATE"]],
      ["pv-x", ["MPN_DUPLICATE"]],
    ],
  );
});

test("M3 a variation identity duplicated inside one product is unaddressable, so neither is emitted", () => {
  const projection: StorefrontProductProjection = {
    mode: "standalone",
    options: [
      option({ id: "variant-m", pancakeVariationId: "pv-dup", size: "M" }),
      option({ id: "variant-l", pancakeVariationId: "pv-dup", size: "L" }),
    ],
  };
  const result = mapOne({
    projection,
    galleryIndexByVariantId: new Map([
      ["variant-m", 1],
      ["variant-l", 2],
    ]),
    variations: [
      variation({ variantId: "variant-m", pancakeVariationId: "pv-dup" }),
      variation({
        variantId: "variant-l",
        pancakeVariationId: "pv-dup",
        pancakeDisplayId: "A132-L",
      }),
    ],
  });

  assert.deepEqual(result.offers, []);
  // U12 already refuses an ambiguous external identity, so the pair is unaddressable as well.
  assert.deepEqual(
    result.excluded.map((entry) => entry.reasons),
    [["OPTION_NOT_ADDRESSABLE"], ["OPTION_NOT_ADDRESSABLE"]],
  );
});

test("M3 an offer identity duplicated across products excludes every offer that claims it", () => {
  // `VariantMirror.pancakeVariationId` is unique in the database, so this is defence in depth: the
  // mapper must not hand two different landing pages to Merchant under one offer id even if the
  // uniqueness constraint it relies on were ever relaxed.
  const second = product({
    pancakeProductId: "pp-2",
    slug: "ao-thun",
    variations: [variation({ pancakeDisplayId: "A200-M" })],
  });

  const result = mapMerchantOffers({ products: [product(), second], origin: ORIGIN });
  assert.deepEqual(result.offers, []);
  assert.deepEqual(
    result.excluded.map((entry) => [entry.itemGroupId, entry.reasons]),
    [
      ["pp-1", ["OFFER_ID_DUPLICATE"]],
      ["pp-2", ["OFFER_ID_DUPLICATE"]],
    ],
  );
});

test("M3 an offer id or item group id outside the Merchant identifier contract is excluded", () => {
  assert.deepEqual(
    onlyExclusionReasons({
      projection: { mode: "standalone", options: [option({ pancakeVariationId: "pv m" })] },
      variations: [variation({ pancakeVariationId: "pv m" })],
    }),
    ["OFFER_ID_UNRESOLVED"],
  );

  assert.deepEqual(onlyExclusionReasons({ pancakeProductId: null }), ["ITEM_GROUP_ID_UNRESOLVED"]);
  assert.deepEqual(onlyExclusionReasons({ pancakeProductId: "p".repeat(51) }), [
    "ITEM_GROUP_ID_UNRESOLVED",
  ]);
});

test("M3 a Pancake barcode is never promoted to a gtin", () => {
  const offer = mapOne().offers[0]!;
  assert.equal(Object.hasOwn(offer, "gtin"), false);
  // The mapper takes no barcode input at all, which is what makes the omission structural.
  assert.equal(
    JSON.stringify(mapMerchantOffers({ products: [product()], origin: ORIGIN })).includes("gtin"),
    false,
  );
});

test("M3 composite projections stay deferred in v1", () => {
  assert.deepEqual(onlyExclusionReasons({ variations: [variation({ isComposite: true })] }), [
    "COMPOSITE_DEFERRED",
  ]);

  // A product whose projection is a composite set defers every option it presents, parent included.
  const compositeProjection: StorefrontProductProjection = {
    mode: "composite",
    options: [option({ kindKey: "parent", kindLabel: "Set" })],
  };
  assert.deepEqual(onlyExclusionReasons({ projection: compositeProjection }), [
    "COMPOSITE_DEFERRED",
  ]);
});

// --- O3 apparel facts ---------------------------------------------------------------------------

test("M3 apparel facts inherit the approved shop defaults when no override exists", () => {
  const offer = mapOne().offers[0]!;
  assert.equal(offer.gender, "female");
  assert.equal(offer.ageGroup, "adult");
  assert.equal(offer.condition, "new");
});

test("M3 each apparel override applies independently to the emitted offer", () => {
  assert.equal(
    mapOne({ apparelOverrides: { gender: "unisex", ageGroup: null, condition: null } }).offers[0]!
      .gender,
    "unisex",
  );
  assert.equal(
    mapOne({ apparelOverrides: { gender: null, ageGroup: "kids", condition: null } }).offers[0]!
      .ageGroup,
    "kids",
  );
  assert.equal(
    mapOne({ apparelOverrides: { gender: null, ageGroup: null, condition: "used" } }).offers[0]!
      .condition,
    "used",
  );

  const mixed = mapOne({
    apparelOverrides: { gender: "female", ageGroup: "kids", condition: null },
  }).offers[0]!;
  assert.deepEqual([mixed.gender, mixed.ageGroup, mixed.condition], ["female", "kids", "new"]);
});

test("M3 a malformed persisted apparel override excludes the offer fail-closed", () => {
  assert.deepEqual(
    onlyExclusionReasons({
      apparelOverrides: { gender: "nam", ageGroup: null, condition: null },
    }),
    ["APPAREL_FACT_UNRESOLVED"],
  );
});

test("M3 apparel facts are never inferred from the product title", () => {
  // Every word in the title points somewhere else -- menswear, children, used -- and none of them
  // reaches the resolver, which reads overrides and the approved shop defaults and nothing else.
  const offer = mapOne({ name: "Ao so mi nam tre em cu" }).offers[0]!;
  assert.deepEqual([offer.gender, offer.ageGroup, offer.condition], ["female", "adult", "new"]);
});

// --- Price ---------------------------------------------------------------------------------------

test("M3 price comes from the canonical storefront option, promotion included", () => {
  // The projection is built by the caller with the shared promotional pricing rule, so a discounted
  // option arrives here already carrying the effective price the shopper is charged.
  const discounted: StorefrontProductProjection = {
    mode: "standalone",
    options: [option({ price: 712_000, basePriceVnd: 890_000, isDiscounted: true })],
  };
  assert.equal(mapOne({ projection: discounted }).offers[0]!.priceVnd, 712_000);
});

test("M3 an unresolved price excludes the offer rather than guessing money", () => {
  const unpriced: StorefrontProductProjection = {
    mode: "standalone",
    options: [option({ price: null, unavailableReason: "PRICE_UNRESOLVED", purchasable: false })],
  };
  assert.deepEqual(onlyExclusionReasons({ projection: unpriced }), ["PRICE_UNRESOLVED"]);
});

// --- Availability --------------------------------------------------------------------------------

test("M3 positive stock is in_stock", () => {
  assert.equal(mapOne().offers[0]!.availability, "in_stock");
});

test("M3 a structurally valid zero-stock offer is emitted as out_of_stock", () => {
  const soldOut: StorefrontProductProjection = {
    mode: "standalone",
    options: [option({ unavailableReason: "OUT_OF_STOCK", purchasable: false })],
  };
  const result = mapOne({
    projection: soldOut,
    variations: [variation({ stockQuantity: 0 })],
  });

  assert.deepEqual(result.excluded, []);
  assert.equal(result.offers[0]!.availability, "out_of_stock");
  assert.equal(result.offers[0]!.priceVnd, 890_000);
});

test("M3 an unresolved availability excludes the offer instead of fabricating a stock state", () => {
  for (const unresolved of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      onlyExclusionReasons({ variations: [variation({ stockQuantity: unresolved })] }),
      ["AVAILABILITY_UNRESOLVED"],
      `expected ${String(unresolved)} to be unresolved`,
    );
  }
});

// --- Landing URL ---------------------------------------------------------------------------------

test("M3 the landing URL is the exact U12 variant deep link on the configured origin", () => {
  assert.equal(
    mapOne().offers[0]!.link,
    "https://la.example.test/shop/ao-so-mi-oxford?variant=pv-m",
  );
});

test("M3 a variation the storefront cannot address produces no offer URL", () => {
  // Stale/forged: named by the candidate row but absent from the authorized option list.
  assert.deepEqual(
    onlyExclusionReasons({
      projection: { mode: "standalone", options: [option({ pancakeVariationId: "pv-other" })] },
    }),
    ["OPTION_NOT_ADDRESSABLE"],
  );

  // Unmappable option: no size, so the storefront itself refuses to preselect it.
  assert.deepEqual(
    onlyExclusionReasons({
      projection: {
        mode: "standalone",
        options: [option({ size: null, unavailableReason: "MAPPING_REQUIRED", purchasable: false })],
      },
    }),
    ["OPTION_NOT_ADDRESSABLE"],
  );

  // Ambiguous option: the catalog cannot say which concrete option this identity means.
  assert.deepEqual(
    onlyExclusionReasons({
      projection: {
        mode: "standalone",
        options: [option({ unavailableReason: "AMBIGUOUS_OPTION", purchasable: false })],
      },
    }),
    ["OPTION_NOT_ADDRESSABLE"],
  );
});

test("M3 an unusable product slug excludes the offer rather than emitting a broken destination", () => {
  assert.deepEqual(onlyExclusionReasons({ slug: "Ao So Mi" }), ["LANDING_URL_UNRESOLVED"]);
  assert.deepEqual(onlyExclusionReasons({ slug: "../admin" }), ["LANDING_URL_UNRESOLVED"]);
});

// --- Media and content ---------------------------------------------------------------------------

test("M3 the offer image is the canonical trusted image for that exact variant", () => {
  assert.equal(mapOne().offers[0]!.imageLink, TRUSTED_VARIANT_M);

  // A variant with no image of its own falls back to the product's canonical primary image, which
  // is still a trusted-resolver output rather than a raw Pancake URL.
  assert.equal(
    mapOne({ galleryIndexByVariantId: new Map() }).offers[0]!.imageLink,
    TRUSTED_PRIMARY,
  );
});

test("M3 untrusted or absent media excludes the offer fail-closed", () => {
  const untrusted = resolveStorefrontProductMedia({
    productName: "Ao so mi Oxford",
    primaryImageUrl: "https://images.example.com/hijack.jpg",
    variantImageUrls: [["http://content.pancake.vn/web-media/1/2/3/insecure.jpg"]],
  });
  assert.equal(untrusted.primary, null);

  assert.deepEqual(
    onlyExclusionReasons({ media: untrusted, galleryIndexByVariantId: new Map() }),
    ["MEDIA_UNRESOLVED"],
  );
  assert.deepEqual(
    onlyExclusionReasons({
      media: { primary: null, gallery: [] },
      galleryIndexByVariantId: new Map(),
    }),
    ["MEDIA_UNRESOLVED"],
  );
});

test("M3 a missing published description excludes the offer instead of inventing one", () => {
  assert.deepEqual(onlyExclusionReasons({ publishedDescription: null }), [
    "DESCRIPTION_UNRESOLVED",
  ]);
  assert.deepEqual(onlyExclusionReasons({ publishedDescription: "   " }), [
    "DESCRIPTION_UNRESOLVED",
  ]);
  // Not repaired from the product name, the Pancake source description or any other nearby text.
  const excluded = mapOne({ publishedDescription: null }).excluded[0]!;
  assert.equal(Object.hasOwn(excluded, "description"), false);
});

test("M3 malformed required text excludes the offer", () => {
  // Code points no XML 1.0 document may carry. The M1 text classifier already owns that boundary,
  // so the mapper defers to it rather than growing a second opinion about Merchant text safety.
  assert.deepEqual(onlyExclusionReasons({ publishedDescription: "Ao so mi \u0000" }), [
    "DESCRIPTION_UNRESOLVED",
  ]);
  assert.deepEqual(onlyExclusionReasons({ name: "Ao \u0008so mi" }), ["TITLE_UNRESOLVED"]);
  assert.deepEqual(onlyExclusionReasons({ name: "   " }), ["TITLE_UNRESOLVED"]);
});

test("M3 title and description enforce current Merchant length bounds", () => {
  assert.equal(MERCHANT_TITLE_MAX_LENGTH, 150);
  assert.equal(MERCHANT_DESCRIPTION_MAX_LENGTH, 5_000);
  assert.equal(mapOne({ name: "T".repeat(MERCHANT_TITLE_MAX_LENGTH) }).offers.length, 1);
  assert.equal(
    mapOne({ publishedDescription: "D".repeat(MERCHANT_DESCRIPTION_MAX_LENGTH) }).offers.length,
    1,
  );

  assert.deepEqual(onlyExclusionReasons({ name: "T".repeat(MERCHANT_TITLE_MAX_LENGTH + 1) }), [
    "TITLE_UNRESOLVED",
  ]);
  assert.deepEqual(
    onlyExclusionReasons({
      publishedDescription: "D".repeat(MERCHANT_DESCRIPTION_MAX_LENGTH + 1),
    }),
    ["DESCRIPTION_UNRESOLVED"],
  );
});

test("M3 required apparel color and size enforce current Merchant bounds", () => {
  assert.equal(MERCHANT_COLOR_MAX_LENGTH, 100);
  assert.equal(MERCHANT_SIZE_MAX_LENGTH, 100);

  const boundary = mapOne({
    projection: {
      mode: "standalone",
      options: [
        option({
          color: "C".repeat(MERCHANT_COLOR_MAX_LENGTH),
          size: "S".repeat(MERCHANT_SIZE_MAX_LENGTH),
        }),
      ],
    },
  });
  assert.equal(boundary.offers.length, 1);

  for (const color of [null, "", "   ", " Den ", "D\u0000en", "C".repeat(101)]) {
    assert.deepEqual(
      onlyExclusionReasons({
        projection: { mode: "standalone", options: [option({ color })] },
      }),
      ["COLOR_UNRESOLVED"],
      `expected color ${JSON.stringify(color)} to be rejected`,
    );
  }

  for (const size of [null, "", "   ", " M ", "M\u0000", "S".repeat(101)]) {
    assert.deepEqual(
      onlyExclusionReasons({
        projection: { mode: "standalone", options: [option({ size })] },
      }),
      ["SIZE_UNRESOLVED"],
      `expected size ${JSON.stringify(size)} to be rejected`,
    );
  }
});

// --- Determinism and diagnostics ------------------------------------------------------------------

test("M3 the same canonical input produces the same offers and the same diagnostics", () => {
  const products = [
    product(),
    product({
      pancakeProductId: "pp-2",
      slug: "ao-thun",
      publishedDescription: null,
      galleryIndexByVariantId: new Map(),
      projection: {
        mode: "standalone",
        options: [option({ id: "variant-x", pancakeVariationId: "pv-x" })],
      },
      variations: [
        variation({
          variantId: "variant-x",
          pancakeVariationId: "pv-x",
          pancakeDisplayId: "A200-M",
          stockQuantity: Number.NaN,
        }),
      ],
    }),
  ];

  const first = mapMerchantOffers({ products, origin: ORIGIN });
  const second = mapMerchantOffers({ products, origin: ORIGIN });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("M3 every unresolved fact for one candidate is reported in one bounded, ordered reason list", () => {
  const reasons = onlyExclusionReasons({
    pancakeProductId: null,
    publishedDescription: null,
    name: "   ",
    media: { primary: null, gallery: [] },
    galleryIndexByVariantId: new Map(),
    apparelOverrides: { gender: "nam", ageGroup: null, condition: null },
    variations: [variation({ pancakeDisplayId: null, stockQuantity: Number.NaN })],
  });

  assert.deepEqual(reasons, [
    "ITEM_GROUP_ID_UNRESOLVED",
    "MPN_UNRESOLVED",
    "APPAREL_FACT_UNRESOLVED",
    "AVAILABILITY_UNRESOLVED",
    "MEDIA_UNRESOLVED",
    "TITLE_UNRESOLVED",
    "DESCRIPTION_UNRESOLVED",
  ]);
  assert.equal(new Set(reasons).size, reasons.length);
});

test("M3 an excluded candidate reports bounded identity only, never catalog content", () => {
  const excluded = mapOne({ publishedDescription: null }).excluded[0]!;
  assert.deepEqual(Object.keys(excluded).sort(), [
    "itemGroupId",
    "pancakeVariationId",
    "reasons",
  ]);
});

// --- O2 market gate ------------------------------------------------------------------------------

test("M3 the unapproved O2 market keeps Merchant activation explicitly blocked", () => {
  assert.equal(APPROVED_MERCHANT_MARKET, null);
  const result = mapOne();
  assert.deepEqual(result.market, { status: "UNRESOLVED", reason: MERCHANT_MARKET_UNRESOLVED });
  assert.deepEqual(result.activationBlockedReasons, [MERCHANT_MARKET_UNRESOLVED]);
  // No offer declares a target country, content language or currency while O2 is open.
  const offer = result.offers[0]!;
  for (const field of ["targetCountry", "contentLanguage", "currency", "price"]) {
    assert.equal(Object.hasOwn(offer, field), false, `offer must not declare ${field}`);
  }
});

test("M3 caller-supplied market data cannot impersonate owner approval", () => {
  const injected = {
    products: [product()],
    origin: ORIGIN,
    market: { targetCountry: "VN", contentLanguage: "vi", currency: "VND" },
  };
  // Structural typing permits the extra property on a variable, which is useful here: this proves
  // the runtime path ignores even a syntactically valid injected market rather than merely relying
  // on TypeScript excess-property checks.
  const result = mapMerchantOffers(injected);
  assert.deepEqual(result.market, { status: "UNRESOLVED", reason: MERCHANT_MARKET_UNRESOLVED });
  assert.deepEqual(result.activationBlockedReasons, [MERCHANT_MARKET_UNRESOLVED]);
});

test("M3 the mapper refuses an unusable origin rather than emitting a relative link", () => {
  assert.throws(() => mapMerchantOffers({ products: [product()], origin: "not-an-origin" }), {
    name: "TypeError",
  });
  assert.throws(() => mapMerchantOffers({ products: [product()], origin: "javascript:alert(1)" }), {
    name: "TypeError",
  });
});
