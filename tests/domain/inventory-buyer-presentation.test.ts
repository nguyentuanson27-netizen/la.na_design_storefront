import assert from "node:assert/strict";
import test from "node:test";

import {
  OUT_OF_STOCK_LABEL,
  PREORDER_LABEL,
} from "../../src/commerce/preorder-fulfillment-presentation.ts";
import { buildStorefrontProductProjection } from "../../src/commerce/storefront-projection.ts";
import type { StorefrontProductCapacity } from "../../src/commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../../src/components/headless/build-product-card-model.ts";
import {
  DEFAULT_ADD_TO_BAG_LABEL,
  PREORDER_ADD_TO_BAG_LABEL,
  resolveVariantSelectionView,
} from "../../src/components/headless/variant-selection-model.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";

/**
 * F8a — what a buyer is told about inventory on the product card and the product page.
 *
 * Every case below is written against a **policy and a stock level**, never against a hand-set
 * `isPreorderSale`. That is the point: the whole feature is the claim that card and PDP reach the
 * same verdict by asking one authority, so a test that injected the verdict would pass against two
 * surfaces that each decided it differently. `preorder-fulfillment-presentation.test.ts` continues
 * the same journey into the cart and checkout.
 *
 * The three selling modes are exercised at three stock levels each — above zero, below zero but
 * above the floor, and at the floor — because that is where §29/§30/§31 differ and where a
 * re-derived threshold in a component would show up.
 */

const FLOOR = -20;

function capacity(
  sellingMode: StorefrontProductCapacity["sellingMode"],
  overrides: Partial<StorefrontProductCapacity> = {},
): StorefrontProductCapacity {
  return { sellingMode, negativeStockLimit: FLOOR, isComposite: false, ...overrides };
}

function variant(
  id: string,
  sellableStock: number,
  overrides: Partial<StorefrontVariantFacts> = {},
): StorefrontVariantFacts {
  return {
    id,
    pancakeVariationId: `pancake-${id}`,
    color: null,
    size: "M",
    sellableStock,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    ...overrides,
  };
}

function card(
  variants: readonly StorefrontVariantFacts[],
  productCapacity: StorefrontProductCapacity,
  overrides: Partial<Parameters<typeof buildProductCardModel>[0]> = {},
): ProductCardModel {
  return buildProductCardModel({
    slug: "test-product",
    name: "Test Product",
    variants,
    productCapacity,
    ...overrides,
  });
}

/** The PDP view for a product, selected down to one option. */
function pdp(
  variants: readonly StorefrontVariantFacts[],
  productCapacity: StorefrontProductCapacity,
  selection: Readonly<{ kindKey: string | null; color: string | null; size: string | null }>,
) {
  const projection = buildStorefrontProductProjection({
    parentVariants: variants,
    componentGroups: [],
    hasCompositeGraph: false,
    sellingPolicy: {
      sellingMode: productCapacity.sellingMode,
      negativeStockLimit: productCapacity.negativeStockLimit,
    },
  });
  return resolveVariantSelectionView({
    options: projection.options,
    productLevelOptions: projection.options,
    selection,
  });
}

const selected = { kindKey: null, color: null, size: "M" } as const;

/* ------------------------------------------------------------------------ F8a: STANDARD */

