import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_SIZE_GUIDE_IDS,
  APPROVED_SIZE_GUIDES,
  isApprovedSizeGuideId,
  SIZE_GUIDE,
} from "../../src/brand/size-guide.config.ts";
import {
  APPROVED_CATEGORY_MEMBERSHIP_POLICY,
  CATEGORY_KEYS,
  parseCategoryMembership,
  type CategoryMembershipRow,
} from "../../src/commerce/category-taxonomy.ts";
import type { StorefrontProductMedia } from "../../src/commerce/product-media.ts";
import type { SelectedStorefrontProductPayload } from "../../src/commerce/storefront-catalog.ts";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";
import {
  buildProductViewModel,
  type ProductViewModelInput,
} from "../../src/routes/product-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:5432/placeholder";

const {
  createStorefrontCatalogRepository,
  toStorefrontProduct,
} = await import("../../src/commerce/storefront-catalog.ts");

const media: StorefrontProductMedia = {
  primary: { url: "https://content.pancake.vn/photo-1.jpg", alt: "" },
  gallery: [{ url: "https://content.pancake.vn/photo-1.jpg", alt: "" }],
};

function rawProductPayload(
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    sizeGuide?: string | null;
    status?: "DRAFT" | "REVIEWED" | "PUBLISHED";
  } = {},
): SelectedStorefrontProductPayload {
  const id = overrides.id ?? "prod-test-1";
  const slug = overrides.slug ?? "san-pham-test";
  const name = overrides.name ?? "Sản phẩm test";
  const status = overrides.status ?? "PUBLISHED";
  const sizeGuide = overrides.sizeGuide !== undefined ? overrides.sizeGuide : null;

  return {
    id,
    pancakeProductId: `pancake-${id}`,
    slug,
    name,
    primaryImageUrl: "https://content.pancake.vn/photo-1.jpg",
    content: {
      status,
      editorialDescription: "Mô tả sản phẩm kiểm thử.",
      material: "Lụa tự nhiên",
      craftDetails: ["Thêu tay truyền thống"],
      careInstructions: "Giặt tay nhẹ nhàng.",
      sizeGuide,
      seoTitle: name,
      seoDescription: "Mô tả SEO.",
      collectionSlugs: [],
    },
    variants: [
      {
        id: `var-${id}-1`,
        pancakeVariationId: `pv-${id}-1`,
        color: "Đỏ",
        size: "M",
        pancakeRetailPrice: 1_200_000,
        pancakeRetailPriceAfterDiscount: 1_200_000,
        pancakeImageUrls: "[]",
        warehouseStocks: [{ quantity: 5 }],
      },
    ],
  };
}

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

  // APPROVED_SIZE_GUIDES has title and id matching charts without unsafe casts
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

test("M1 Zero Category Inference Guarantee: storefront catalog assembly and repository loading never infer size guide from category membership", async () => {
  // Exercise every category in the canonical Brand #2 taxonomy
  for (const categoryKey of CATEGORY_KEYS) {
    // 1. Build real validated category membership for this category
    const validMembership = parseCategoryMembership([categoryKey], APPROVED_CATEGORY_MEMBERSHIP_POLICY);
    const membershipRows: CategoryMembershipRow[] = validMembership.categoryKeys.map((k) => ({
      productId: `prod-${categoryKey}`,
      categoryKey: k,
    }));
    assert.ok(membershipRows.length > 0, `Category ${categoryKey} must have valid membership rows`);

    // 2. Create raw product fixture carrying this category membership and unmapped sizeGuide (null)
    const rawProduct = rawProductPayload({
      id: `prod-${categoryKey}`,
      slug: `san-pham-${categoryKey}`,
      name: `Sản phẩm thuộc nhóm ${categoryKey}`,
      sizeGuide: null,
    });

    // 3. Test through the production catalog assembly boundary (toStorefrontProduct)
    const storefrontProduct = toStorefrontProduct(rawProduct);
    assert.equal(
      storefrontProduct.sizeGuide,
      null,
      `toStorefrontProduct must not infer size guide from category "${categoryKey}"`,
    );

    // 4. Test through the storefront catalog repository loading boundary (getProductBySlug)
    let queriedSlug = "";
    const mockClient = {
      productMirror: {
        async findFirst({ where }: { where: { slug: string } }) {
          queriedSlug = where.slug;
          return rawProduct;
        },
      },
      collectionDefinition: {
        async findMany() {
          return [];
        },
      },
    } as unknown as PrismaClient;

    const repository = createStorefrontCatalogRepository(mockClient);
    const loadedProduct = await repository.getProductBySlug({
      shopId: 1,
      slug: rawProduct.slug,
    });
    assert.equal(queriedSlug, rawProduct.slug);
    assert.ok(loadedProduct);
    assert.equal(
      loadedProduct.sizeGuide,
      null,
      `repository getProductBySlug must return sizeGuide: null for category "${categoryKey}"`,
    );

    // 5. Test through the PDP view model boundary (buildProductViewModel)
    const viewModel = buildProductViewModel({
      slug: loadedProduct.slug,
      name: loadedProduct.name,
      media: loadedProduct.media,
      collections: loadedProduct.collections,
      editorialDescription: loadedProduct.editorialDescription,
      material: loadedProduct.material,
      craftDetails: loadedProduct.craftDetails,
      sizeGuide: loadedProduct.sizeGuide,
      careInstructions: loadedProduct.careInstructions,
      options: [],
      productLevelOptions: [],
      deepLinkedSelection: null,
      galleryIndexByVariantId: {},
      relatedProducts: [],
      relatedSelectEventBySlug: new Map<string, TrackingEvent>(),
    });

    assert.equal(
      viewModel.editorial.sizeGuide,
      null,
      `PDP view model must receive sizeGuide: null for category "${categoryKey}"`,
    );
  }
});

