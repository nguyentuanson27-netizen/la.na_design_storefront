import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_COLOR_PREFERENCE,
  orderProductVariants,
  resolveProductColorPreference,
} from "../../src/commerce/product-variant-order.ts";
import { toStorefrontProduct } from "../../src/commerce/storefront-catalog.ts";

test("resolveProductColorPreference identifies SV612 by productCode, slug, or name", () => {
  assert.deepEqual(resolveProductColorPreference({ productCode: "SV612" }), ["Hồng", "Be"]);
  assert.deepEqual(resolveProductColorPreference({ productCode: "sv612" }), ["Hồng", "Be"]);
  assert.deepEqual(
    resolveProductColorPreference({ slug: "set-vay-sv612-f744f18552eb6205655a" }),
    ["Hồng", "Be"],
  );
  assert.deepEqual(
    resolveProductColorPreference({ name: "Set váy Bích Liên SV612" }),
    ["Hồng", "Be"],
  );
  assert.equal(resolveProductColorPreference({ productCode: "OTHER" }), null);
});

test("orderProductVariants places preferred color variants first and orders sizes within color", () => {
  const variants = [
    { id: "1", color: "Be", size: "L", pancakeVariationId: "0642e596" },
    { id: "2", color: "Be", size: "M", pancakeVariationId: "2566ec28" },
    { id: "3", color: "Hồng", size: "XL", pancakeVariationId: "799cf9bb" },
    { id: "4", color: "Hồng", size: "S", pancakeVariationId: "6e3e5bc3" },
    { id: "5", color: "Be", size: "XL", pancakeVariationId: "74a4413f" },
    { id: "6", color: "Hồng", size: "M", pancakeVariationId: "8815121f" },
    { id: "7", color: "Be", size: "S", pancakeVariationId: "b0e14a1a" },
    { id: "8", color: "Hồng", size: "L", pancakeVariationId: "c72b2fe6" },
  ];

  const ordered = orderProductVariants({ productCode: "SV612" }, variants);

  assert.deepEqual(
    ordered.map((v) => `${v.color}-${v.size}`),
    [
      "Hồng-S",
      "Hồng-M",
      "Hồng-L",
      "Hồng-XL",
      "Be-S",
      "Be-M",
      "Be-L",
      "Be-XL",
    ],
  );
});

test("orderProductVariants leaves variants unchanged for products without preference", () => {
  const variants = [
    { id: "1", color: "Đen", size: "M" },
    { id: "2", color: "Trắng", size: "S" },
  ];

  const ordered = orderProductVariants({ productCode: "AD001" }, variants);
  assert.deepEqual(ordered, variants);
});

test("toStorefrontProduct orders SV612 variants with Pink first, setting Pink image as primary and first in gallery", () => {
  const pinkImg = "https://content.pancake.vn/images/1/2/3/pink.jpg";
  const beigeImg = "https://content.pancake.vn/images/1/2/3/beige.jpg";

  const rawProduct = {
    id: "cmugo2galf9bb1aaac98f2741",
    pancakeProductId: "e37c978c-4f99-4f2e-832e-fb2dbba1c40d",
    slug: "set-vay-sv612-f744f18552eb6205655a",
    name: "Set váy Bích Liên",
    productCode: "SV612",
    primaryImageUrl: null,
    sellingPolicy: null,
    content: null,
    variants: [
      {
        id: "var-be-l",
        pancakeVariationId: "0642e596-eb12-4720-b197-64dc409707f2",
        color: "Be",
        size: "L",
        pancakeRetailPrice: 850000,
        pancakeRetailPriceAfterDiscount: 850000,
        pancakeImageUrls: [beigeImg],
        compositeComponents: [],
        warehouseStocks: [{ quantity: 5 }],
      },
      {
        id: "var-hong-s",
        pancakeVariationId: "6e3e5bc3-eb12-4720-b197-64dc409707f2",
        color: "Hồng",
        size: "S",
        pancakeRetailPrice: 850000,
        pancakeRetailPriceAfterDiscount: 850000,
        pancakeImageUrls: [pinkImg],
        compositeComponents: [],
        warehouseStocks: [{ quantity: 10 }],
      },
    ],
  };

  const product = toStorefrontProduct(rawProduct as any);

  // 1. Primary image is Pink
  assert.equal(product.media.primary?.url, pinkImg);

  // 2. First gallery image is Pink, second is Beige
  assert.equal(product.media.gallery[0]?.url, pinkImg);
  assert.equal(product.media.gallery[1]?.url, beigeImg);

  // 3. First variant is Pink
  assert.equal(product.variants[0]?.color, "Hồng");
  assert.equal(product.variants[0]?.id, "var-hong-s");
  assert.equal(product.variants[1]?.color, "Be");

  // 4. Gallery index mapping: Pink -> 0, Beige -> 1
  assert.equal(product.galleryIndexByVariantId["var-hong-s"], 0);
  assert.equal(product.galleryIndexByVariantId["var-be-l"], 1);
});
