import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveStorefrontDiscountPresentation } from "../../src/commerce/storefront-discount-presentation.ts";
import {
  buildStorefrontProductProjection,
  deriveStorefrontProjectionSelection,
  selectStorefrontProductLevelOptions,
  type StorefrontProjectionOption,
} from "../../src/commerce/storefront-projection.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
} from "../../src/commerce/storefront-product.ts";
import { resolveVariantSelectionView } from "../../src/components/headless/variant-selection-model.ts";

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function variant(id: string, size: string): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size,
    sellableStock: 2,
    retailPrice: 200_000,
    retailPriceAfterDiscount: 200_000,
  };
}

test("selected PDP variant keeps its own base price, effective price, and discount state", () => {
  const pricingRule: StorefrontPricingRule = (candidate) =>
    candidate.id === "variant-m"
      ? { price: 90_000, basePriceVnd: 100_000, isDiscounted: true }
      : { price: 100_000, basePriceVnd: 200_000, isDiscounted: true };

  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("variant-m", "M"), variant("variant-l", "L")],
    componentGroups: [],
    hasCompositeGraph: false,
    pricingRule,
  });

  const medium = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: "M",
  });
  assert.deepEqual(
    {
      variantId: medium.selectedVariantId,
      basePriceVnd: medium.selectedBasePriceVnd,
      price: medium.selectedPrice,
      isDiscounted: medium.selectedIsDiscounted,
    },
    {
      variantId: "variant-m",
      basePriceVnd: 100_000,
      price: 90_000,
      isDiscounted: true,
    },
  );

  const large = deriveStorefrontProjectionSelection(projection.options, {
    kindKey: null,
    color: null,
    size: "L",
  });
  assert.deepEqual(
    {
      variantId: large.selectedVariantId,
      basePriceVnd: large.selectedBasePriceVnd,
      price: large.selectedPrice,
      isDiscounted: large.selectedIsDiscounted,
    },
    {
      variantId: "variant-l",
      basePriceVnd: 200_000,
      price: 100_000,
      isDiscounted: true,
    },
  );
});

test("unselected composite PDP sale presentation is owned by the parent set, not a component", () => {
  const pricingRule: StorefrontPricingRule = (candidate) =>
    candidate.id === "set-m"
      ? { price: 180_000, basePriceVnd: 200_000, isDiscounted: true }
      : { price: 50_000, basePriceVnd: 100_000, isDiscounted: true };

  const projection = buildStorefrontProductProjection({
    parentVariants: [variant("set-m", "M")],
    componentGroups: [{ label: "Áo", variants: [variant("shirt-m", "M")] }],
    hasCompositeGraph: true,
    pricingRule,
  });

  assert.deepEqual(
    resolveStorefrontDiscountPresentation(selectStorefrontProductLevelOptions(projection)),
    {
      representativeVariantId: "set-m",
      basePriceVnd: 200_000,
      effectivePriceVnd: 180_000,
      discountPercent: 10,
      hasCheaperCurrentVariant: false,
    },
  );
});

test("PDP wires product-level options into its unselected price presentation", async () => {
  // The wiring half is still checked as source, because a route module cannot be imported here. It
  // moved with the migration: the PDP's loader now selects the product-level options and seals them
  // onto the view model, and the page hands that straight to the purchase panel.
  const loaderSource = await readFile(new URL("../../src/routes/product.ts", import.meta.url), "utf8");
  const pageSource = await readFile(
    new URL("../../src/app/shop/[slug]/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(loaderSource, /selectStorefrontProductLevelOptions/);
  assert.match(loaderSource, /productLevelOptions: selectStorefrontProductLevelOptions\(/);
  assert.match(pageSource, /productLevelOptions: data\.productLevelOptions/);

  // The panel half used to be checked the same way, by matching
  // `resolveStorefrontDiscountPresentation(productLevelOptions)` in the panel's source. That call
  // now lives in the headless selection model the panel renders, so the text match would only
  // prove where the code sits. The contract itself -- an unselected PDP prices from the parent's
  // own options, never from a cheaper component -- is asserted directly instead.
  const parentOnly = [
    {
      id: "set-m",
      pancakeVariationId: "pancake-set-m",
      kindKey: null,
      kindLabel: null,
      color: null,
      size: "M",
      price: 180_000,
      basePriceVnd: 200_000,
      isDiscounted: true,
      purchasable: true,
      unavailableReason: null,
    },
  ] as unknown as StorefrontProjectionOption[];
  const withComponent = [
    ...parentOnly,
    {
      ...parentOnly[0]!,
      id: "shirt-m",
      pancakeVariationId: "pancake-shirt-m",
      price: 50_000,
      basePriceVnd: 100_000,
    },
  ] as unknown as StorefrontProjectionOption[];

  const view = resolveVariantSelectionView({
    options: withComponent,
    productLevelOptions: parentOnly,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.initialDiscount?.representativeVariantId, "set-m");
  assert.equal(view.priceDisplay.compareAtText, currency.format(200_000));
  assert.equal(view.priceDisplay.displayText, currency.format(180_000));
});

test("every promotion-aware storefront surface mounts the shared server-relative refresher", async () => {
  // All four promotion-aware surfaces have now crossed onto the shell, so the guarantee is
  // structural rather than per-page: the shell mounts the refresher from the duration each loader
  // sealed, and a page cannot drop it. A surface that has not migrated would instead have to mount
  // the refresher in its own source -- there are none left in this list, so that path is gone
  // rather than kept as an unreachable branch.
  //
  // A8 retired `/lookbook`; `/sale` is the discount surface that replaced it here, and it is the
  // one with the sharpest refresh requirement of the four.
  const shell = await readFile(new URL("../../src/routes/core.tsx", import.meta.url), "utf8");
  assert.match(shell, /<StorefrontPromotionRefresher refreshAfterMs=\{payload\.refreshAfterMs\}/);

  const surfaces = [
    { page: "../../src/app/page.tsx", loader: "../../src/routes/home.ts" },
    { page: "../../src/app/shop/[slug]/page.tsx", loader: "../../src/routes/product.ts" },
    { page: "../../src/app/collections/[slug]/page.tsx", loader: "../../src/routes/collection.ts" },
    { page: "../../src/app/sale/page.tsx", loader: "../../src/routes/sale.ts" },
  ] as const;

  for (const surface of surfaces) {
    const [source, loader] = await Promise.all([
      readFile(new URL(surface.page, import.meta.url), "utf8"),
      readFile(new URL(surface.loader, import.meta.url), "utf8"),
    ]);

    assert.match(
      source,
      /createStorefrontRoute/,
      `${surface.page} is migrated, so it must render through the shell`,
    );
    assert.match(
      loader,
      /refreshAfterMs/,
      `${surface.loader} must seal a server-relative refresh duration for the shell to mount`,
    );
  }
});
