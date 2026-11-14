import assert from "node:assert/strict";
import test from "node:test";

import { ENGLISH_DISPLAY_CURRENCY } from "../../src/brand/currency.config.ts";
import { formatUsdFromVnd, vndTextToUsd } from "../../src/i18n/money.ts";
import { createTranslator } from "../../src/i18n/translate.ts";

const NBSP = " ";

test("the display rate is 26,000 dong to the dollar", () => {
  assert.equal(ENGLISH_DISPLAY_CURRENCY.code, "USD");
  assert.equal(ENGLISH_DISPLAY_CURRENCY.vndPerUsd, 26_000);
});

test("a dong amount, as the view models write it, becomes dollars", () => {
  assert.equal(vndTextToUsd(`1.290.000${NBSP}₫`), "$49.62");
  assert.equal(vndTextToUsd("1.290.000 ₫"), "$49.62");
  assert.equal(vndTextToUsd("1.200.000₫"), "$46.15");
  assert.equal(vndTextToUsd("26.000 ₫"), "$1.00");
  assert.equal(vndTextToUsd("0 ₫"), "$0.00");
  // Thousands separator in dollars, as English writes it.
  assert.equal(vndTextToUsd("78.000.000 ₫"), "$3,000.00");
});

test("every amount in a sentence is converted, and the rest of it is left alone", () => {
  assert.equal(vndTextToUsd("2 × 400.000 ₫ = 800.000 ₫"), "2 × $15.38 = $30.77");
  assert.equal(vndTextToUsd("Từ 520.000₫"), "Từ $20.00");
});

test("only an amount written with the dong sign is touched", () => {
  assert.equal(vndTextToUsd("Còn 3 sản phẩm"), "Còn 3 sản phẩm");
  assert.equal(vndTextToUsd("Giảm 15%"), "Giảm 15%");
  assert.equal(vndTextToUsd("Price range (₫)"), "Price range (₫)");
  // `VND` is how text asks to stay in dong: a price-range limit, the amount an order is charged.
  assert.equal(vndTextToUsd("1.620.000 VND"), "1.620.000 VND");
  assert.equal(vndTextToUsd("100.000.000 VND"), "100.000.000 VND");
});

test("formatUsdFromVnd uses the one fixed rate", () => {
  assert.equal(formatUsdFromVnd(130_000), "$5.00");
  assert.equal(formatUsdFromVnd(1_190_000), "$45.77");
});

test("the English translator shows dollars, the Vietnamese one still shows dong", () => {
  const messages = { "Tạm tính: {amount}": "Subtotal: {amount}", "Giá": "Price" };
  const en = createTranslator("en", messages);
  const vi = createTranslator("vi", messages);

  // A sentence whose value arrives already formatted in dong.
  assert.equal(en("Tạm tính: {amount}", { amount: "1.290.000 ₫" }), "Subtotal: $49.62");
  assert.equal(vi("Tạm tính: {amount}", { amount: "1.290.000 ₫" }), "Tạm tính: 1.290.000 ₫");

  // Text with no catalog entry at all, a bare price a view model built.
  assert.equal(en("1.590.000 ₫"), "$61.15");
  assert.equal(vi("1.590.000 ₫"), "1.590.000 ₫");

  // A template made of a slot: a price the view model already filled in.
  const patterned = createTranslator("en", { "Từ {price}": "From {price}" });
  assert.equal(patterned("Từ 1.200.000₫"), "From $46.15");
});
