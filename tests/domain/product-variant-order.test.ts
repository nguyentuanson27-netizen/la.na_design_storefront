import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVariantColor,
  orderProductVariants,
  parseVariantColorOrder,
} from "../../src/commerce/product-variant-order.ts";
import { toStorefrontProduct } from "../../src/commerce/storefront-catalog.ts";

const label = (variants: readonly { color?: string | null; size?: string | null }[]) =>
  variants.map((variant) => `${variant.color}-${variant.size}`);

test("normalizeVariantColor ignores case, spacing and composed-vs-decomposed accents", () => {
  assert.equal(normalizeVariantColor("  HỒNG "), "hồng");
  assert.equal(normalizeVariantColor("Hồng"), normalizeVariantColor("Hồng"));
  assert.equal(normalizeVariantColor("Xanh   lá"), "xanh lá");
  assert.equal(normalizeVariantColor(null), "");
});

test("orderProductVariants puts the configured color first and sorts sizes within each color", () => {
  const variants = [
    { color: "Be", size: "L" },
    { color: "Be", size: "M" },
    { color: "Hồng", size: "XL" },
    { color: "Hồng", size: "S" },
    { color: "Be", size: "XL" },
    { color: "Hồng", size: "M" },
    { color: "Be", size: "S" },
    { color: "Hồng", size: "L" },
  ];

  assert.deepEqual(label(orderProductVariants(variants, ["Hồng", "Be"])), [
    "Hồng-S",
    "Hồng-M",
    "Hồng-L",
    "Hồng-XL",
    "Be-S",
    "Be-M",
    "Be-L",
    "Be-XL",
  ]);
});

test("orderProductVariants returns variants unchanged when no order is configured", () => {
  const variants = [
    { color: "Đen", size: "M" },
    { color: "Trắng", size: "S" },
    { color: "Đen", size: "S" },
  ];

  assert.deepEqual(orderProductVariants(variants, undefined), variants);
  assert.deepEqual(orderProductVariants(variants, null), variants);
  assert.deepEqual(orderProductVariants(variants, []), variants);
  assert.deepEqual(orderProductVariants(variants, ["  "]), variants);
  assert.notEqual(orderProductVariants(variants, null), variants, "never hands back the input array");
});

test("orderProductVariants matches colors ignoring case, spacing and accent encoding", () => {
  const variants = [
    { color: "Be", size: "S" },
    { color: " hồng ", size: "S" },
    { color: "HỒNG", size: "M" },
    { color: "Hồng", size: "L" },
  ];

  assert.deepEqual(
    orderProductVariants(variants, ["Hồng"]).map((variant) => variant.size),
    ["S", "M", "L", "S"],
  );
  assert.equal(orderProductVariants(variants, ["Hồng"])[3]?.color, "Be");
});

test("colors the order does not name keep their own grouping and first-seen order", () => {
  const variants = [
    { color: "Đen", size: "S" },
    { color: "Trắng", size: "M" },
    { color: "Đen", size: "M" },
    { color: "Trắng", size: "S" },
    { color: "Hồng", size: "S" },
  ];

  assert.deepEqual(label(orderProductVariants(variants, ["Hồng"])), [
    "Hồng-S",
    "Đen-S",
    "Đen-M",
    "Trắng-S",
    "Trắng-M",
  ]);
});

test("a variant with no size follows the sized ones, and equal sizes keep their original order", () => {
  const variants = [
    { color: "Hồng", size: null, id: "a" },
    { color: "Hồng", size: "M", id: "b" },
    { color: "Hồng", size: "", id: "c" },
    { color: "Hồng", size: "M", id: "d" },
    { color: "Hồng", size: "S", id: "e" },
  ];

  assert.deepEqual(
    orderProductVariants(variants, ["Hồng"]).map((variant) => variant.id),
    ["e", "b", "d", "a", "c"],
  );
});

test("orderProductVariants does not depend on the input's initial arrangement", () => {
  const sizes = ["S", "M", "L", "XL"];
  const colors = ["Be", "Hồng", "Đen"];
  const all = colors.flatMap((color) => sizes.map((size) => ({ color, size })));
  const expected = label(orderProductVariants(all, ["Hồng", "Be"]));

  for (let seed = 1; seed <= 20; seed += 1) {
    let state = seed;
    const shuffled = [...all].sort(() => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % 3 - 1;
    });
    assert.deepEqual(
      label(orderProductVariants(shuffled, ["Hồng", "Be"])).slice(0, 8),
      expected.slice(0, 8),
    );
  }
});

