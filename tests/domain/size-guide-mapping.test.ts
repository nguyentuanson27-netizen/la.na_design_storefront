import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_SIZE_GUIDE_IDS,
  APPROVED_SIZE_GUIDES,
  isApprovedSizeGuideId,
  SIZE_GUIDE,
} from "../../src/brand/size-guide.config.ts";
import { CATEGORY_KEYS } from "../../src/commerce/category-taxonomy.ts";
import type { StorefrontProductMedia } from "../../src/commerce/product-media.ts";
import {
  buildProductViewModel,
  type ProductViewModelInput,
} from "../../src/routes/product-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

const media: StorefrontProductMedia = {
  primary: { url: "https://content.pancake.vn/photo-1.jpg", alt: "" },
  gallery: [{ url: "https://content.pancake.vn/photo-1.jpg", alt: "" }],
};

function productInput(overrides: Partial<ProductViewModelInput> = {}): ProductViewModelInput {
  return {
    slug: "sample-product",
    name: "Sample Product",
    media,
    collections: [],
    editorialDescription: null,
    material: null,
    craftDetails: [],
    sizeGuide: null,
    careInstructions: null,
    options: [],
    productLevelOptions: [],
    deepLinkedSelection: null,
    galleryIndexByVariantId: {},
    relatedProducts: [],
    relatedSelectEventBySlug: new Map<string, TrackingEvent>(),
    ...overrides,
  };
}

test("M1 approved size-guide registry contains exactly the three approved guides", () => {
  const expectedIds = ["ao-dai", "set-vay-form-rong", "set-vay-form-nho"] as const;

  assert.deepEqual([...APPROVED_SIZE_GUIDE_IDS], [...expectedIds]);
  assert.equal(APPROVED_SIZE_GUIDE_IDS.length, 3);

  // Every chart in brand config must map to an approved ID
  const chartIds = SIZE_GUIDE.charts.map((chart) => chart.id);
  assert.deepEqual(chartIds, [...expectedIds]);

  // APPROVED_SIZE_GUIDES has title and id matching charts
  assert.deepEqual(
    APPROVED_SIZE_GUIDES,
    SIZE_GUIDE.charts.map((chart) => ({
      id: chart.id,
      title: chart.title,
    })),
  );
});

test("M1 isApprovedSizeGuideId validates allowlist and rejects unapproved or legacy IDs", () => {
  for (const id of ["ao-dai", "set-vay-form-rong", "set-vay-form-nho"]) {
    assert.equal(isApprovedSizeGuideId(id), true, `${id} must be approved`);
  }

  // Rejects legacy menswear charts
  assert.equal(isApprovedSizeGuideId("menswear-relaxed"), false);
  assert.equal(isApprovedSizeGuideId("chart-a"), false);
  assert.equal(isApprovedSizeGuideId("chart-b"), false);
  assert.equal(isApprovedSizeGuideId("Relaxed fit."), false);

  // Rejects arbitrary text
  assert.equal(isApprovedSizeGuideId("random-guide"), false);
  assert.equal(isApprovedSizeGuideId("model-180cm"), false);
  assert.equal(isApprovedSizeGuideId(""), false);
  assert.equal(isApprovedSizeGuideId("   "), false);

  // Rejects category keys/slugs
  assert.equal(isApprovedSizeGuideId("aoDaiTet"), false);
  assert.equal(isApprovedSizeGuideId("aoDaiCachTan"), false);
  assert.equal(isApprovedSizeGuideId("setVay"), false);
  assert.equal(isApprovedSizeGuideId("/ao-dai"), false);

  // Rejects non-string types
  assert.equal(isApprovedSizeGuideId(null), false);
  assert.equal(isApprovedSizeGuideId(undefined), false);
  assert.equal(isApprovedSizeGuideId(123), false);
  assert.equal(isApprovedSizeGuideId({}), false);
  assert.equal(isApprovedSizeGuideId([]), false);
});

test("M1 Zero Category Inference Guarantee: unassigned products never derive a size guide from category or name", () => {
  // Test every category key in the canonical taxonomy
  for (const categoryKey of CATEGORY_KEYS) {
    // Even if product name strongly suggests 'Áo dài Tết' or belongs to category 'aoDaiTet',
    // an unmapped sizeGuide must remain null.
    const viewModel = buildProductViewModel(
      productInput({
        name: `Sản phẩm mẫu ${categoryKey}`,
        sizeGuide: null,
      }),
    );

    assert.equal(
      viewModel.editorial.sizeGuide,
      null,
      `Category "${categoryKey}" must never infer a size guide`,
    );
  }
});

test("M1 explicit size guide survives onto product view model without alteration", () => {
  for (const guideId of APPROVED_SIZE_GUIDE_IDS) {
    const viewModel = buildProductViewModel(
      productInput({
        sizeGuide: guideId,
      }),
    );

    assert.equal(viewModel.editorial.sizeGuide, guideId);
    assert.equal(viewModel.editorial.hasNotes, true);
  }
});
