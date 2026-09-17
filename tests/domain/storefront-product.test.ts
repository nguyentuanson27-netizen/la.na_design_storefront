import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontVariantOptions,
  resolveVariantAvailabilityFromWarehouseStocks,
  getStorefrontResolvedPriceRange,
  resolveStorefrontPrice,
  toOptionIdentityKey,
} from "../../src/commerce/storefront-product.ts";

test("storefront price resolves only when mirrored raw price fields agree", () => {
  assert.equal(
    resolveStorefrontPrice({ retailPrice: 590_000, retailPriceAfterDiscount: 590_000 }),
    590_000,
  );
  assert.equal(
    resolveStorefrontPrice({ retailPrice: 590_000, retailPriceAfterDiscount: 490_000 }),
    null,
  );
  assert.equal(
    resolveStorefrontPrice({ retailPrice: 590_000, retailPriceAfterDiscount: null }),
    null,
  );
  assert.equal(
    resolveStorefrontPrice({ retailPrice: Number.NaN, retailPriceAfterDiscount: Number.NaN }),
    null,
  );
});

test("storefront variants fail closed on required size, stock, price, and duplicate Color x Size pairs", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "available",
      pancakeVariationId: "pancake-available",
      color: "Black",
      size: "M",
      sellableStock: 3,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "sold-out",
      pancakeVariationId: "pancake-sold-out",
      color: "Black",
      size: "L",
      sellableStock: 0,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "unresolved-price",
      pancakeVariationId: "pancake-unresolved-price",
      color: "Stone",
      size: "M",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 490_000,
    },
    {
      id: "missing-size",
      pancakeVariationId: "pancake-missing-size",
      color: "Olive",
      size: null,
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "duplicate-a",
      pancakeVariationId: "pancake-duplicate-a",
      color: "Navy",
      size: "XL",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "duplicate-b",
      pancakeVariationId: "pancake-duplicate-b",
      color: "Navy",
      size: "XL",
      sellableStock: 1,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  const byId = new Map(options.map((option) => [option.id, option]));
  assert.equal(byId.get("available")?.purchasable, true);
  assert.equal(byId.get("available")?.unavailableReason, null);
  assert.equal(byId.get("sold-out")?.unavailableReason, "OUT_OF_STOCK");
  assert.equal(byId.get("unresolved-price")?.unavailableReason, "PRICE_UNRESOLVED");
  assert.equal(byId.get("missing-size")?.unavailableReason, "MAPPING_REQUIRED");
  assert.equal(byId.get("duplicate-a")?.unavailableReason, "AMBIGUOUS_OPTION");
  assert.equal(byId.get("duplicate-b")?.unavailableReason, "AMBIGUOUS_OPTION");
});

test("storefront variants allow size-only products when no variant has a color", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "size-only-m",
      pancakeVariationId: "pancake-size-only-m",
      color: null,
      size: "M",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "size-only-l",
      pancakeVariationId: "pancake-size-only-l",
      color: null,
      size: "L",
      sellableStock: 1,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  assert.deepEqual(
    options.map(({ id, purchasable, unavailableReason }) => ({ id, purchasable, unavailableReason })),
    [
      { id: "size-only-m", purchasable: true, unavailableReason: null },
      { id: "size-only-l", purchasable: true, unavailableReason: null },
    ],
  );
});

test("storefront variants require color consistently when the product has a color dimension", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "black-m",
      pancakeVariationId: "pancake-black-m",
      color: "Black",
      size: "M",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "missing-color-l",
      pancakeVariationId: "pancake-missing-color-l",
      color: null,
      size: "L",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  assert.equal(options[0]?.purchasable, true);
  assert.equal(options[1]?.unavailableReason, "MAPPING_REQUIRED");
});

test("storefront size-only variants fail closed on duplicate sizes", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "duplicate-size-a",
      pancakeVariationId: "pancake-duplicate-size-a",
      color: null,
      size: "M",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "duplicate-size-b",
      pancakeVariationId: "pancake-duplicate-size-b",
      color: null,
      size: "M",
      sellableStock: 1,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  assert.equal(options[0]?.unavailableReason, "AMBIGUOUS_OPTION");
  assert.equal(options[1]?.unavailableReason, "AMBIGUOUS_OPTION");
});

/**
 * Case is not what tells two options apart, so a catalog that spells one option two ways is still
 * one ambiguous option rather than two buyable ones. Pinned here, in the model that owns the rule:
 * `toOptionIdentityKey` is exported and reused by consumers asking "do these actually differ?", so
 * the rule needs a regression of its own rather than only a downstream one.
 */
test("storefront options that differ only in letter case are the same option, not two", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "cased-a",
      pancakeVariationId: "pancake-cased-a",
      color: "Đen",
      size: "M",
      sellableStock: 2,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "cased-b",
      pancakeVariationId: "pancake-cased-b",
      color: "đen",
      size: "m",
      sellableStock: 3,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
  ]);

  assert.equal(options[0]?.unavailableReason, "AMBIGUOUS_OPTION");
  assert.equal(options[1]?.unavailableReason, "AMBIGUOUS_OPTION");
  assert.equal(toOptionIdentityKey("Đen"), toOptionIdentityKey("đen"));
});