test("parseVariantColorOrder turns positions into an ordered list in the catalog's spelling", () => {
  const colors = ["Be", "Hồng", "Đen"];

  assert.deepEqual(
    parseVariantColorOrder(
      [
        { color: "Be", position: "2" },
        { color: "Hồng", position: "1" },
        { color: "Đen", position: "" },
      ],
      colors,
    ),
    { ok: true, colors: ["Hồng", "Be"] },
  );
  // Ties keep the form's order; a different case or accent encoding still finds the color.
  assert.deepEqual(
    parseVariantColorOrder(
      [
        { color: "be", position: 1 },
        { color: "Hồng", position: "1" },
      ],
      colors,
    ),
    { ok: true, colors: ["Be", "Hồng"] },
  );
  assert.deepEqual(parseVariantColorOrder([{ color: "Be", position: "  " }], colors), {
    ok: true,
    colors: [],
  });
});

test("parseVariantColorOrder refuses unknown colors, repeats and positions that are not 1..20", () => {
  const colors = ["Be", "Hồng"];
  const reason = (entries: { color: unknown; position: unknown }[]) => {
    const result = parseVariantColorOrder(entries, colors);
    return result.ok ? "ok" : result.reason;
  };

  assert.equal(reason([{ color: "Xanh", position: "1" }]), "unknown-color");
  assert.equal(reason([{ color: "Be", position: "1" }, { color: "be", position: "2" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: "0" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: "-1" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: "1.5" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: "abc" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: "21" }]), "invalid");
  assert.equal(reason([{ color: 5, position: "1" }]), "invalid");
  assert.equal(reason([{ color: "Be", position: {} }]), "invalid");
});

function rawProduct(variantColorOrder: { colors: string[] } | null) {
  const pinkImg = "https://content.pancake.vn/images/1/2/3/pink.jpg";
  const beigeImg = "https://content.pancake.vn/images/1/2/3/beige.jpg";
  const variant = (id: string, color: string, size: string, img: string) => ({
    id,
    pancakeVariationId: `${id}-pancake`,
    color,
    size,
    pancakeRetailPrice: 850000,
    pancakeRetailPriceAfterDiscount: 850000,
    pancakeImageUrls: [img],
    compositeComponents: [],
    warehouseStocks: [{ quantity: 5 }],
  });
  return {
    pinkImg,
    beigeImg,
    product: {
      id: "product-1",
      pancakeProductId: "pancake-product-1",
      slug: "set-vay-sv612",
      name: "Set váy Bích Liên",
      productCode: "SV612",
      primaryImageUrl: null,
      sellingPolicy: null,
      content: null,
      variantColorOrder,
      variants: [variant("var-be-l", "Be", "L", beigeImg), variant("var-hong-s", "Hồng", "S", pinkImg)],
    },
  };
}

test("toStorefrontProduct follows the stored color order: pink photo is primary, first in the gallery and listed first in the color options", () => {
  const { product: raw, pinkImg, beigeImg } = rawProduct({ colors: ["Hồng", "Be"] });
  const product = toStorefrontProduct(raw as unknown as Parameters<typeof toStorefrontProduct>[0]);

  assert.equal(product.media.primary?.url, pinkImg);
  assert.equal(product.media.gallery[0]?.url, pinkImg);
  assert.equal(product.media.gallery[1]?.url, beigeImg);
  assert.equal(product.variants[0]?.id, "var-hong-s");
  assert.equal(product.variants[1]?.id, "var-be-l");
  assert.equal(product.galleryIndexByVariantId["var-hong-s"], 0);
  assert.equal(product.galleryIndexByVariantId["var-be-l"], 1);
});

test("toStorefrontProduct leaves the catalog order alone when the product has no stored order", () => {
  const { product: raw, pinkImg, beigeImg } = rawProduct(null);
  const product = toStorefrontProduct(raw as unknown as Parameters<typeof toStorefrontProduct>[0]);

  assert.equal(product.media.primary?.url, beigeImg);
  assert.equal(product.media.gallery[1]?.url, pinkImg);
  assert.equal(product.variants[0]?.id, "var-be-l");
});

test("toStorefrontProduct follows whatever order an operator stores, not a fixed color", () => {
  const { product: raw, beigeImg } = rawProduct({ colors: ["be"] });
  const product = toStorefrontProduct(raw as unknown as Parameters<typeof toStorefrontProduct>[0]);

  assert.equal(product.media.primary?.url, beigeImg);
  assert.equal(product.variants[0]?.id, "var-be-l");
});
