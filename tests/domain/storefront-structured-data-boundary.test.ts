/**
 * U27 — #152 W4d + the variant-level portion of W5.
 *
 * These tests pin the boundary between the PDP storefront projection and published JSON-LD. Every
 * emitted fact must reuse an existing authority: U12 variant addressability, promotion-aware PDP
 * price/availability, trusted media, product external identity, and ADR 0008 manufacturer MPN.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";
import {
  buildStorefrontProductProjection,
  type StorefrontProductProjection,
  type StorefrontProjectionOption,
} from "../../src/commerce/storefront-projection.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import {
  resolveDeepLinkedVariantSelection,
  VARIANT_QUERY_PARAM,
} from "../../src/commerce/storefront-variant-deep-link.ts";
import { buildStorefrontProductStructuredData } from "../../src/seo/storefront-product-structured-data.ts";
import {
  serializeJsonLd,
  type ProductStructuredDataDocument,
} from "../../src/seo/structured-data.ts";
import { fixtureAvailability, withFixtureAvailability } from "../fixtures/storefront-projection-option.ts";

const ORIGIN = "https://shop.example.com";
const SLUG = "ao-oxford-relaxed";
const PRODUCT_URL = `${ORIGIN}/shop/${SLUG}`;
const BLACK_IMAGE = "https://content.pancake.vn/catalog/1/2/3/oxford-den.jpg";
const CREAM_IMAGE = "https://content.pancake.vn/catalog/1/2/3/oxford-kem.jpg";
const NOW = new Date("2026-09-04T12:00:00.000Z");

function option(overrides: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  const merged = {
    id: "cuid-a",
    pancakeVariationId: "pv-a",
    color: "Đen",
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
  return withFixtureAvailability(merged);
}

type BoundaryProduct = Parameters<typeof buildStorefrontProductStructuredData>[0]["product"];

function product(overrides: Partial<BoundaryProduct> = {}): BoundaryProduct {
  return {
    pancakeProductId: "pancake-product-1",
    slug: SLUG,
    name: "Áo Oxford Relaxed",
    editorialDescription: null,
    media: {
      gallery: [
        { url: BLACK_IMAGE, alt: "Áo Oxford Relaxed" },
        { url: CREAM_IMAGE, alt: "Áo Oxford Relaxed - Ảnh 2" },
      ],
    },
    galleryIndexByVariantId: { "cuid-a": 0, "cuid-b": 0, "cuid-c": 1 },
    variantMpnById: {
      "cuid-a": "A132-M",
      "cuid-b": "A132-L",
      "cuid-c": "A132-KEM-M",
    },
    variantSkuById: {},
    // U27a: the ordinary fixture has well-formed mirrored inventory, so every variant can state an
    // availability. Cases about malformed inventory override this per variant.
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": true, "cuid-c": true },
    projection: {
      mode: "standalone",
      options: [
        option({ id: "cuid-a", pancakeVariationId: "pv-a", color: "Đen", size: "M" }),
        option({
          id: "cuid-b",
          pancakeVariationId: "pv-b",
          color: "Đen",
          size: "L",
          price: 910_000,
          basePriceVnd: 910_000,
        }),
        option({ id: "cuid-c", pancakeVariationId: "pv-c", color: "Kem", size: "M" }),
      ],
    },
    ...overrides,
  };
}

function standaloneProjection(
  options: readonly StorefrontProjectionOption[],
): StorefrontProductProjection {
  return { mode: "standalone", options: [...options] };
}

function build(overrides: Partial<BoundaryProduct> = {}): ProductStructuredDataDocument {
  return buildStorefrontProductStructuredData({ origin: ORIGIN, product: product(overrides) });
}

function productGroupNode(document: ProductStructuredDataDocument) {
  const node = document["@graph"][0];
  assert.equal(node["@type"], "ProductGroup", "expected the variant ProductGroup shape");
  return node;
}

function singleProductNode(document: ProductStructuredDataDocument) {
  const node = document["@graph"][0];
  assert.equal(node["@type"], "Product", "expected the product-level Product shape");
  return node;
}

function facts(overrides: Partial<StorefrontVariantFacts> & Pick<StorefrontVariantFacts, "id">,
): StorefrontVariantFacts {
  return {
    pancakeVariationId: `pv-${overrides.id}`,
    color: "Đen",
    size: "M",
    sellableStock: 4,
    retailPrice: 890_000,
    retailPriceAfterDiscount: 890_000,
    ...overrides,
  };
}

function projectedProduct(
  variants: readonly StorefrontVariantFacts[],
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]> = new Map(),
): BoundaryProduct {
  return product({
    galleryIndexByVariantId: {},
    variantMpnById: Object.fromEntries(
      variants.map((variant) => [variant.id, `MPN-${variant.id}`]),
    ),
    projection: buildStorefrontProductProjection({
      parentVariants: variants,
      componentGroups: [],
      hasCompositeGraph: false,
      pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW }),
    }),
  });
}

test("U27 publishes one ProductGroup with variant-specific names, unique manufacturer MPN and exact Offer per variant", () => {
  const document = build();
  const group = productGroupNode(document);

  assert.equal(document["@context"], "https://schema.org");
  assert.equal(document["@graph"].length, 2);
  assert.equal(document["@graph"][1]["@type"], "BreadcrumbList");
  assert.equal(group["@id"], `${PRODUCT_URL}#product`);
  assert.equal(group.name, "Áo Oxford Relaxed");
  assert.equal(group.url, PRODUCT_URL);
  assert.deepEqual(group.brand, { "@id": `${ORIGIN}/#organization` });
  assert.equal(group.productGroupID, "pancake-product-1");
  assert.deepEqual(group.variesBy, ["https://schema.org/color", "https://schema.org/size"]);
  assert.equal(group.hasVariant.length, 3);
  assert.deepEqual(group.hasVariant.map((variant) => variant.name), [
    "Áo Oxford Relaxed — Đen — M",
    "Áo Oxford Relaxed — Đen — L",
    "Áo Oxford Relaxed — Kem — M",
  ]);

  assert.deepEqual(group.hasVariant[0], {
    "@type": "Product",
    "@id": `${PRODUCT_URL}?variant=pv-a#product`,
    name: "Áo Oxford Relaxed — Đen — M",
    url: `${PRODUCT_URL}?variant=pv-a`,
    mpn: "A132-M",
    color: "Đen",
    size: "M",
    image: [BLACK_IMAGE],
    offers: {
      "@type": "Offer",
      url: `${PRODUCT_URL}?variant=pv-a`,
      priceCurrency: "VND",
      price: 890_000,
      availability: "https://schema.org/InStock",
    },
  });
});

test("U27 preserves exact per-variant price and never publishes aggregate pricing", () => {
  const group = productGroupNode(build());
  assert.deepEqual(group.hasVariant.map((variant) => variant.offers.price), [890_000, 910_000, 890_000]);
  assert.equal("offers" in group, false);

  const serialized = serializeJsonLd(group);
  for (const forbidden of ["AggregateOffer", "lowPrice", "highPrice", "offerCount"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("U27 publishes OutOfStock only for stock-only unavailability and excludes unresolved price", () => {
  const group = productGroupNode(
    build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
        option({
          id: "cuid-b",
          pancakeVariationId: "pv-b",
          size: "L",
          price: 910_000,
          purchasable: false,
          isPreorderSale: false,
          unavailableReason: "OUT_OF_STOCK",
        }),
        option({
          id: "cuid-c",
          pancakeVariationId: "pv-unresolved",
          size: "XL",
          price: null,
          purchasable: false,
          isPreorderSale: false,
          unavailableReason: "PRICE_UNRESOLVED",
        }),
      ]),
    }),
  );

  assert.deepEqual(
    group.hasVariant.map((variant) => [variant.url, variant.offers.availability]),
    [
      [`${PRODUCT_URL}?variant=pv-a`, "https://schema.org/InStock"],
      [`${PRODUCT_URL}?variant=pv-b`, "https://schema.org/OutOfStock"],
    ],
  );
  assert.equal(serializeJsonLd(group).includes("pv-unresolved"), false);
});

test("U27 does not translate unexplained unavailability into a false stock claim", () => {
  const group = productGroupNode(
    build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
        option({
          id: "cuid-c",
          pancakeVariationId: "pv-unexplained",
          size: "XL",
          purchasable: false,
          isPreorderSale: false,
          unavailableReason: null,
        }),
      ]),
    }),
  );

  assert.equal(group.hasVariant.length, 2);
  assert.equal(serializeJsonLd(group).includes("pv-unexplained"), false);
});

test("U27 every published URL round-trips through U12 and every variant name/MPN matches the reselected facts", () => {
  const fixture = product();
  const group = productGroupNode(
    buildStorefrontProductStructuredData({ origin: ORIGIN, product: fixture }),
  );

  assert.deepEqual(group.hasVariant.map((variant) => variant.mpn), [
    "A132-M",
    "A132-L",
    "A132-KEM-M",
  ]);

  for (const variant of group.hasVariant) {
    const query = new URL(variant.url).searchParams.get(VARIANT_QUERY_PARAM);
    const reselected = resolveDeepLinkedVariantSelection({
      projection: fixture.projection,
      variantQuery: query,
    });
    assert.ok(reselected, `${variant.url} must reselect a variant`);
    const matched = fixture.projection.options.find((item) => item.id === reselected.variantId)!;
    const expectedName = [fixture.name, matched.color, matched.size]
      .filter((value): value is string => value !== null)
      .join(" — ");
    assert.notEqual(variant.name, group.name);
    assert.equal(variant.name, expectedName);
    assert.equal(variant.color, matched.color);
    assert.equal(variant.size, matched.size);
    assert.equal(variant.offers.price, matched.price);
    assert.equal(variant.offers.url, variant.url);
  }

  const serialized = serializeJsonLd(group);
  for (const forbidden of ["cuid-a", "cuid-b", "cuid-c", "kindKey", "kindLabel", "sku", "gtin"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("U27 duplicate or malformed identities fail closed rather than being rewritten or substituted", () => {
  const duplicateVariation = build({
    projection: standaloneProjection([
      option({ id: "cuid-a", pancakeVariationId: "pv-dup", size: "M" }),
      option({ id: "cuid-b", pancakeVariationId: "pv-dup", size: "L" }),
    ]),
  });
  assert.equal(duplicateVariation["@graph"][0]["@type"], "Product");

  for (const variantMpnById of [
    { "cuid-a": "DUP", "cuid-b": "DUP" },
    { "cuid-a": null, "cuid-b": "A132-L" },
    { "cuid-a": " A132-M ", "cuid-b": "A132-L" },
    { "cuid-a": "x".repeat(71), "cuid-b": "A132-L" },
    { "cuid-a": "A132\u0001M", "cuid-b": "A132-L" },
  ] as const) {
    const document = build({
      variantMpnById,
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
      ]),
    });
    assert.equal(document["@graph"][0]["@type"], "Product");
  }
});

test("U27 one malformed MPN excludes only that variant when a truthful family still remains", () => {
  const group = productGroupNode(
    build({
      variantMpnById: {
        "cuid-a": "A132-M",
        "cuid-b": "A132-L",
        "cuid-c": " A132-KEM-M ",
      },
    }),
  );

  assert.deepEqual(group.hasVariant.map((variant) => variant.mpn), ["A132-M", "A132-L"]);
  assert.equal(group.variesBy.includes("https://schema.org/color"), false);
  assert.deepEqual(group.variesBy, ["https://schema.org/size"]);
});

test("U27 variesBy uses the storefront option identity rule rather than raw casing", () => {
  const group = productGroupNode(
    buildStorefrontProductStructuredData({
      origin: ORIGIN,
      product: projectedProduct([
        facts({ id: "cuid-a", color: "Đen", size: "M" }),
        facts({ id: "cuid-b", color: "đen", size: "L" }),
      ]),
    }),
  );

  assert.deepEqual(group.variesBy, ["https://schema.org/size"]);
  assert.equal(group.hasVariant.length, 2);
});

test("U27 variesBy names only dimensions that actually differ", () => {
  const sizeOnly = productGroupNode(
    build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", color: null, size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", color: null, size: "L" }),
      ]),
    }),
  );
  assert.deepEqual(sizeOnly.variesBy, ["https://schema.org/size"]);

  const colorOnly = productGroupNode(
    build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", color: "Đen", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", color: "Kem", size: "M" }),
      ]),
    }),
  );
  assert.deepEqual(colorOnly.variesBy, ["https://schema.org/color"]);
});

test("U27 variant image comes only from the trusted resolved gallery mapping", () => {
  const group = productGroupNode(
    build({
      galleryIndexByVariantId: { "cuid-c": 1 },
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", color: "Đen", size: "M" }),
        option({ id: "cuid-c", pancakeVariationId: "pv-c", color: "Kem", size: "M" }),
      ]),
    }),
  );
  assert.equal("image" in group.hasVariant[0]!, false);
  assert.deepEqual(group.hasVariant[1]!.image, [CREAM_IMAGE]);

  const invalidIndexes = productGroupNode(
    build({
      galleryIndexByVariantId: { "cuid-a": 99, "cuid-b": -1 },
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
      ]),
    }),
  );
  assert.equal("image" in invalidIndexes.hasVariant[0]!, false);
  assert.equal("image" in invalidIndexes.hasVariant[1]!, false);
});

test("U27 single or non-publishable family keeps the product-level fallback", () => {
  const single = singleProductNode(
    build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
      ]),
    }),
  );
  assert.deepEqual(single.offers, {
    "@type": "Offer",
    url: PRODUCT_URL,
    priceCurrency: "VND",
    price: 890_000,
    availability: "https://schema.org/InStock",
  });

  const unpriced = singleProductNode(
    build({
      projection: standaloneProjection([
        option({
          id: "cuid-a",
          pancakeVariationId: "pv-a",
          size: "M",
          price: null,
          purchasable: false,
          isPreorderSale: false,
          unavailableReason: "PRICE_UNRESOLVED",
        }),
      ]),
    }),
  );
  assert.equal("offers" in unpriced, false);
});

test("U27 never remodels a composite component as a normal sibling variant", () => {
  const document = buildStorefrontProductStructuredData({
    origin: ORIGIN,
    product: product({
      // A composite parent set's own variants are this product's variants, so the catalog read
      // resolves them exactly as it does a standalone family's. Components belong to other products
      // and never reach the product-level selection.
      variantAvailabilityResolvedById: { "parent-m": true, "component-m": true },
      projection: {
        mode: "composite",
        options: [
          option({
            id: "parent-m",
            pancakeVariationId: "pv-parent-m",
            color: null,
            size: "M",
            price: 790_000,
            purchasable: false,
            isPreorderSale: false,
            unavailableReason: "OUT_OF_STOCK",
            kindKey: "parent",
            kindLabel: "Set",
          }),
          option({
            id: "component-m",
            pancakeVariationId: "pv-component-m",
            color: null,
            size: "M",
            price: 790_000,
            kindKey: "component-1",
            kindLabel: "Áo A",
          }),
        ],
      },
    }),
  });

  const node = singleProductNode(document);
  assert.deepEqual(node.offers, {
    "@type": "Offer",
    url: PRODUCT_URL,
    priceCurrency: "VND",
    price: 790_000,
    availability: "https://schema.org/OutOfStock",
  });
  const serialized = serializeJsonLd(document);
  assert.equal(serialized.includes("ProductGroup"), false);
  assert.equal(serialized.includes("pv-component-m"), false);
});

test("U27 rejects unusable product group identity", () => {
  for (const pancakeProductId of ["", "   ", " pancake-product-1 ", "p".repeat(129)]) {
    const document = build({ pancakeProductId });
    assert.equal(document["@graph"][0]["@type"], "Product");
  }
});

test("U27 hostile mirrored text cannot break JSON-LD and no unsupported claims are invented", () => {
  const serialized = serializeJsonLd(
    build({
      name: "</script><script>alert('u27')</script>",
      variantMpnById: {
        "cuid-a": "A132</script>M",
        "cuid-b": "A132-L",
      },
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a</script>", color: "<img src=x>", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", color: "Kem", size: "M" }),
      ]),
    }),
  );
  assert.equal(serialized.includes("<"), false);
  assert.match(serialized, /\\u003c\/script>/);

  const group = productGroupNode(build());
  for (const forbidden of [
    "aggregateRating",
    "review",
    "gtin",
    "gtin13",
    "material",
    "shippingDetails",
    "hasMerchantReturnPolicy",
    "itemCondition",
  ]) {
    assert.equal(forbidden in group, false, forbidden);
    for (const variant of group.hasVariant) {
      assert.equal(forbidden in variant, false, `${forbidden} on variant`);
    }
  }
});

test("U27 real promotion projection publishes the exact discounted price the page charges", () => {
  const campaign: ApplicablePromotionCampaign = {
    id: "campaign-1",
    name: "Thu 2026",
    kind: "PROMOTION",
    discountType: "PERCENTAGE",
    percentageValue: 20,
    fixedPriceVnd: null,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    endsAt: new Date("2026-09-30T00:00:00.000Z"),
  };

  const group = productGroupNode(
    buildStorefrontProductStructuredData({
      origin: ORIGIN,
      product: projectedProduct(
        [
          facts({ id: "cuid-a", size: "M", retailPrice: 1_000_000, retailPriceAfterDiscount: 1_000_000 }),
          facts({ id: "cuid-b", size: "L", retailPrice: 1_000_000, retailPriceAfterDiscount: 1_000_000 }),
        ],
        new Map([["cuid-a", [campaign]]]),
      ),
    }),
  );

  assert.deepEqual(group.hasVariant.map((variant) => variant.offers.price), [800_000, 1_000_000]);
});

test("U27 mirrored after-discount field does not reopen the obsolete equality gate", () => {
  const group = productGroupNode(
    buildStorefrontProductStructuredData({
      origin: ORIGIN,
      product: projectedProduct([
        facts({ id: "cuid-a", size: "M", retailPrice: 890_000, retailPriceAfterDiscount: 690_000 }),
        facts({ id: "cuid-b", size: "L", retailPrice: 910_000, retailPriceAfterDiscount: 910_000 }),
      ]),
    }),
  );

  assert.deepEqual(group.hasVariant.map((variant) => variant.offers.price), [890_000, 910_000]);
});

test("U27 real projection and boundary agree about publishable options", () => {
  const group = productGroupNode(
    buildStorefrontProductStructuredData({
      origin: ORIGIN,
      product: projectedProduct([
        facts({ id: "cuid-a", size: "M" }),
        facts({ id: "cuid-b", size: "L", sellableStock: 0 }),
        facts({ id: "cuid-c", size: "XL", retailPrice: null, retailPriceAfterDiscount: null }),
        facts({ id: "cuid-d", size: null }),
        facts({ id: "cuid-e", size: "XXL" }),
        facts({ id: "cuid-f", size: "XXL" }),
      ]),
    }),
  );

  assert.deepEqual(
    group.hasVariant.map((variant) => [variant.size, variant.offers.availability]),
    [
      ["M", "https://schema.org/InStock"],
      ["L", "https://schema.org/OutOfStock"],
    ],
  );
});

test("U27 unusable money is never published", () => {
  for (const price of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const document = build({
      projection: standaloneProjection([
        option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
        option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
        option({ id: "cuid-c", pancakeVariationId: "pv-unusable", size: "XL", price }),
      ]),
    });
    assert.equal(serializeJsonLd(document).includes("pv-unusable"), false, String(price));
  }
});
test("U27a an availability-unresolved variant is omitted, never relabelled", () => {
  // The middle variant's mirrored inventory is malformed, so the catalog cannot state an
  // availability for it. The other two are untouched and still publish exactly as before.
  const document = build({
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": false, "cuid-c": true },
  });
  const group = productGroupNode(document);
  const published = group.hasVariant.map((variant) => variant.url);

  assert.deepEqual(published, [
    `${PRODUCT_URL}?variant=pv-a`,
    `${PRODUCT_URL}?variant=pv-c`,
  ]);

  const serialized = JSON.stringify(document);
  // Nothing is left behind describing the excluded variant: no offer, no MPN, no dangling URL.
  assert.equal(serialized.includes("pv-b"), false, "no fact may survive the excluded variant");
  assert.equal(serialized.includes("A132-L"), false, "the excluded variant's MPN is not published");
  // And it is not translated into some other availability claim.
  assert.equal(
    group.hasVariant.every((variant) => variant.offers.url !== `${PRODUCT_URL}?variant=pv-b`),
    true,
  );
});

test("U27a variesBy is recomputed from the variants that survive exclusion", () => {
  // cuid-a (Đen/M) and cuid-b (Đen/L) vary by size; cuid-c (Kem/M) adds the colour dimension.
  // Dropping cuid-c must leave a size-only family rather than still claiming a colour axis.
  const document = build({
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": true, "cuid-c": false },
  });
  const group = productGroupNode(document);

  assert.deepEqual(group.variesBy, ["https://schema.org/size"]);
  assert.equal(group.hasVariant.length, 2);
});

test("U27a the family collapses when exclusion leaves no real variant family", () => {
  // Only one publishable variant remains, so there is no family to describe. Under the approved
  // one-survivor contract that becomes a top-level exact `Product` for the survivor itself, never a
  // one-member ProductGroup, and the excluded siblings appear nowhere in the document.
  const document = build({
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": false, "cuid-c": false },
  });

  singleProductNode(document);
  assert.equal(JSON.stringify(document).includes("pv-b"), false);
  assert.equal(JSON.stringify(document).includes("pv-c"), false);
});

test("U27a a variant missing from the resolution map fails closed", () => {
  // A caller that forgets an entry publishes nothing for that variant rather than something
  // unverified. Absence is unresolved, not an implicit yes.
  const document = build({
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-c": true },
  });
  const group = productGroupNode(document);

  assert.deepEqual(
    group.hasVariant.map((variant) => variant.url),
    [`${PRODUCT_URL}?variant=pv-a`, `${PRODUCT_URL}?variant=pv-c`],
  );
});

test("U27a the product-level fallback offer is never influenced by unresolved inventory", () => {
  // The family collapses to a product-level Product because only one variant survives exclusion.
  // The survivor is genuinely sold out; the excluded sibling is "purchasable" only because the
  // storefront summed a malformed row. The fallback offer must answer from the survivor alone, or
  // U27a would suppress the exact per-variant claim and then republish it one node up.
  const document = build({
    galleryIndexByVariantId: { "cuid-a": 0, "cuid-b": 0 },
    variantMpnById: { "cuid-a": "A132-M", "cuid-b": "A132-L" },
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": false },
    projection: standaloneProjection([
      option({
        id: "cuid-a",
        pancakeVariationId: "pv-a",
        size: "M",
        purchasable: false,
        isPreorderSale: false,
        unavailableReason: "OUT_OF_STOCK",
      }),
      option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
    ]),
  });

  const node = singleProductNode(document);
  assert.equal(
    node.offers?.availability,
    "https://schema.org/OutOfStock",
    "an unresolved sibling must not make the product-level offer claim InStock",
  );
  assert.equal(node.offers?.price, 890_000);
});

test("U27a no product-level fallback offer survives when every variant is unresolved", () => {
  const document = build({
    galleryIndexByVariantId: { "cuid-a": 0, "cuid-b": 0 },
    variantMpnById: { "cuid-a": "A132-M", "cuid-b": "A132-L" },
    variantAvailabilityResolvedById: { "cuid-a": false, "cuid-b": false },
    projection: standaloneProjection([
      option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
      option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
    ]),
  });

  const node = singleProductNode(document);
  assert.equal("offers" in node, false, "no resolved inventory means no published price or stock");
});

test("U27a an unresolved sibling cannot suppress the survivor's product-level offer either", () => {
  // The filter has to work in both directions: an excluded variant's differing price must not
  // trigger the price-disagreement refusal and silently drop an offer the survivor could support.
  const document = build({
    galleryIndexByVariantId: { "cuid-a": 0, "cuid-b": 0 },
    variantMpnById: { "cuid-a": "A132-M", "cuid-b": "A132-L" },
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": false },
    projection: standaloneProjection([
      option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
      option({
        id: "cuid-b",
        pancakeVariationId: "pv-b",
        size: "L",
        price: 910_000,
        basePriceVnd: 910_000,
      }),
    ]),
  });

  const node = singleProductNode(document);
  assert.equal(node.offers?.price, 890_000, "the survivor's own exact price is publishable");
  assert.equal(node.offers?.availability, "https://schema.org/InStock");
});


/**
 * U32a. The website-owned SKU reaches the node it describes, and gates nothing on the way: a
 * variant whose SKU is missing or unpublishable is still published, simply without one. That is
 * the difference between it and the ADR 0008 MPN, which does decide publishability.
 */
test("U32a carries each variant's own SKU into its published node without gating publication", () => {
  const document = build({
    galleryIndexByVariantId: { "cuid-a": 0, "cuid-b": 0 },
    variantMpnById: { "cuid-a": "A132-M", "cuid-b": "A132-L" },
    variantSkuById: { "cuid-a": "LA-OXF-M", "cuid-b": null },
    variantAvailabilityResolvedById: { "cuid-a": true, "cuid-b": true },
    projection: standaloneProjection([
      option({ id: "cuid-a", pancakeVariationId: "pv-a", size: "M" }),
      option({ id: "cuid-b", pancakeVariationId: "pv-b", size: "L" }),
    ]),
  });

  const group = productGroupNode(document);
  assert.equal(group.hasVariant.length, 2, "a missing SKU must not drop a variant from the family");
  assert.equal(group.hasVariant[0].sku, "LA-OXF-M");
  assert.equal(
    "sku" in group.hasVariant[1],
    false,
    "the sibling without a SKU publishes no sku property at all",
  );
  assert.deepEqual(
    group.hasVariant.map((variant) => variant.mpn),
    ["A132-M", "A132-L"],
    "SKU wiring leaves the ADR 0008 MPNs exactly as they were",
  );
});
