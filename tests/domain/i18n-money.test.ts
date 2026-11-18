import assert from "node:assert/strict";
import test from "node:test";

import { ENGLISH_DISPLAY_CURRENCY } from "../../src/brand/currency.config.ts";
import { compactVoucherVnd, spokenVoucherVnd } from "../../src/commerce/voucher-format.ts";
import { formatUsdFromVnd, snapToPriceEnding, vndTextToUsd } from "../../src/i18n/money.ts";
import { richValues } from "../../src/i18n/rich-values.ts";
import { formatVoucherVnd } from "../../src/routes/voucher-picker-model.ts";
import { createTranslator } from "../../src/i18n/translate.ts";

const NBSP = " ";

test("the display rate is 20,000 dong to the dollar, shown at .49 and .99 endings", () => {
  assert.equal(ENGLISH_DISPLAY_CURRENCY.code, "USD");
  assert.equal(ENGLISH_DISPLAY_CURRENCY.vndPerUsd, 20_000);
  assert.deepEqual(ENGLISH_DISPLAY_CURRENCY.priceEndingsInCents, [49, 99]);
});

test("a dong amount, as the view models write it, becomes dollars", () => {
  assert.equal(vndTextToUsd(`1.290.000${NBSP}₫`), "$64.49");
  assert.equal(vndTextToUsd("1.290.000 ₫"), "$64.49");
  assert.equal(vndTextToUsd("1.200.000₫"), "$59.99");
  assert.equal(vndTextToUsd("26.000 ₫"), "$1.49");
  assert.equal(vndTextToUsd("0 ₫"), "$0.00");
  // Thousands separator in dollars, as English writes it.
  assert.equal(vndTextToUsd("78.000.000 ₫"), "$3,899.99");
});

test("every amount in a sentence is converted, and the rest of it is left alone", () => {
  assert.equal(vndTextToUsd("2 × 400.000 ₫ = 800.000 ₫"), "2 × $19.99 = $39.99");
  assert.equal(vndTextToUsd("Từ 520.000₫"), "Từ $25.99");
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
  assert.equal(formatUsdFromVnd(130_000), "$6.49");
  assert.equal(formatUsdFromVnd(1_190_000), "$59.49");
});

test("dollar prices end in .49 or .99, whichever is nearer", () => {
  // Cents in, cents out.
  assert.equal(snapToPriceEnding(6_450), 6_449);
  assert.equal(snapToPriceEnding(1_000), 999);
  assert.equal(snapToPriceEnding(1_020), 999);
  assert.equal(snapToPriceEnding(1_030), 1_049);
  assert.equal(snapToPriceEnding(1_026), 1_049);
  assert.equal(snapToPriceEnding(1_074), 1_049, "a tie goes to the lower price");
  assert.equal(snapToPriceEnding(1_075), 1_099);
  assert.equal(snapToPriceEnding(125), 149);
  assert.equal(snapToPriceEnding(100), 99);
  // Free stays free, and a few cents are not inflated to 49.
  assert.equal(snapToPriceEnding(0), 0);
  assert.equal(snapToPriceEnding(5), 5);
  assert.equal(snapToPriceEnding(24), 24);
  assert.equal(snapToPriceEnding(25), 49);
  assert.equal(vndTextToUsd("0 ₫"), "$0.00");
  assert.equal(formatUsdFromVnd(1_000), "$0.05");
  assert.equal(formatUsdFromVnd(10_000), "$0.49");
  // 20,000 dong to the dollar: 500.000 is 25 dollars, shown as the nearer ending.
  assert.equal(formatUsdFromVnd(500_000), "$24.99");
  assert.equal(formatUsdFromVnd(1_290_000), "$64.49");
});

test("the English translator shows dollars, the Vietnamese one still shows dong", () => {
  const messages = { "Tạm tính: {amount}": "Subtotal: {amount}", "Giá": "Price" };
  const en = createTranslator("en", messages);
  const vi = createTranslator("vi", messages);

  // A sentence whose value arrives already formatted in dong.
  assert.equal(en("Tạm tính: {amount}", { amount: "1.290.000 ₫" }), "Subtotal: $64.49");
  assert.equal(vi("Tạm tính: {amount}", { amount: "1.290.000 ₫" }), "Tạm tính: 1.290.000 ₫");

  // Text with no catalog entry at all, a bare price a view model built.
  assert.equal(en("1.590.000 ₫"), "$79.49");
  assert.equal(vi("1.590.000 ₫"), "1.590.000 ₫");

  // A template made of a slot: a price the view model already filled in.
  const patterned = createTranslator("en", { "Từ {price}": "From {price}" });
  assert.equal(patterned("Từ 1.200.000₫"), "From $59.99");
});

