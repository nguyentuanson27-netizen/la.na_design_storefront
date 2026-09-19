import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontCartLines,
  type StorefrontCartProduct,
} from "../../src/commerce/storefront-cart.ts";

const availableProduct = {
  slug: "relaxed-shirt",
  pancakeProductId: "pancake-relaxed-shirt",
  name: "Relaxed Shirt",
  isPresent: true,
  isActive: true,
  variants: [
    {
      id: "available",
      pancakeVariationId: "pancake-available",
      isPresent: true,
      isActive: true,
      color: "Black",
      size: "M",
      sellableStock: 3,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "sold-out",
      pancakeVariationId: "pancake-sold-out",
      isPresent: true,
      isActive: true,
      color: "Black",
      size: "L",
      sellableStock: 0,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "inactive-variant",
      pancakeVariationId: "pancake-inactive-variant",
      isPresent: true,
      isActive: false,
      color: "Stone",
      size: "M",
      sellableStock: 2,
      retailPrice: 620_000,
      retailPriceAfterDiscount: 620_000,
    },
  ],
};

test("cart lines expose current storefront price and availability without exact stock", () => {
  const lines = buildStorefrontCartLines({
    items: [
      { variantId: "available", quantity: 2 },
      { variantId: "sold-out", quantity: 1 },
      { variantId: "inactive-variant", quantity: 1 },
    ],
    products: [availableProduct],
  });

  assert.deepEqual(lines, [
    {
      variantId: "available",
      pancakeVariationId: "pancake-available",
      pancakeProductId: "pancake-relaxed-shirt",
      productSlug: "relaxed-shirt",
      productName: "Relaxed Shirt",
      color: "Black",
      size: "M",
      quantity: 2,
      price: 590_000,
      available: true,
      isPreorderSale: false,
      unavailableReason: null,
      media: { primary: null, gallery: [] },
    },
    {
      variantId: "sold-out",
      pancakeVariationId: "pancake-sold-out",
      pancakeProductId: "pancake-relaxed-shirt",
      productSlug: "relaxed-shirt",
      productName: "Relaxed Shirt",
      color: "Black",
      size: "L",
      quantity: 1,
      price: 590_000,
      available: false,
      isPreorderSale: false,
      unavailableReason: "OUT_OF_STOCK",
      media: { primary: null, gallery: [] },
    },
    {
      variantId: "inactive-variant",
      pancakeVariationId: "pancake-inactive-variant",
      pancakeProductId: "pancake-relaxed-shirt",
      productSlug: "relaxed-shirt",
      productName: "Relaxed Shirt",
      color: "Stone",
      size: "M",
      quantity: 1,
      price: null,
      available: false,
      isPreorderSale: false,
      unavailableReason: "VARIANT_UNAVAILABLE",
      media: { primary: null, gallery: [] },
    },
  ]);

  assert.equal("sellableStock" in lines[0]!, false);
  assert.equal("retailPrice" in lines[0]!, false);
  assert.equal("retailPriceAfterDiscount" in lines[0]!, false);
});

test("cart line fails closed when its requested quantity exceeds current sellable stock", () => {
  const [line] = buildStorefrontCartLines({
    items: [{ variantId: "available", quantity: 4 }],
    products: [availableProduct],
  });

  assert.deepEqual(line, {
    variantId: "available",
    pancakeVariationId: "pancake-available",
    pancakeProductId: "pancake-relaxed-shirt",
    productSlug: "relaxed-shirt",
    productName: "Relaxed Shirt",
    color: "Black",
    size: "M",
    quantity: 4,
    price: 590_000,
    available: false,
    isPreorderSale: false,
    unavailableReason: "INSUFFICIENT_STOCK",
    media: { primary: null, gallery: [] },
  });
  assert.equal("sellableStock" in line!, false);
});

test("cart lines fail closed without linking unavailable product owners to dead PDPs", () => {
  const lines = buildStorefrontCartLines({
    items: [
      { variantId: "inactive-product-variant", quantity: 1 },
      { variantId: "unknown-variant", quantity: 1 },
    ],
    products: [
      {
        slug: "archived-jacket",
        pancakeProductId: "pancake-archived-jacket",
        name: "Archived Jacket",
        isPresent: false,
        isActive: false,
        variants: [
          {
            id: "inactive-product-variant",
            pancakeVariationId: "pancake-inactive-product-variant",
            isPresent: true,
            isActive: true,
            color: "Olive",
            size: "L",
            sellableStock: 4,
            retailPrice: 1_290_000,
            retailPriceAfterDiscount: 1_290_000,
          },
        ],
      },
    ],
  });

  assert.deepEqual(lines[0], {
    variantId: "inactive-product-variant",
    pancakeVariationId: "pancake-inactive-product-variant",
    // A private owner exposes no product-level identity, but the committed variation survives.
    pancakeProductId: null,
    productSlug: null,
    productName: "Archived Jacket",
    color: "Olive",
    size: "L",
    quantity: 1,
    price: null,
    available: false,
    isPreorderSale: false,
    unavailableReason: "PRODUCT_UNAVAILABLE",
    media: { primary: null, gallery: [] },
  });
  assert.deepEqual(lines[1], {
    variantId: "unknown-variant",
    // Nothing resolved, so nothing is invented.
    pancakeVariationId: null,
    pancakeProductId: null,
    productSlug: null,
    productName: null,
    color: null,
    size: null,
    quantity: 1,
    price: null,
    available: false,
    isPreorderSale: false,
    unavailableReason: "VARIANT_UNAVAILABLE",
    media: { primary: null, gallery: [] },
  });
});

