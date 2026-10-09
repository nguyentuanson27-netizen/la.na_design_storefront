/**
 * Feed -> unselected landing page -> selected variant price parity.
 *
 * Google refuses a feed whose price differs from the page its link opens. The feed row links to the
 * unselected product page, so its price must equal what that page quotes before a size is chosen,
 * and the price of the orderable size the shopper then selects. The scenario is the one a reviewer
 * found: S in stock at 899,000 and M sold out, cheaper, at 849,000.
 *
 * The final leg is the selected variant's price in the purchase panel's model, which is the amount
 * the add-to-cart action submits. It does not drive a real checkout request: that path reaches
 * `next/headers` and cannot be loaded by this runner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildMerchantParentItems } from "../../src/commerce/merchant-parent-feed.ts";
import type { MerchantCandidateProduct } from "../../src/commerce/merchant-offer-mapper.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";
import { resolveVariantSelectionView } from "../../src/components/headless/variant-selection-model.ts";
import { INHERITED_APPAREL_OVERRIDES } from "../../src/commerce/product-merchant-facts-repository.ts";
import { fixtureAvailability, withFixtureAvailability } from "../fixtures/storefront-projection-option.ts";

const ORIGIN = "https://www.lanadesign.vn";
const NBSP = "\u00a0";
const vnd = (amount: string): string => `${amount}${NBSP}₫`;

function option(overrides: Partial<StorefrontProjectionOption>): StorefrontProjectionOption {
  return withFixtureAvailability({
    id: "variant-s",
    pancakeVariationId: "pv-s",
    kindKey: null,
    kindLabel: null,
    color: null,
    size: "S",
    price: 899_000,
    basePriceVnd: null,
    isDiscounted: false,
    purchasable: true,
    isPreorderSale: false,
    unavailableReason: null,
    ...overrides,
  });
}

function product(options: StorefrontProjectionOption[]): MerchantCandidateProduct {
  return {
    pancakeProductId: "prod-1",
    slug: "ao-dai-parity",
    name: "Áo dài parity",
    publishedDescription: "Mô tả",
    media: {
      primary: { url: "https://content.pancake.vn/web-media/a.jpg", alt: "a" },
      gallery: [{ url: "https://content.pancake.vn/web-media/a.jpg", alt: "a" }],
    },
    galleryIndexByVariantId: new Map(),
    projection: { mode: "standalone", options },
    apparelOverrides: INHERITED_APPAREL_OVERRIDES,
    variations: [],
  };
}

function view(options: StorefrontProjectionOption[], size: string | null) {
  return resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size },
  });
}

test("sold-out cheaper size: feed price equals the unselected page and the selected orderable size", () => {
  const options = [
    option({ id: "s", size: "S", price: 899_000, purchasable: true }),
    option({ id: "m", size: "M", price: 849_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
  ];
  const [item] = buildMerchantParentItems([product(options)], ORIGIN);
  assert.equal(item!.priceVnd, 899_000);
  assert.equal(item!.availability, "in_stock");

  // Unselected page: the sold-out 849,000 no longer sets a "Từ" floor.
  assert.equal(view(options, null).priceLabel, vnd("899.000"));
  // Selecting the orderable size shows the same amount.
  assert.equal(view(options, "S").priceLabel, vnd("899.000"));
});

test("several orderable sizes: the page still says 'Từ <cheapest orderable>' and the feed quotes that floor", () => {
  const options = [
    option({ id: "s", size: "S", price: 950_000 }),
    option({ id: "m", size: "M", price: 899_000 }),
    option({ id: "l", size: "L", price: 500_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
  ];
  const [item] = buildMerchantParentItems([product(options)], ORIGIN);
  assert.equal(item!.priceVnd, 899_000);
  assert.equal(view(options, null).priceLabel, `Từ ${vnd("899.000")}`);
});

test("a fully sold-out product keeps its lowest listed price on both feed and page", () => {
  const soldOut = (id: string, size: string, price: number) =>
    option({ id, size, price, purchasable: false, unavailableReason: "OUT_OF_STOCK" });
  const options = [soldOut("s", "S", 900_000), soldOut("m", "M", 850_000)];
  const [item] = buildMerchantParentItems([product(options)], ORIGIN);
  assert.equal(item!.availability, "out_of_stock");
  assert.equal(item!.priceVnd, 850_000);
  assert.equal(view(options, null).priceLabel, `Từ ${vnd("850.000")}`);
});

test("dated preorder sizes: feed and page quote the same cheapest preorder floor", () => {
  const preorder = (id: string, size: string, price: number, date: string) => {
    const base = option({ id, size, price, purchasable: true, isPreorderSale: true });
    return { ...base, availability: fixtureAvailability(base, { availabilityDate: date, today: "2026-10-09" }) };
  };
  const options = [preorder("s", "S", 750_000, "2026-12-04"), preorder("m", "M", 900_000, "2026-11-20")];
  const [item] = buildMerchantParentItems([product(options)], ORIGIN);
  assert.equal(item!.availability, "backorder");
  assert.equal(item!.priceVnd, 750_000);
  assert.equal(view(options, null).priceLabel, `Từ ${vnd("750.000")}`);
});
