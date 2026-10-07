import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCompositeComponentImageUrls,
  buildCompositeVariantGalleryTargets,
  remainingComponentCandidateBudget,
  resolveStorefrontProductMedia,
  resolveVariantGalleryIndexes,
  MAX_STOREFRONT_GALLERY_IMAGES,
} from "../../src/commerce/product-media.ts";

test("extractCompositeComponentImageUrls returns empty array when variants have no composite components", () => {
  const result = extractCompositeComponentImageUrls([
    { compositeComponents: null },
    { compositeComponents: [] },
  ]);
  assert.deepEqual(result, []);
});

test("extractCompositeComponentImageUrls skips inactive or deleted component variants", () => {
  const result = extractCompositeComponentImageUrls([
    {
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-inactive",
            isActive: false,
            isPresent: true,
            pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/inactive.jpg"],
          },
        },
        {
          componentVariant: {
            id: "comp-deleted",
            isActive: true,
            isPresent: false,
            pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/deleted.jpg"],
          },
        },
        {
          componentVariant: {
            id: "comp-active",
            isActive: true,
            isPresent: true,
            pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/active.jpg"],
          },
        },
      ],
    },
  ]);

  assert.deepEqual(result, [["https://content.pancake.vn/images/1/2/3/active.jpg"]]);
});

test("extractCompositeComponentImageUrls deduplicates component variants across multiple parent variants", () => {
  // Parent variants S, M, L all referencing the same Top and Bottom components
  const sharedTopComponent = {
    id: "comp-top",
    isActive: true,
    isPresent: true,
    pancakeImageUrls: [
      "https://content.pancake.vn/images/1/2/3/top-1.jpg",
      "https://content.pancake.vn/images/1/2/3/top-2.jpg",
    ],
  };
  const sharedBottomComponent = {
    id: "comp-bottom",
    isActive: true,
    isPresent: true,
    pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/bottom-1.jpg"],
  };

  const variants = [
    {
      compositeComponents: [
        { componentVariant: sharedTopComponent },
        { componentVariant: sharedBottomComponent },
      ],
    },
    {
      compositeComponents: [
        { componentVariant: sharedTopComponent },
        { componentVariant: sharedBottomComponent },
      ],
    },
  ];

  const result = extractCompositeComponentImageUrls(variants);

  // Must only include top and bottom once, not duplicated for each parent variant
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], [
    "https://content.pancake.vn/images/1/2/3/top-1.jpg",
    "https://content.pancake.vn/images/1/2/3/top-2.jpg",
  ]);
  assert.deepEqual(result[1], ["https://content.pancake.vn/images/1/2/3/bottom-1.jpg"]);
});

test("buildCompositeVariantGalleryTargets maps parent variant photos first with component fallback", () => {
  const variants = [
    {
      id: "parent-v1",
      pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/parent-v1.jpg"],
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-shirt",
            pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/shirt.jpg"],
          },
        },
      ],
    },
    {
      id: "parent-v2-no-photo",
      pancakeImageUrls: [],
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-skirt",
            pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/skirt.jpg"],
          },
        },
      ],
    },
  ];

  const targets = buildCompositeVariantGalleryTargets(variants);

  // Targets include parent targets, then component targets
  assert.equal(targets.length, 4);

  // Parent V1 has its own image first
  assert.equal(targets[0]?.id, "parent-v1");
  assert.deepEqual(targets[0]?.imageUrls, [
    "https://content.pancake.vn/images/1/2/3/parent-v1.jpg",
    "https://content.pancake.vn/images/1/2/3/shirt.jpg",
  ]);

  // Parent V2 (no photo of its own) falls back to component photos
  assert.equal(targets[1]?.id, "parent-v2-no-photo");
  assert.deepEqual(targets[1]?.imageUrls, ["https://content.pancake.vn/images/1/2/3/skirt.jpg"]);

  // Component targets are also directly available
  assert.equal(targets[2]?.id, "comp-shirt");
  assert.deepEqual(targets[2]?.imageUrls, ["https://content.pancake.vn/images/1/2/3/shirt.jpg"]);

  assert.equal(targets[3]?.id, "comp-skirt");
  assert.deepEqual(targets[3]?.imageUrls, ["https://content.pancake.vn/images/1/2/3/skirt.jpg"]);
});