test("storefront price range keeps resolved sold-out prices separate from purchase availability", () => {
  const options = buildStorefrontVariantOptions([
    {
      id: "sold-out-low",
      pancakeVariationId: "pancake-sold-out-low",
      color: "Black",
      size: "S",
      sellableStock: 0,
      retailPrice: 590_000,
      retailPriceAfterDiscount: 590_000,
    },
    {
      id: "available-high",
      pancakeVariationId: "pancake-available-high",
      color: "Stone",
      size: "M",
      sellableStock: 2,
      retailPrice: 620_000,
      retailPriceAfterDiscount: 620_000,
    },
    {
      id: "unresolved",
      pancakeVariationId: "pancake-unresolved",
      color: "Olive",
      size: "L",
      sellableStock: 2,
      retailPrice: 650_000,
      retailPriceAfterDiscount: 600_000,
    },
  ]);

  assert.deepEqual(getStorefrontResolvedPriceRange(options), {
    minimum: 590_000,
    maximum: 620_000,
  });
  assert.equal(options.some((option) => option.purchasable), true);
});

test("U27a mirrored inventory can state an availability only when every row is well formed", () => {
  const resolve = (quantities: readonly number[]) =>
    resolveVariantAvailabilityFromWarehouseStocks(quantities.map((quantity) => ({ quantity })));

  // Well-formed inventory, including the empty and zero cases the storefront already treats as
  // sold out. These stay publishable.
  assert.equal(resolve([]), true);
  assert.equal(resolve([0]), true);
  assert.equal(resolve([5]), true);
  assert.equal(resolve([2, 3]), true);
  assert.equal(resolve([0, 0]), true);

  // The rule is per row, not on the total. Each of these sums to something unremarkable, and each
  // is still unusable: a catalog that reports a negative quantity is not reporting stock.
  assert.equal(resolve([-3]), false, "a negative row is never a stock fact");
  assert.equal(resolve([5, -3]), false, "a total of 2 built from a malformed row is still unusable");
  assert.equal(resolve([3, -3]), false, "a zero total does not repair the rows that produced it");
  assert.equal(resolve([100, -1]), false, "one bad row spoils the variant, however small");

  // Non-finite rows are refused here too. The PDP repository already throws on them before a
  // projection exists, so this is defence in depth rather than the live path.
  assert.equal(resolve([Number.NaN]), false);
  assert.equal(resolve([Number.POSITIVE_INFINITY]), false);
  assert.equal(resolve([Number.NEGATIVE_INFINITY]), false);
  assert.equal(resolve([5, Number.NaN]), false);
});

/**
 * Review 5233519975, Required. `buildStorefrontVariantOptions()` passed `isComposite: false` to the
 * capacity rule unconditionally, so a composite parent would have been offered below zero the moment
 * I2 let an operator set `OVERSELL` — while the commit boundary, using the same rule with the real
 * flag, refused it. That is precisely the display/gate drift I4 exists to remove, reintroduced by a
 * hard-coded argument.
 */
test("a composite parent is unsellable under OVERSELL and PREORDER, and unaffected under STANDARD", () => {
  const parent = [
    {
      id: "set-m",
      pancakeVariationId: "pancake-set-m",
      color: null,
      size: "M",
      sellableStock: -2,
      retailPrice: 790_000,
      retailPriceAfterDiscount: 790_000,
    },
  ];
  const optionFor = (sellingMode: "STANDARD" | "OVERSELL" | "PREORDER", isComposite: boolean) =>
    buildStorefrontVariantOptions(parent, undefined, {
      sellingMode,
      negativeStockLimit: -20,
      isComposite,
    })[0]!;

  // Standalone: the limit does what I4 shipped it to do — −2 is above the −20 floor, so it sells,
  // and PREORDER carries the §30 marker because ready stock is gone.
  assert.equal(optionFor("OVERSELL", false).purchasable, true);
  assert.equal(optionFor("PREORDER", false).purchasable, true);
  assert.equal(optionFor("PREORDER", false).isPreorderSale, true);

  // Composite: refused, at exactly the same stock and limit. The difference is the flag alone.
  assert.equal(optionFor("OVERSELL", true).purchasable, false);
  assert.equal(optionFor("OVERSELL", true).unavailableReason, "OUT_OF_STOCK");
  assert.equal(optionFor("PREORDER", true).purchasable, false);
  assert.equal(
    optionFor("PREORDER", true).isPreorderSale,
    false,
    "a marker on something the shopper cannot add is worse than no marker",
  );

  // STANDARD is untouched by the restriction, which only bites for a non-STANDARD mode. Both
  // directions are asserted so this cannot rot into "composites are never sellable": a composite at
  // positive stock still sells exactly as it did before I4.
  assert.equal(optionFor("STANDARD", true).purchasable, false, "−2 is below STANDARD's floor of 0");
  assert.equal(optionFor("STANDARD", false).purchasable, false);
  const stockedParent = [{ ...parent[0]!, sellableStock: 4 }];
  for (const isComposite of [true, false]) {
    const option = buildStorefrontVariantOptions(stockedParent, undefined, {
      sellingMode: "STANDARD",
      negativeStockLimit: -20,
      isComposite,
    })[0]!;
    assert.equal(option.purchasable, true);
    assert.equal(option.isPreorderSale, false);
  }
});