test("cart lines resolve and expose trusted product media when present", () => {
  const productWithMedia = {
    slug: "linen-jacket",
    pancakeProductId: "pancake-linen-jacket",
    name: "Linen Jacket",
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/jacket-main.jpg",
    isPresent: true,
    isActive: true,
    variants: [
      {
        id: "var-1",
        pancakeVariationId: "pancake-var-1",
        isPresent: true,
        isActive: true,
        color: "Ink",
        size: "M",
        sellableStock: 5,
        retailPrice: 990_000,
        retailPriceAfterDiscount: 990_000,
        imageUrls: ["https://content.pancake.vn/images/1/2/3/jacket-ink.jpg"],
      },
    ],
  };

  const [line] = buildStorefrontCartLines({
    items: [{ variantId: "var-1", quantity: 1 }],
    products: [productWithMedia],
  });

  assert.equal(line?.media.primary?.url, "https://content.pancake.vn/images/1/2/3/jacket-main.jpg");
  assert.equal(line?.media.primary?.alt, "Linen Jacket");
  assert.equal(line?.media.gallery.length, 2);
});

/**
 * I5 — mode and hard-limit eligibility in the cart.
 *
 * Two distinct defects, and the tests keep them apart because the fixes are different: the cart
 * judged sellability by `STANDARD`'s floor for every product (no policy reached
 * `buildStorefrontVariantOptions`), and it judged the requested QUANTITY with `sellableStock <
 * quantity`, a second capacity rule pinned to that same floor. Both agreed with the real rule only
 * because nothing could set a non-`STANDARD` policy before I2.
 */
function oversellProduct(
  sellableStock: number,
  overrides: Partial<StorefrontCartProduct> = {},
): StorefrontCartProduct {
  return {
    slug: "oversell-product",
    pancakeProductId: "pancake-oversell",
    name: "Oversell Coat",
    isPresent: true,
    isActive: true,
    sellingPolicy: { sellingMode: "OVERSELL", negativeStockLimit: -20 },
    variants: [
      {
        id: "oversell-variant",
        pancakeVariationId: "pancake-oversell-variant",
        isPresent: true,
        isActive: true,
        color: "Den",
        size: "M",
        sellableStock,
        retailPrice: 500_000,
        retailPriceAfterDiscount: 500_000,
      },
    ],
    ...overrides,
  };
}

test("I5 the cart honours an OVERSELL allowance instead of STANDARD's floor", () => {
  // Stock 0 at a −20 allowance. Under the old rule this line was unbuyable, while the PDP has
  // offered it since I4 — one product, two answers.
  const [line] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 1 }],
    products: [oversellProduct(0)],
  });
  assert.equal(line?.available, true);
  assert.equal(line?.unavailableReason, null);

  // The default is unchanged for a product with no stored policy: STANDARD is floored at 0 whatever
  // the limit says, so this direction proves the policy is read rather than ignored.
  const [standardLine] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 1 }],
    products: [oversellProduct(0, { sellingPolicy: undefined })],
  });
  assert.equal(standardLine?.available, false);
  assert.equal(standardLine?.unavailableReason, "OUT_OF_STOCK");
});

test("I5 the requested quantity is judged by the capacity rule, not by sellableStock alone", () => {
  // Stock 2, allowance −20: 5 units land at −3, which the owner allowed. `sellableStock < quantity`
  // refused this, and it was the only thing standing between the cart and the PDP agreeing.
  const [line] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 5 }],
    products: [oversellProduct(2)],
  });
  assert.equal(line?.available, true);

  // The limit is still a limit. 23 units from stock 2 lands at −21, one past the floor, and the
  // line is refused as INSUFFICIENT_STOCK rather than sold-out: one unit still sells, so the
  // shopper can buy fewer and the message has to say which problem they have.
  const [overLimit] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 23 }],
    products: [oversellProduct(2)],
  });
  assert.equal(overLimit?.available, false);
  assert.equal(overLimit?.unavailableReason, "INSUFFICIENT_STOCK");

  // Exactly at the floor is allowed — the unit that *lands on* −20 is the last one sold, which is
  // the boundary I4 pinned on the PDP and the same one applies here.
  const [atLimit] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 22 }],
    products: [oversellProduct(2)],
  });
  assert.equal(atLimit?.available, true);

  // STANDARD keeps its old behaviour exactly: stock 2, 3 requested, not enough.
  const [standardOver] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 3 }],
    products: [oversellProduct(2, { sellingPolicy: undefined })],
  });
  assert.equal(standardOver?.available, false);
  assert.equal(standardOver?.unavailableReason, "INSUFFICIENT_STOCK");
});

test("I5 a composite parent is refused an OVERSELL allowance in the cart too", () => {
  // ADR §11. I2 refuses to store this and I4 keeps it off the PDP; the cart must not be the one
  // surface that still offers it, or the commit boundary would refuse what the cart accepted.
  const [line] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 1 }],
    products: [oversellProduct(0, { isComposite: true })],
  });
  assert.equal(line?.available, false);
  assert.equal(line?.unavailableReason, "OUT_OF_STOCK");

  // A composite in STANDARD at positive stock is untouched, so this cannot rot into "composites
  // never sell from the cart".
  const [stocked] = buildStorefrontCartLines({
    items: [{ variantId: "oversell-variant", quantity: 1 }],
    products: [oversellProduct(3, { isComposite: true, sellingPolicy: undefined })],
  });
  assert.equal(stocked?.available, true);
});