test("F8a STANDARD with positive stock sells normally and says nothing about availability", () => {
  const model = card([variant("v", 4)], capacity("STANDARD"));

  assert.equal(model.availability, "in-stock");
  assert.equal(model.isPreorderOnly, false);
  assert.equal(model.availabilityLabel, null);

  const view = pdp([variant("v", 4)], capacity("STANDARD"), selected);
  assert.equal(view.canAdd, true);
  assert.equal(view.preorderLabel, null);
  assert.equal(view.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
});

test("F8a STANDARD out of stock stays visible and disabled with the exact out-of-stock words", () => {
  const model = card([variant("v", 0)], capacity("STANDARD"));

  assert.equal(model.availability, "out-of-stock");
  assert.equal(model.availabilityLabel, OUT_OF_STOCK_LABEL);
  assert.equal(model.availabilityLabel, "Hết hàng");

  const view = pdp([variant("v", 0)], capacity("STANDARD"), selected);
  // Visible: the option is still offered in the size list rather than removed from it.
  assert.deepEqual(
    view.sizes.map((size) => size.value),
    ["M"],
  );
  // Disabled: the shopper may address it, but cannot buy it.
  assert.equal(view.canAdd, false);
  assert.equal(view.selectedUnavailableReason, "OUT_OF_STOCK");
  assert.equal(view.preorderLabel, null);
});

/* ------------------------------------------------------------------------ F8a: OVERSELL */

test("F8a OVERSELL below zero but above the floor looks exactly like ordinary ready stock", () => {
  const model = card([variant("v", -5)], capacity("OVERSELL"));

  assert.equal(model.availability, "in-stock", "an allowed oversell unit is not sold out");
  assert.equal(model.isPreorderOnly, false, "§31: oversell is never preorder");
  assert.equal(model.availabilityLabel, null, "no badge, no special wording");

  const view = pdp([variant("v", -5)], capacity("OVERSELL"), selected);
  assert.equal(view.canAdd, true);
  assert.equal(view.preorderLabel, null);
  assert.equal(view.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
});

test("F8a OVERSELL exposes no negative quantity to the buyer surface", () => {
  const view = pdp([variant("v", -5)], capacity("OVERSELL"), selected);

  // The whole rendered view is searched, not one field: a leak would most likely arrive as a new
  // field nobody thought to assert on.
  assert.ok(
    !JSON.stringify(view).includes("-5"),
    "a buyer projection must never carry the internal negative quantity",
  );
});

test("F8a OVERSELL at the hard floor is visible, disabled and out of stock", () => {
  const model = card([variant("v", FLOOR)], capacity("OVERSELL"));

  assert.equal(model.availability, "out-of-stock");
  assert.equal(model.availabilityLabel, OUT_OF_STOCK_LABEL);

  const view = pdp([variant("v", FLOOR)], capacity("OVERSELL"), selected);
  assert.deepEqual(
    view.sizes.map((size) => size.value),
    ["M"],
  );
  assert.equal(view.canAdd, false);
  assert.equal(view.preorderLabel, null);
});

/* ------------------------------------------------------------------------ F8a: PREORDER */

test("F8a PREORDER with ready stock sells normally and shows no preorder state", () => {
  const model = card([variant("v", 3)], capacity("PREORDER"));

  assert.equal(model.availability, "in-stock");
  assert.equal(model.isPreorderOnly, false, "§30: stock > 0 means sell normally");
  assert.equal(model.availabilityLabel, null);

  const view = pdp([variant("v", 3)], capacity("PREORDER"), selected);
  assert.equal(view.canAdd, true);
  assert.equal(view.preorderLabel, null);
  assert.equal(view.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
});

test("F8a PREORDER depleted but above the floor is purchasable and labelled Đặt trước", () => {
  const model = card([variant("v", 0)], capacity("PREORDER"));

  assert.equal(model.availability, "in-stock", "still purchasable, so not sold out");
  assert.equal(model.isPreorderOnly, true);
  assert.equal(model.availabilityLabel, PREORDER_LABEL);
  assert.equal(model.availabilityLabel, "Đặt trước");

  const view = pdp([variant("v", -1)], capacity("PREORDER"), selected);
  assert.equal(view.canAdd, true, "a preorder sale is a sale");
  assert.equal(view.preorderLabel, "Đặt trước");
  assert.equal(
    view.addToBagLabel,
    PREORDER_ADD_TO_BAG_LABEL,
    "§30: the CTA itself must communicate preorder semantics",
  );
  assert.notEqual(view.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
  assert.ok(
    view.addToBagAccessibleName.includes(PREORDER_LABEL),
    "the accessible name must carry the state too, not only the visible word",
  );
});

test("F8a PREORDER at the hard floor is visible, disabled and out of stock, not Đặt trước", () => {
  const model = card([variant("v", FLOOR)], capacity("PREORDER"));

  assert.equal(model.availability, "out-of-stock");
  assert.equal(model.isPreorderOnly, false);
  assert.equal(model.availabilityLabel, OUT_OF_STOCK_LABEL);

  const view = pdp([variant("v", FLOOR)], capacity("PREORDER"), selected);
  assert.deepEqual(
    view.sizes.map((size) => size.value),
    ["M"],
  );
  assert.equal(view.canAdd, false);
  assert.equal(view.preorderLabel, null, "a variant nobody can buy is not on preorder");
});

/* -------------------------------------------------------------- F8a: badge coexistence */

test("F8a a Sale badge and the preorder state occupy different slots and both survive", () => {
  // The highest marketing priority, on a depleted PREORDER variant. §30 forbids
  // Sale > Hàng mới > Bán chạy hiding availability, so both facts must come back set.
  const onSale = () => ({ price: 400_000, basePriceVnd: 500_000, isDiscounted: true });
  const model = card([variant("v", 0)], capacity("PREORDER"), { pricingRule: onSale });

  assert.equal(model.marketingBadge?.type, "sale");
  assert.equal(model.marketingBadge?.label, "-20%");
  assert.equal(model.availabilityLabel, PREORDER_LABEL);
  assert.equal(model.isPreorderOnly, true);
});

test("F8a a Hàng mới badge likewise coexists with the preorder state", () => {
  const model = card([variant("v", 0)], capacity("PREORDER"), { isNewArrival: true });

  assert.equal(model.marketingBadge?.type, "new");
  assert.equal(model.availabilityLabel, PREORDER_LABEL);
});

test("F8a the marketing priority itself is untouched by F8a", () => {
  const onSale = () => ({ price: 400_000, basePriceVnd: 500_000, isDiscounted: true });
  const saleAndNew = card([variant("v", 0)], capacity("PREORDER"), {
    pricingRule: onSale,
    isNewArrival: true,
    isBestseller: true,
  });
  const newAndBestseller = card([variant("v", 0)], capacity("PREORDER"), {
    isNewArrival: true,
    isBestseller: true,
  });

  assert.equal(saleAndNew.marketingBadge?.type, "sale", "Sale still outranks Hàng mới");
  assert.equal(newAndBestseller.marketingBadge?.type, "new", "Hàng mới still outranks Bán chạy");
});

test("F8a a product with one ready variant is not a preorder product, even beside a depleted one", () => {
  const model = card([variant("ready", 5), variant("depleted", 0, { size: "L" })], capacity("PREORDER"));

  assert.equal(model.availability, "in-stock", "both are purchasable under PREORDER");
  assert.equal(
    model.isPreorderOnly,
    false,
    "the shopper can still buy the ready variant, so the card must not claim preorder",
  );
  assert.equal(model.availabilityLabel, null);
});

/* --------------------------------------------------------- F8a: switching and deep links */

test("F8a switching variants moves the state with the selection and leaks nothing forward", () => {
  const variants = [
    variant("ready", 5, { size: "S" }),
    variant("preorder", 0, { size: "M" }),
    variant("floored", FLOOR, { size: "L" }),
  ];
  const policy = capacity("PREORDER");

  const onReady = pdp(variants, policy, { kindKey: null, color: null, size: "S" });
  assert.equal(onReady.preorderLabel, null);
  assert.equal(onReady.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
  assert.equal(onReady.canAdd, true);

  const onPreorder = pdp(variants, policy, { kindKey: null, color: null, size: "M" });
  assert.equal(onPreorder.preorderLabel, PREORDER_LABEL);
  assert.equal(onPreorder.addToBagLabel, PREORDER_ADD_TO_BAG_LABEL);
  assert.equal(onPreorder.canAdd, true);

  const onFloored = pdp(variants, policy, { kindKey: null, color: null, size: "L" });
  assert.equal(onFloored.preorderLabel, null, "the previous variant's preorder state must not stick");
  assert.equal(onFloored.addToBagLabel, DEFAULT_ADD_TO_BAG_LABEL);
  assert.equal(onFloored.canAdd, false, "a floored variant keeps no stale purchasable CTA");
  assert.equal(onFloored.selectedUnavailableReason, "OUT_OF_STOCK");
});

test("F8a a deep-linked variant renders its own state rather than the product's first", () => {
  const variants = [
    variant("ready", 5, { size: "S" }),
    variant("preorder", -3, { size: "M" }),
  ];
  // A deep link is an initial selection; the view is resolved from it exactly as a click would be.
  const deepLinked = pdp(variants, capacity("PREORDER"), { kindKey: null, color: null, size: "M" });

  assert.equal(deepLinked.preorderLabel, PREORDER_LABEL);
  assert.equal(deepLinked.addToBagLabel, PREORDER_ADD_TO_BAG_LABEL);
});

/* ------------------------------------------------------------------------ F8a: composite */

test("F8a a composite parent is never a preorder sale, whatever policy the operator set", () => {
  // ADR 0014 §11 disables OVERSELL/PREORDER for a composite. The card must agree with the
  // reservation boundary rather than advertise a state the commit would refuse.
  const model = card([variant("v", 0)], capacity("PREORDER", { isComposite: true }));

  assert.equal(model.isPreorderOnly, false);
  assert.equal(model.availability, "out-of-stock");
  assert.equal(model.availabilityLabel, OUT_OF_STOCK_LABEL);
});
