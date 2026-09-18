import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalogAcceptanceReport } from "../../src/commerce/catalog-acceptance.ts";
import type { StorefrontProductProjection } from "../../src/commerce/storefront-projection.ts";
import { fixtureAvailability } from "../fixtures/storefront-projection-option.ts";

const trustedImage = "https://content.pancake.vn/catalog/1/2/3/item.jpg";

function publishedContent() {
  return {
    status: "PUBLISHED" as const,
    editorialDescription: "Published editorial copy.",
    seoTitle: "Published SEO title",
    seoDescription: "Published SEO description",
    collectionSlugs: ["sets"],
  };
}

function projection(): StorefrontProductProjection {
  return {
    mode: "composite",
    options: [
      {
        id: "set-m",
        pancakeVariationId: "pancake-set-m",
        color: null,
        size: "M",
        price: 790_000,
        basePriceVnd: 790_000,
        isDiscounted: false,
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
        availability: fixtureAvailability({
          purchasable: true,
          isPreorderSale: false,
          unavailableReason: null,
        }),
        kindKey: "parent",
        kindLabel: "Set",
      },
      {
        id: "shirt-m",
        pancakeVariationId: "pancake-shirt-m",
        color: null,
        size: "M",
        price: 390_000,
        basePriceVnd: 390_000,
        isDiscounted: false,
        purchasable: true,
        isPreorderSale: false,
        unavailableReason: null,
        availability: fixtureAvailability({
          purchasable: true,
          isPreorderSale: false,
          unavailableReason: null,
        }),
        kindKey: "component-1",
        kindLabel: "Ao A",
      },
    ],
  };
}

test("P17 acceptance derives composite projection readiness from persisted projected parent coverage", () => {
  const report = buildCatalogAcceptanceReport({
    sourceModel: {
      compositeParentVariations: 36,
      projectedCompositeParentVariations: 36,
    },
    publishedCollectionSlugs: new Set(["sets"]),
    products: [
      {
        slug: "set-a",
        name: "Set A",
        sourceDescription: "Private source context",
        primaryImageUrl: trustedImage,
        content: publishedContent(),
        variants: [
          {
            id: "set-m",
            pancakeVariationId: "pancake-set-m",
            color: null,
            size: "M",
            sellableStock: 2,
            retailPrice: 790_000,
            retailPriceAfterDiscount: 790_000,
            imageUrls: [],
          },
        ],
        projection: projection(),
      },
    ],
  });

  assert.equal(report.blockers.compositeProjectionRequired, false);
  assert.deepEqual(report.sourceModel, {
    compositeParentVariations: 36,
    projectedCompositeParentVariations: 36,
  });
  assert.equal(report.summary.variantMappingReady, 1);
  assert.equal(report.summary.purchasableNow, 1);
  assert.equal(report.ready, true);
});

test("P17 acceptance blocks when persisted projected parent coverage differs from the live source count", () => {
  const report = buildCatalogAcceptanceReport({
    sourceModel: {
      compositeParentVariations: 36,
      projectedCompositeParentVariations: 35,
    },
    publishedCollectionSlugs: new Set(),
    products: [],
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.blockers, { compositeProjectionRequired: true });
});
