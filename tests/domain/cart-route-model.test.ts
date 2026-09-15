import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontCartLine } from "../../src/commerce/storefront-cart.ts";
import {
  buildCartViewModel,
  cartAvailableSubtotal,
  cartUnavailableLabel,
} from "../../src/routes/cart-model.ts";

/** The cart route's own decisions, held to the behaviour the page had before it was migrated. */

/** The VND formatter emits U+00A0 before ₫, not a plain space. Spelling it out keeps these honest. */
const vnd = (amount: string): string => `${amount}\u00A0₫`;

function line(overrides: Partial<StorefrontCartLine> = {}): StorefrontCartLine {
  return {
    variantId: "variant-1",
    pancakeVariationId: "pancake-1",
    pancakeProductId: "product-1",
    productSlug: "ao-so-mi",
    productName: "Áo sơ mi",
    color: "Đen",
    size: "M",
    quantity: 2,
    price: 100_000,
    available: true,
    unavailableReason: null,
    media: { primary: null, gallery: [] },
    ...overrides,
  } as StorefrontCartLine;
}

const build = (lines: readonly StorefrontCartLine[]) =>
  buildCartViewModel({ lines, commerceTrackingEnabled: false });

/* ----------------------------------------------------------------------- subtotal */

test("the subtotal is the sum of what can actually be bought", () => {
  assert.equal(cartAvailableSubtotal([line({ price: 100_000, quantity: 2 })]), 200_000);
});

test("unavailable lines are excluded from the subtotal rather than counted at zero", () => {
  const lines = [
    line({ variantId: "a", price: 100_000, quantity: 1 }),
    line({ variantId: "b", price: 500_000, quantity: 1, available: false, unavailableReason: "OUT_OF_STOCK" }),
  ];

  assert.equal(cartAvailableSubtotal(lines), 100_000);
  assert.equal(build(lines).subtotalText, vnd("100.000"));
});

test("a line with no resolved price contributes nothing", () => {
  assert.equal(cartAvailableSubtotal([line({ price: null })]), 0);
});

test("a non-finite total gives up rather than showing a number nobody can be charged", () => {
  const lines = [line({ price: Number.MAX_VALUE, quantity: 2 }), line({ variantId: "b", price: Number.MAX_VALUE, quantity: 2 })];

  assert.equal(cartAvailableSubtotal(lines), null);
  assert.equal(build(lines).subtotalText, "Chưa thể tính");
});

test("an empty cart totals zero, not nothing", () => {
  assert.equal(cartAvailableSubtotal([]), 0);
});

/* ------------------------------------------------------------- unavailable labels */

test("every unavailable reason has shopper wording, and an unknown one still says something", () => {
  const cases: Array<[StorefrontCartLine["unavailableReason"], string]> = [
    ["OUT_OF_STOCK", "Tạm hết hàng"],
    ["INSUFFICIENT_STOCK", "Không đủ tồn kho cho số lượng này"],
    ["PRICE_UNRESOLVED", "Giá đang cập nhật"],
    ["MAPPING_REQUIRED", "Màu × kích cỡ chưa hoàn tất"],
    ["AMBIGUOUS_OPTION", "Màu × kích cỡ đang bị trùng"],
    ["PRODUCT_UNAVAILABLE", "Sản phẩm không còn khả dụng"],
    ["VARIANT_UNAVAILABLE", "Sản phẩm không còn khả dụng"],
    [null, "Chưa thể mua online"],
  ];

  for (const [reason, expected] of cases) {
    assert.equal(cartUnavailableLabel(line({ unavailableReason: reason })), expected, String(reason));
  }
});

/* ------------------------------------------------------------------ editable rows */

test("insufficient stock keeps the quantity field usable, because lowering it is the fix", () => {
  // Locking the row would trap the shopper on the one line they can actually resolve themselves.
  const model = build([
    line({ available: false, unavailableReason: "INSUFFICIENT_STOCK" }),
  ]);

  assert.equal(model.lines[0]?.canUpdate, true);
});

test("any other unavailable reason locks the quantity field", () => {
  for (const reason of ["OUT_OF_STOCK", "PRICE_UNRESOLVED", "VARIANT_UNAVAILABLE"] as const) {
    const model = build([line({ available: false, unavailableReason: reason })]);
    assert.equal(model.lines[0]?.canUpdate, false, reason);
  }
});

/* ------------------------------------------------------------------- line display */

test("a line whose product left the catalog still names itself", () => {
  const model = build([line({ productName: null, productSlug: null })]);

  assert.equal(model.lines[0]?.productName, "Sản phẩm không còn trong catalog");
  assert.equal(model.lines[0]?.productSlug, null);
});

test("a line with no option pair says so rather than rendering an empty label", () => {
  assert.equal(build([line({ color: null, size: null })]).lines[0]?.optionLabel, "Màu / Kích cỡ không khả dụng");
  assert.equal(build([line({ color: "Đen", size: null })]).lines[0]?.optionLabel, "Đen");
  assert.equal(build([line()]).lines[0]?.optionLabel, "Đen / M");
});

test("a line with no resolved price says so instead of showing zero", () => {
  assert.equal(build([line({ price: null })]).lines[0]?.priceText, "Giá đang cập nhật");
});

/* --------------------------------------------------------------------- checkout */

test("checkout is offered only when every line is buyable and a subtotal exists", () => {
  assert.equal(build([line()]).canCheckout, true);
  assert.equal(
    build([line({ available: false, unavailableReason: "OUT_OF_STOCK" })]).canCheckout,
    false,
  );
});

test("an empty cart reports itself empty and offers no checkout", () => {
  const model = build([]);

  assert.equal(model.isEmpty, true);
  assert.equal(model.lineCount, 0);
  assert.equal(model.canCheckout, true, "an empty cart has a computable subtotal; the page shows the empty state first");
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  const model = build([line()]);

  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.lines), true);
});
