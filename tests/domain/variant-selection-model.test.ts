import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveMobilePurchasePresentation,
  resolveSelectionAfterSizeChange,
  resolveVariantSelectionView,
} from "../../src/components/headless/variant-selection-model.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";
import {
  fixtureAvailability,
  withFixtureAvailability,
} from "../fixtures/storefront-projection-option.ts";

/**
 * Characterization tests for the purchase panel's money and purchasability decisions, captured
 * before they moved out of `ProductPurchasePanel`.
 *
 * The panel's own hook cannot be unit-tested here -- it needs a React renderer, and it reaches a
 * server action that imports `next/headers`, which this runner cannot load. So the decisions live
 * in a pure module the hook wires up, and that module is what these tests hold to the baseline.
 */

const NBSP = " ";
const vnd = (amount: string): string => `${amount}${NBSP}₫`;

function option({
  availability,
  ...overrides
}: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  const merged = {
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
    isPreorderSale: false,
    unavailableReason: null,
    ...overrides,
  };
  // I9 — derived from what the fixture already says rather than cast away, so an option here can
  // never carry an availability the shipped projection would not produce for it.
  return availability === undefined
    ? withFixtureAvailability(merged)
    : { ...merged, availability };
}

/* ------------------------------------------------------------------ price label */

test("with nothing selected the panel shows the product-level range", () => {
  const options = [
    option({ id: "a", size: "S", price: 100_000 }),
    option({ id: "b", size: "M", price: 150_000 }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.priceLabel, `Từ ${vnd("100.000")}`);
  assert.equal(view.showsDiscount, false);
});

test("selecting a variant switches the label to that variant's exact price", () => {
  const options = [
    option({ id: "a", size: "S", price: 100_000 }),
    option({ id: "b", size: "M", price: 150_000 }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "M" },
  });

  assert.equal(view.priceLabel, vnd("150.000"));
  assert.equal(view.canAdd, true);
  assert.equal(view.selectedVariantId, "b");
});

test("a product with no resolvable price keeps the baseline placeholder", () => {
  const options = [option({ price: null, purchasable: false, unavailableReason: "PRICE_UNRESOLVED" })];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.priceLabel, "Giá đang cập nhật");
});

/* --------------------------------------------------------------------- discount */

test("a selected discounted variant shows the struck-through base price", () => {
  const options = [
    option({ id: "a", size: "S", price: 89_000, basePriceVnd: 150_000, isDiscounted: true }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "S" },
  });

  assert.equal(view.showsDiscount, true);
  assert.equal(view.priceLabel, vnd("89.000"));
  assert.equal(view.compareAtText, vnd("150.000"));
});

test("a discount flag with no cheaper base price does not strike anything through", () => {
  // The baseline requires base > price, not merely the discounted flag. Without that guard a
  // campaign that left the base equal would render a strike-through over the same amount.
  const options = [
    option({ id: "a", size: "S", price: 100_000, basePriceVnd: 100_000, isDiscounted: true }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "S" },
  });

  assert.equal(view.showsDiscount, false);
  assert.equal(view.compareAtText, null);
});

