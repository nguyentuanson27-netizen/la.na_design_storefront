import assert from "node:assert/strict";
import test from "node:test";

import { ENGLISH_DISPLAY_CURRENCY } from "../../src/brand/currency.config.ts";
import { compactVoucherVnd, spokenVoucherVnd } from "../../src/commerce/voucher-format.ts";
import { formatUsdFromVnd, vndTextToUsd } from "../../src/i18n/money.ts";
import { richValues } from "../../src/i18n/rich-values.ts";
import { formatVoucherVnd } from "../../src/routes/voucher-picker-model.ts";
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

test("the voucher formatters' own spellings are converted: `đ`, `K`, `TR`, `triệu`", () => {
  // The picker's amounts (`formatVoucherVnd`) end in a lowercase đ, not the dong sign.
  assert.equal(formatVoucherVnd(260_000), "260.000đ");
  assert.equal(vndTextToUsd(formatVoucherVnd(260_000)), "$10.00");
  assert.equal(vndTextToUsd(formatVoucherVnd(130_000)), "$5.00");

  // The colour block of a ticket and a threshold read in a sentence.
  assert.equal(compactVoucherVnd(80_000), "80K");
  assert.equal(vndTextToUsd(compactVoucherVnd(80_000)), "$3.08");
  assert.equal(vndTextToUsd(compactVoucherVnd(260_000)), "$10.00");
  assert.equal(compactVoucherVnd(1_500_000), "1,5TR");
  assert.equal(vndTextToUsd(compactVoucherVnd(1_500_000)), "$57.69");
  assert.equal(vndTextToUsd(compactVoucherVnd(999_999)), "$38.46");
  assert.equal(spokenVoucherVnd(1_500_000), "1,5 triệu");
  assert.equal(vndTextToUsd(`Đơn từ ${spokenVoucherVnd(1_500_000)}`), "Đơn từ $57.69");
  assert.equal(vndTextToUsd("Giảm 30.000đ cho đơn từ 600.000đ"), "Giảm $1.15 cho đơn từ $23.08");
});

test("a word that merely starts with đ, a K inside a word, or a bare figure is not an amount", () => {
  assert.equal(vndTextToUsd("3 đơn hàng"), "3 đơn hàng");
  assert.equal(vndTextToUsd("Đã thêm 3/5 quà"), "Đã thêm 3/5 quà");
  assert.equal(vndTextToUsd("Kích cỡ 5K2"), "Kích cỡ 5K2");
  assert.equal(vndTextToUsd("TRACK 12"), "TRACK 12");
});

test("a dong amount handed in as a slot of a rich sentence is converted too", () => {
  const en = createTranslator("en", { "Mua thêm <b>{amount}</b> để dùng voucher": "Add <b>{amount}</b> more to use the voucher" });
  const vi = createTranslator("vi", {});
  assert.deepEqual(richValues(en, { amount: formatVoucherVnd(260_000), name: "KOL" }), { amount: "$10.00", name: "KOL" });
  assert.deepEqual(richValues(vi, { amount: formatVoucherVnd(260_000) }), { amount: "260.000đ" });
  // Nodes are left alone.
  const node = { type: "a" } as never;
  assert.equal(richValues(en, { link: node })?.link, node);
  assert.equal(richValues(en, undefined), undefined);
});