test("M1 Category and Size Guide Independence: explicit size-guide mapping is strictly preserved without category override", async () => {
  // Test 1: An Áo Dài Tết product explicitly assigned to a non-ao-dai guide ("set-vay-form-nho")
  const aoDaiMembership = parseCategoryMembership(["aoDaiTet"], APPROVED_CATEGORY_MEMBERSHIP_POLICY);
  assert.ok(aoDaiMembership.categoryKeys.includes("aoDaiTet"));

  const aoDaiWithSmallForm = rawProductPayload({
    id: "prod-ao-dai-custom",
    slug: "ao-dai-cach-tan-form-nho",
    name: "Áo Dài Cách Tân Form Nhỏ",
    sizeGuide: "set-vay-form-nho",
  });

  const resolvedAoDai = toStorefrontProduct(aoDaiWithSmallForm);
  assert.equal(
    resolvedAoDai.sizeGuide,
    "set-vay-form-nho",
    "Explicit size guide must not be overridden to 'ao-dai' by category",
  );

  // Test 2: A Set/Váy product explicitly assigned to "ao-dai"
  const setVayMembership = parseCategoryMembership(["setVay"], APPROVED_CATEGORY_MEMBERSHIP_POLICY);
  assert.ok(setVayMembership.categoryKeys.includes("setVay"));

  const setVayWithAoDai = rawProductPayload({
    id: "prod-set-vay-custom",
    slug: "set-vay-form-ao-dai",
    name: "Set Váy Kèm Khăn",
    sizeGuide: "ao-dai",
  });

  const resolvedSetVay = toStorefrontProduct(setVayWithAoDai);
  assert.equal(
    resolvedSetVay.sizeGuide,
    "ao-dai",
    "Explicit size guide must not be overridden to a set-vay guide by category",
  );

  // Test 3: Every approved guide survives onto the PDP view model
  for (const guideId of APPROVED_SIZE_GUIDE_IDS) {
    const vm = buildProductViewModel(
      productInput({
        sizeGuide: guideId,
      }),
    );
    assert.equal(vm.editorial.sizeGuide?.id, guideId);
    assert.equal(vm.editorial.sizeGuide?.chart.id, guideId);
    assert.equal(vm.editorial.hasNotes, false);
  }
});



test("F7c PDP model resolves only the exact manually mapped approved guide", () => {
  const aoDai = buildProductViewModel(productInput({ sizeGuide: "ao-dai" }));
  const wide = buildProductViewModel(productInput({ sizeGuide: "set-vay-form-rong" }));
  const unmapped = buildProductViewModel(productInput({ sizeGuide: null }));
  const invalid = buildProductViewModel(productInput({ sizeGuide: "vayDam" }));

  assert.equal(aoDai.editorial.sizeGuide?.id, "ao-dai");
  assert.equal(aoDai.editorial.sizeGuide?.chart.title, "Áo dài");
  assert.equal(wide.editorial.sizeGuide?.id, "set-vay-form-rong");
  assert.equal(wide.editorial.sizeGuide?.chart.title, "Set/Váy form rộng");
  assert.notDeepEqual(aoDai.editorial.sizeGuide, wide.editorial.sizeGuide);

  // Missing/invalid mappings fail closed: no category/name/option inference or default guide.
  assert.equal(unmapped.editorial.sizeGuide, null);
  assert.equal(invalid.editorial.sizeGuide, null);
});