test("before selection the panel offers the product-level sale presentation", () => {
  const options = [
    option({ id: "a", size: "S", price: 89_000, basePriceVnd: 150_000, isDiscounted: true }),
    option({ id: "b", size: "M", price: 150_000 }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.initialDiscount?.effectivePriceVnd, 89_000);
  assert.equal(view.initialDiscount?.basePriceVnd, 150_000);
});

/* ---------------------------------------------------------- purchasability copy */

test("an out-of-stock selection says so, and any other blocker uses the generic wording", () => {
  const outOfStock = [
    option({ id: "a", size: "S", purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
  ];
  const ambiguous = [
    option({ id: "a", size: "S", purchasable: false, unavailableReason: "AMBIGUOUS_OPTION" }),
  ];

  assert.equal(
    resolveVariantSelectionView({
      options: outOfStock,
      productLevelOptions: outOfStock,
      selection: { kindKey: null, color: null, size: "S" },
    }).unavailableMessage,
    "Lựa chọn này đã hết hàng.",
  );

  assert.equal(
    resolveVariantSelectionView({
      options: ambiguous,
      productLevelOptions: ambiguous,
      selection: { kindKey: null, color: null, size: "S" },
    }).unavailableMessage,
    "Lựa chọn này hiện chưa mua được.",
  );
});

test("no message is shown before anything is selected", () => {
  const options = [option({ id: "a", size: "S", purchasable: false, unavailableReason: "OUT_OF_STOCK" })];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.unavailableMessage, "");
});

test("a product with nothing purchasable is reported as such", () => {
  const options = [
    option({ id: "a", size: "S", purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
    option({ id: "b", size: "M", purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.hasPurchasableVariant, false);
  assert.equal(view.canAdd, false);
});

/* ------------------------------------------------------------------ entry price */

test("the entry price is the lowest resolvable price, for the ViewContent pixel", () => {
  const options = [
    option({ id: "a", size: "S", price: 150_000 }),
    option({ id: "b", size: "M", price: 100_000 }),
    option({ id: "c", size: "L", price: null, purchasable: false }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.entryPrice, 100_000);
});

test("a product with no resolvable price reports no entry price rather than zero", () => {
  const options = [option({ price: null, purchasable: false })];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  assert.equal(view.entryPrice, null);
});

/* ------------------------------------------------- selection transition on size */

test("choosing a size clears only a colour the projection marks disabled", () => {
  // Characterized, not designed. The rule is narrower than it looks: the colour is dropped only
  // when it appears in the projection's colour list as `disabled`. A colour that simply does not
  // come in the new size is left selected, and the selection then resolves to no variant -- the
  // shopper sees no price and must choose again.
  //
  // That is today's behaviour and this task preserves it. Whether it should instead clear the
  // colour is a UX question for a later phase, recorded in the Phase D notes rather than changed
  // under cover of a refactor.
  const options = [
    option({ id: "a", color: "Đen", size: "S" }),
    option({ id: "b", color: "Trắng", size: "M" }),
  ];

  const next = resolveSelectionAfterSizeChange({
    options,
    selection: { kindKey: null, color: "Đen", size: null },
    size: "M",
  });

  assert.deepEqual(next, { kindKey: null, color: "Đen", size: "M" });

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: next,
  });
  assert.equal(view.selectedVariantId, null, "the kept colour resolves to no variant");
  assert.equal(view.canAdd, false);
});

test("choosing a size keeps a colour that size still comes in", () => {
  const options = [
    option({ id: "a", color: "Đen", size: "S" }),
    option({ id: "b", color: "Đen", size: "M" }),
  ];

  const next = resolveSelectionAfterSizeChange({
    options,
    selection: { kindKey: null, color: "Đen", size: null },
    size: "M",
  });

  assert.deepEqual(next, { kindKey: null, color: "Đen", size: "M" });
});

test("choosing a size with no colour selected leaves colour unset", () => {
  const options = [option({ id: "a", color: "Đen", size: "S" })];

  const next = resolveSelectionAfterSizeChange({
    options,
    selection: { kindKey: null, color: null, size: null },
    size: "S",
  });

  assert.deepEqual(next, { kindKey: null, color: null, size: "S" });
});

/* ------------------------------------------------------------------- composite */

test("a composite product distinguishes unresolved kind from genuine stock state", () => {
  const options = [
    option({ id: "set-s", kindKey: "set", kindLabel: "FULL SET", size: "S" }),
    option({ id: "single-s", kindKey: "single", kindLabel: "ÁO LẺ", size: "S" }),
  ];

  const beforeKind = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(
    beforeKind.kindSelectionGuidance,
    "Nàng chọn phân loại trước để xem size còn hàng",
  );
  assert.equal(beforeKind.unavailableMessage, "");

  const afterKind = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: "set", color: null, size: null },
  });
  assert.equal(afterKind.kindSelectionGuidance, null);
});

test("a composite product keeps kind selection independent of size and colour", () => {
  const options = [
    option({ id: "a", kindKey: "set", kindLabel: "Set", size: "S", price: 250_000 }),
    option({ id: "b", kindKey: "single", kindLabel: "Lẻ", size: "S", price: 120_000 }),
  ];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: "set", color: null, size: "S" },
  });

  assert.equal(view.hasKindOptions, true);
  assert.equal(view.priceLabel, vnd("250.000"));
  assert.equal(view.selectedVariantId, "a");
});

/* --------------------------------------------------------------- price display */

test("priceDisplay covers the selected-discount branch", () => {
  const options = [
    option({ id: "a", size: "S", price: 75_000, basePriceVnd: 100_000, isDiscounted: true }),
  ];

  const { priceDisplay } = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "S" },
  });

  assert.deepEqual(priceDisplay, {
    displayText: vnd("75.000"),
    compareAtText: vnd("100.000"),
    discountPercent: 25,
  });
});

test("priceDisplay covers the unselected-but-on-sale branch", () => {
  const options = [
    option({ id: "a", size: "S", price: 75_000, basePriceVnd: 100_000, isDiscounted: true }),
    option({ id: "b", size: "M", price: 60_000 }),
  ];

  const { priceDisplay } = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });

  // A cheaper current variant exists, so the baseline prefixes "Sale từ".
  assert.equal(priceDisplay.displayText, `Sale từ ${vnd("75.000")}`);
  assert.equal(priceDisplay.compareAtText, vnd("100.000"));
  assert.equal(priceDisplay.discountPercent, 25);
});

