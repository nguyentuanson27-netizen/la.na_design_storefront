import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { StorefrontProductMedia, TrustedProductImage } from "../../src/commerce/product-media.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";
import { resolveGalleryModel } from "../../src/components/headless/resolve-gallery-model.ts";
import { resolveVariantSelectionView } from "../../src/components/headless/variant-selection-model.ts";

/**
 * The seam that lets one selection state drive both the purchase panel and the gallery.
 *
 * A PDP has to show the shopper's colour choice in two places at once. That only works if the
 * panel's selection is something a page can hold and hand to both components, rather than state
 * hidden inside the panel. These tests hold both halves of that: the decision chain end to end,
 * and the component surfaces that make it wireable.
 */

function option(overrides: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  return {
    id: "variant-1",
    pancakeVariationId: "pancake-1",
    kindKey: null,
    kindLabel: null,
    color: null,
    size: "S",
    price: 100_000,
    basePriceVnd: null,
    isDiscounted: false,
    purchasable: true,
    unavailableReason: null,
    ...overrides,
  } as StorefrontProjectionOption;
}

function image(n: number): TrustedProductImage {
  return { url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt: "" };
}

const media: StorefrontProductMedia = {
  primary: image(1),
  gallery: [image(1), image(2), image(3), image(4)],
};

const options = [
  option({ id: "black-s", color: "Đen", size: "S" }),
  option({ id: "white-s", color: "Trắng", size: "S" }),
];

/** Server-resolved, the same map `?variant=` deep links already use. */
const galleryIndexByVariantId = { "black-s": 1, "white-s": 3 };

/* ---------------------------------------------------------- the chain end to end */

test("the variant the panel resolves is the photo the gallery shows", () => {
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: "Trắng", size: "S" },
  });
  assert.equal(view.selectedVariantId, "white-s");

  const gallery = resolveGalleryModel({
    media,
    productName: "Áo sơ mi",
    selectedVariantId: view.selectedVariantId,
    galleryIndexByVariantId,
  });

  assert.equal(gallery.activeIndex, 3, "the gallery follows the panel's variant");
});

test("changing colour moves the photo with it", () => {
  const indexFor = (color: string) =>
    resolveGalleryModel({
      media,
      productName: "Áo sơ mi",
      selectedVariantId: resolveVariantSelectionView({
        options,
        productLevelOptions: options,
        selection: { kindKey: null, color, size: "S" },
      }).selectedVariantId,
      galleryIndexByVariantId,
    }).activeIndex;

  assert.equal(indexFor("Đen"), 1);
  assert.equal(indexFor("Trắng"), 3);
});

test("an incomplete selection leaves the gallery where the server opened it", () => {
  // Nothing chosen yet resolves to no variant, and a gallery must not jump on that.
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(view.selectedVariantId, null);

  const gallery = resolveGalleryModel({
    media,
    productName: "Áo sơ mi",
    initialIndex: 2,
    selectedVariantId: view.selectedVariantId,
    galleryIndexByVariantId,
  });

  assert.equal(gallery.activeIndex, 2);
});

/* ------------------------------------------------- the surfaces that make it wireable */

test("the panel can render a controller it does not own, and still owns one when alone", async () => {
  // Without the first of these, a page cannot drive the panel and the gallery from one selection:
  // it would have to duplicate the state or reimplement the hook.
  const source = await readFile(
    new URL("../../src/components/brand/purchase-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /export function PurchasePanelView\(\{ controller \}/,
    "the view must take a controller as a prop",
  );
  assert.match(
    source,
    /export function BrandPurchasePanel\(props: UseVariantSelectionInput\)/,
    "the standalone panel must remain, so the existing route is unchanged",
  );

  const viewBody = source.slice(
    source.indexOf("export function PurchasePanelView"),
    source.indexOf("export function BrandPurchasePanel"),
  );
  assert.equal(
    viewBody.includes("useVariantSelection("),
    false,
    "the view must not call the hook: owning it is what made the seam unwireable",
  );
});

test("the brand panel speaks the hook's types, not commerce's", async () => {
  const source = await readFile(
    new URL("../../src/components/brand/purchase-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.includes("@/commerce/"),
    false,
    "brand markup reaches commerce only through the headless hook's public surface",
  );
});

test("the gallery accepts the selection the panel resolves", async () => {
  const source = await readFile(
    new URL("../../src/components/brand/product-gallery.tsx", import.meta.url),
    "utf8",
  );

  // It takes the model's whole input minus the state it owns itself, which is what carries
  // `selectedVariantId` and `galleryIndexByVariantId` through to the model.
  assert.match(source, /Omit<GalleryModelInput, "manualSelection">/);
});