test("the voucher formatters' own spellings are converted: `đ`, `K`, `TR`, `triệu`", () => {
  // The picker's amounts (`formatVoucherVnd`) end in a lowercase đ, not the dong sign.
  assert.equal(formatVoucherVnd(260_000), "260.000đ");
  assert.equal(vndTextToUsd(formatVoucherVnd(260_000)), "$12.99");
  assert.equal(vndTextToUsd(formatVoucherVnd(130_000)), "$6.49");

  // The colour block of a ticket and a threshold read in a sentence.
  assert.equal(compactVoucherVnd(80_000), "80K");
  assert.equal(vndTextToUsd(compactVoucherVnd(80_000)), "$3.99");
  assert.equal(vndTextToUsd(compactVoucherVnd(260_000)), "$12.99");
  assert.equal(compactVoucherVnd(1_500_000), "1,5TR");
  assert.equal(vndTextToUsd(compactVoucherVnd(1_500_000)), "$74.99");
  assert.equal(vndTextToUsd(compactVoucherVnd(999_999)), "$49.99");
  assert.equal(spokenVoucherVnd(1_500_000), "1,5 triệu");
  assert.equal(vndTextToUsd(`Đơn từ ${spokenVoucherVnd(1_500_000)}`), "Đơn từ $74.99");
  assert.equal(vndTextToUsd("Giảm 30.000đ cho đơn từ 600.000đ"), "Giảm $1.49 cho đơn từ $29.99");
});

test("a word that merely starts with đ, a K inside a word, or a bare figure is not an amount", () => {
  assert.equal(vndTextToUsd("3 đơn hàng"), "3 đơn hàng");
  assert.equal(vndTextToUsd("Đã thêm 3/5 quà"), "Đã thêm 3/5 quà");
  assert.equal(vndTextToUsd("Kích cỡ 5K2"), "Kích cỡ 5K2");
  assert.equal(vndTextToUsd("TRACK 12"), "TRACK 12");
});

test("K, TR and triệu are money only where the text says so, so Video 4K stays Video 4K", () => {
  // Ordinary text that happens to end in a K or TR.
  for (const text of ["Video 4K", "Size 2K", "Màn hình 4K", "Ảnh 8K", "Model 5TR", "KOL 70K", "Hạng 2 triệu fan", "Phòng 2K"]) {
    assert.equal(vndTextToUsd(text), text, text);
  }
  // The whole text is the figure: a ticket's colour block.
  assert.equal(vndTextToUsd("80K"), "$3.99");
  assert.equal(vndTextToUsd(" 1,5TR "), "$74.99");
  // An amount word right before it.
  assert.equal(vndTextToUsd("Giảm 200K"), "Giảm $9.99");
  assert.equal(vndTextToUsd("Đơn từ 1,5 triệu"), "Đơn từ $74.99");
  assert.equal(vndTextToUsd("Đơn từ 1,5 triệu · tối đa 200K"), "Đơn từ $74.99 · tối đa $9.99");
  assert.equal(vndTextToUsd("Đặt thêm 500K để được hưởng ưu đãi"), "Đặt thêm $24.99 để được hưởng ưu đãi");
  // The word must be a word of its own.
  assert.equal(vndTextToUsd("Giảmgiá 200K"), "Giảmgiá 200K");
});

test("a dong amount handed in as a slot of a rich sentence is converted too", () => {
  const en = createTranslator("en", { "Mua thêm <b>{amount}</b> để dùng voucher": "Add <b>{amount}</b> more to use the voucher" });
  const vi = createTranslator("vi", {});
  assert.deepEqual(richValues(en, { amount: formatVoucherVnd(260_000), name: "KOL" }), { amount: "$12.99", name: "KOL" });
  assert.deepEqual(richValues(vi, { amount: formatVoucherVnd(260_000) }), { amount: "260.000đ" });
  // Nodes are left alone.
  const node = { type: "a" } as never;
  assert.equal(richValues(en, { link: node })?.link, node);
  assert.equal(richValues(en, undefined), undefined);
});