test("full composite gallery resolution: priority order, deduplication, and gallery indexing", () => {
  const primaryUrl = "https://content.pancake.vn/images/1/2/3/set-primary.jpg";
  const parentVariantUrl = "https://content.pancake.vn/images/1/2/3/set-v1.jpg";
  const componentShirtUrl1 = "https://content.pancake.vn/images/1/2/3/shirt-front.jpg";
  const componentShirtUrl2 = "https://content.pancake.vn/images/1/2/3/shirt-back.jpg";
  const componentPantsUrl = "https://content.pancake.vn/images/1/2/3/pants.jpg";

  // Simulate a composite product with 2 variants
  const rawVariants = [
    {
      id: "parent-s",
      pancakeImageUrls: [parentVariantUrl],
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-shirt-s",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [componentShirtUrl1, componentShirtUrl2, primaryUrl], // contains duplicate of primary
          },
        },
        {
          componentVariant: {
            id: "comp-pants-s",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [componentPantsUrl],
          },
        },
      ],
    },
    {
      id: "parent-m",
      pancakeImageUrls: [], // no photo of its own
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-shirt-m",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [componentShirtUrl1, componentShirtUrl2], // same images as shirt S
          },
        },
        {
          componentVariant: {
            id: "comp-pants-m",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [componentPantsUrl],
          },
        },
      ],
    },
  ];

  const parentImageLists = rawVariants.map((v) => v.pancakeImageUrls);
  const componentImageLists = extractCompositeComponentImageUrls(rawVariants);

  const media = resolveStorefrontProductMedia({
    productName: "SET QUẦN TỐ CẨM",
    primaryImageUrl: primaryUrl,
    variantImageUrls: [...parentImageLists, ...componentImageLists],
  });

  // Verify priority order: Primary -> Parent variant -> Component variant images
  assert.equal(media.primary?.url, primaryUrl);
  assert.deepEqual(
    media.gallery.map((img) => img.url),
    [
      primaryUrl,
      parentVariantUrl,
      componentShirtUrl1,
      componentShirtUrl2,
      componentPantsUrl,
    ],
  );

  // Verify galleryIndexByVariantId mapping
  const targets = buildCompositeVariantGalleryTargets(rawVariants);
  const indexByVariantId = resolveVariantGalleryIndexes({
    gallery: media.gallery,
    variants: targets,
  });

  // parent-s maps to its own image: set-v1.jpg (index 1)
  assert.equal(indexByVariantId.get("parent-s"), 1);

  // parent-m (no own image) falls back to component photo: shirt-front.jpg (index 2)
  assert.equal(indexByVariantId.get("parent-m"), 2);

  // Child components map directly to their photos
  assert.equal(indexByVariantId.get("comp-shirt-s"), 2);
  assert.equal(indexByVariantId.get("comp-pants-s"), 4);
  assert.equal(indexByVariantId.get("comp-shirt-m"), 2);
  assert.equal(indexByVariantId.get("comp-pants-m"), 4);
});

test("composite product with no primary and no parent images uses child component image as primary", () => {
  const shirtImg = "https://content.pancake.vn/images/1/2/3/ao-sv502.jpg";
  const skirtImg = "https://content.pancake.vn/images/1/2/3/chan-vay-sv502.jpg";

  const rawVariants = [
    {
      id: "set-s",
      pancakeImageUrls: [],
      compositeComponents: [
        {
          componentVariant: {
            id: "ao-s",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [shirtImg],
          },
        },
        {
          componentVariant: {
            id: "vay-s",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [skirtImg],
          },
        },
      ],
    },
  ];

  const parentImageLists = rawVariants.map((v) => v.pancakeImageUrls);
  const componentImageLists = extractCompositeComponentImageUrls(rawVariants);

  const media = resolveStorefrontProductMedia({
    productName: "Set Váy Phấn Nhiên",
    primaryImageUrl: null,
    variantImageUrls: [...parentImageLists, ...componentImageLists],
  });

  assert.ok(media.primary);
  assert.equal(media.primary.url, shirtImg);
  assert.equal(media.gallery.length, 2);
  assert.equal(media.gallery[0]?.url, shirtImg);
  assert.equal(media.gallery[1]?.url, skirtImg);
});