test("priceDisplay covers the plain branch with nothing struck through", () => {
  const options = [option({ id: "a", size: "S", price: 100_000 })];

  const { priceDisplay } = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "S" },
  });

  assert.deepEqual(priceDisplay, {
    displayText: vnd("100.000"),
    compareAtText: null,
    discountPercent: null,
  });
});

/* ------------------------------------------------- I9 preorder availability date */

/** A preorder option that is sold out but still buyable, with a cycle date of the caller's choosing. */
function preorderOption(id: string, size: string, availabilityDate: string | null) {
  return option({
    id,
    size,
    isPreorderSale: true,
    availability: fixtureAvailability(
      { purchasable: true, isPreorderSale: true, unavailableReason: null },
      { availabilityDate, today: "2026-09-18" },
    ),
  });
}

test("the panel is handed the availability date already written the way a shopper reads it", () => {
  // Google requires the date on the landing page, and the panel is markup a brand rewrites — so it
  // must not be the place that decides how a date is spelled, any more than it decides currency.
  const options = [preorderOption("a", "S", "2026-10-03")];

  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: "S" },
  });

  assert.equal(view.availabilityDateLabel, "03/10/2026");
  // The ISO value survives beside it, because that is what the feed and the JSON-LD publish.
  assert.equal(view.selectedAvailabilityDate, "2026-10-03");
});

test("no size chosen, another size's date, and a lapsed date all render nothing", () => {
  const options = [
    preorderOption("s", "S", "2026-10-03"),
    preorderOption("m", "M", null),
    // Owner rule 8: the cycle lapsed, so the dated promise stops — but the shopper may still buy.
    preorderOption("l", "L", "2026-09-17"),
  ];
  const ask = (size: string | null) =>
    resolveVariantSelectionView({
      options,
      productLevelOptions: options,
      selection: { kindKey: null, color: null, size },
    });

  assert.equal(ask(null).availabilityDateLabel, null, "nothing before a size is chosen");
  assert.equal(ask("M").availabilityDateLabel, null, "never the S date on the M option");
  assert.equal(ask("L").availabilityDateLabel, null, "nothing once the cycle has lapsed");
  assert.equal(ask("L").canAdd, true, "and Đặt trước survives the date lapsing");
  assert.equal(ask("S").availabilityDateLabel, "03/10/2026", "and the real one still shows");
});


/* --------------------------------------------------------- mobile sticky/sheet presentation */

test("mobile incomplete CTA names only dimensions the product actually has", () => {
  const sizeOnly = resolveVariantSelectionView({
    options: [option({ size: "S", color: null })],
    productLevelOptions: [option({ size: "S", color: null })],
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(
    resolveMobilePurchasePresentation(sizeOnly, { kindKey: null, color: null, size: null }).actionLabel,
    "Chọn size",
  );

  const colorSizeOptions = [
    option({ id: "black-s", color: "Đen", size: "S" }),
    option({ id: "white-s", color: "Trắng", size: "S" }),
  ];
  const colorSize = resolveVariantSelectionView({
    options: colorSizeOptions,
    productLevelOptions: colorSizeOptions,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(
    resolveMobilePurchasePresentation(colorSize, { kindKey: null, color: null, size: null }).actionLabel,
    "Chọn màu / size",
  );

  const kindSizeOptions = [
    option({ id: "set-s", kindKey: "set", kindLabel: "Nguyên bộ", color: null, size: "S" }),
    option({ id: "top-s", kindKey: "top", kindLabel: "Áo lẻ", color: null, size: "S" }),
  ];
  const kindSize = resolveVariantSelectionView({
    options: kindSizeOptions,
    productLevelOptions: kindSizeOptions,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(
    resolveMobilePurchasePresentation(kindSize, { kindKey: null, color: null, size: null }).actionLabel,
    "Chọn phân loại / size",
  );
});

test("mobile complete summary follows kind, color, size and ready action becomes add-to-cart", () => {
  const options = [
    option({
      id: "set-white-m",
      kindKey: "set",
      kindLabel: "Nguyên bộ",
      color: "Trắng",
      size: "M",
    }),
  ];
  const selection = { kindKey: "set", color: "Trắng", size: "M" } as const;
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection,
  });

  assert.deepEqual(resolveMobilePurchasePresentation(view, selection), {
    actionLabel: "Thêm vào giỏ",
    summary: "Nguyên bộ · Trắng · M",
    readyToAdd: true,
  });
});

test("genuine selected stock failure uses the buyer-safe mobile wording", () => {
  const options = [
    option({
      id: "sold-out",
      color: "Đen",
      size: "M",
      purchasable: false,
      unavailableReason: "OUT_OF_STOCK",
    }),
  ];
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: "Đen", size: "M" },
  });

  assert.equal(view.unavailableMessage, "Lựa chọn này tạm hết");
});