test("composite gallery adheres to MAX_STOREFRONT_GALLERY_IMAGES = 12 cap", () => {
  const parentImages = Array.from(
    { length: 8 },
    (_, i) => `https://content.pancake.vn/images/1/2/3/parent_${i + 1}.jpg`,
  );
  const componentImages = Array.from(
    { length: 10 },
    (_, i) => `https://content.pancake.vn/images/1/2/3/child_${i + 1}.jpg`,
  );

  const rawVariants = [
    {
      id: "parent-v1",
      pancakeImageUrls: parentImages,
      compositeComponents: [
        {
          componentVariant: {
            id: "comp-child",
            isPresent: true,
            isActive: true,
            pancakeImageUrls: componentImages,
          },
        },
      ],
    },
  ];

  const media = resolveStorefrontProductMedia({
    productName: "Capped Set",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/set-primary.jpg",
    variantImageUrls: [
      parentImages,
      ...extractCompositeComponentImageUrls(rawVariants),
    ],
  });

  assert.equal(media.gallery.length, MAX_STOREFRONT_GALLERY_IMAGES);
  assert.equal(media.gallery[0]?.url, "https://content.pancake.vn/images/1/2/3/set-primary.jpg");
  // 1 primary + 8 parent images = 9 slots. Remaining 3 slots filled by child images:
  assert.equal(media.gallery[8]?.url, "https://content.pancake.vn/images/1/2/3/parent_8.jpg");
  assert.equal(media.gallery[9]?.url, "https://content.pancake.vn/images/1/2/3/child_1.jpg");
  assert.equal(media.gallery[10]?.url, "https://content.pancake.vn/images/1/2/3/child_2.jpg");
  assert.equal(media.gallery[11]?.url, "https://content.pancake.vn/images/1/2/3/child_3.jpg");
});

test("extractCompositeComponentImageUrls stops traversing once the candidate budget is spent", () => {
  let touchedAfterBudget = false;
  const hugeList = new Proxy(
    Array.from({ length: 10_000 }, (_, index) => `https://content.pancake.vn/images/1/2/3/${index}.jpg`),
    {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop) && Number(prop) >= 5) {
          touchedAfterBudget = true;
        }
        return Reflect.get(target, prop, receiver);
      },
    },
  );
  const result = extractCompositeComponentImageUrls(
    [
      {
        compositeComponents: [
          { componentVariant: { id: "big", pancakeImageUrls: hugeList } },
          { componentVariant: { id: "later", pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/later.jpg"] } },
        ],
      },
    ],
    5,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]!.length, 5);
  assert.equal(touchedAfterBudget, false);
});

test("extractCompositeComponentImageUrls spends a shared component's budget once across parents", () => {
  const shared = {
    id: "shared",
    pancakeImageUrls: Array.from({ length: 60 }, (_, i) => `https://content.pancake.vn/images/1/2/3/s${i}.jpg`),
  };
  const valid = {
    id: "valid",
    pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/valid.jpg"],
  };
  const parent = { compositeComponents: [{ componentVariant: shared }, { componentVariant: valid }] };
  const result = extractCompositeComponentImageUrls([parent, parent, parent]);

  assert.deepEqual(result.map((list) => list.length), [60, 1]);
});

test("remainingComponentCandidateBudget subtracts primary and parent candidates", () => {
  assert.equal(remainingComponentCandidateBudget({ variantImageUrls: [] }), 100);
  assert.equal(
    remainingComponentCandidateBudget({ primaryImageUrl: "x", variantImageUrls: [["a", "b"], ["c"]] }),
    96,
  );
  assert.equal(
    remainingComponentCandidateBudget({ variantImageUrls: [Array.from({ length: 150 }, () => "a")] }),
    0,
  );
});

test("buildCompositeVariantGalleryTargets bounds every target to the candidate budget", () => {
  const big = Array.from({ length: 500 }, (_, i) => `https://content.pancake.vn/images/1/2/3/b${i}.jpg`);
  const targets = buildCompositeVariantGalleryTargets([
    {
      id: "parent",
      pancakeImageUrls: big,
      compositeComponents: [{ componentVariant: { id: "child", pancakeImageUrls: big } }],
    },
  ]);

  for (const target of targets) {
    assert.ok(target.imageUrls.length <= 100);
  }
});
