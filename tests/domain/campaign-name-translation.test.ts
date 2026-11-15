import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_NAME_LIMITS,
  campaignNameMessages,
  isTranslatableCampaignName,
  normalizeCampaignName,
  parseCampaignNameInput,
} from "../../src/commerce/campaign-name-translation.ts";
import { EN_CLIENT_MESSAGES, EN_MESSAGES } from "../../src/i18n/catalog/en.ts";
import { createTranslator } from "../../src/i18n/translate.ts";

test("a name is normalised the way the campaigns store it", () => {
  // A precomposed and a combining accent are the same Vietnamese.
  assert.equal(normalizeCampaignName("  Ưu đãi mùa thu "), "Ưu đãi mùa thu");
  assert.equal(normalizeCampaignName("Ử"), "Ử");
  assert.equal(normalizeCampaignName("Ưu đãi".normalize("NFD")), "Ưu đãi");
});

test("a name with braces, an empty one or an oversized one is not a key", () => {
  assert.equal(isTranslatableCampaignName("Mua 3 tặng 1"), true);
  // The translator reads {slot} in a key as a pattern, which would match other text.
  assert.equal(isTranslatableCampaignName("Giảm {amount}"), false);
  assert.equal(isTranslatableCampaignName(""), false);
  assert.equal(isTranslatableCampaignName("x".repeat(CAMPAIGN_NAME_LIMITS.source + 1)), false);
});

test("a form row parses; an empty English removes the translation", () => {
  assert.deepEqual(parseCampaignNameInput(" Mua 3 tặng 1 ", " Buy 3 get 1 "), {
    ok: true,
    value: { source: "Mua 3 tặng 1", text: "Buy 3 get 1" },
  });
  assert.deepEqual(parseCampaignNameInput("Mua 3 tặng 1", ""), { ok: true, value: { source: "Mua 3 tặng 1", text: "" } });
  assert.deepEqual(parseCampaignNameInput("Mua 3 tặng 1", null), { ok: true, value: { source: "Mua 3 tặng 1", text: "" } });
  assert.deepEqual(parseCampaignNameInput("{x}", "a"), { ok: false, reason: "SOURCE" });
  assert.deepEqual(parseCampaignNameInput(42, "a"), { ok: false, reason: "SOURCE" });
  assert.deepEqual(parseCampaignNameInput("Mua 3 tặng 1", "y".repeat(CAMPAIGN_NAME_LIMITS.text + 1)), {
    ok: false,
    reason: "TEXT_TOO_LONG",
  });
});

test("only filled, usable rows become translator messages", () => {
  const messages = campaignNameMessages([
    { source: "Mua 3 tặng 1", text: "Buy 3 get 1" },
    { source: "Chưa dịch", text: "   " },
    { source: "Có {ngoặc}", text: "Braces" },
    { source: "Cũ".normalize("NFD"), text: "Old" },
  ]);
  assert.deepEqual(messages, { "Mua 3 tặng 1": "Buy 3 get 1", "Cũ": "Old" });
});

test("the translator shows an admin's English name, and the Vietnamese when there is none", () => {
  const names = campaignNameMessages([{ source: "Ưu đãi mùa thu", text: "Autumn offer" }]);
  const en = createTranslator("en", { ...EN_MESSAGES, ...names });
  assert.equal(en("Ưu đãi mùa thu"), "Autumn offer");
  assert.equal(en("Quà tri ân khách hàng"), "Quà tri ân khách hàng");
  // Vietnamese reads nothing.
  assert.equal(createTranslator("vi", {})("Ưu đãi mùa thu"), "Ưu đãi mùa thu");
  // An admin's entry wins over a catalog entry of the same text.
  const override = createTranslator("en", { ...EN_MESSAGES, ...campaignNameMessages([{ source: "Freeship", text: "Free delivery" }]) });
  assert.equal(override("Freeship"), "Free delivery");
});

test("a name inside a sentence is translated sentence by sentence, whatever the loose patterns say", () => {
  const detail =
    "Miễn phí vận chuyển mùa thu. Chỉ tính sản phẩm mua trong phạm vi chiến dịch, không tính quà tặng. Không cộng dồn với giảm giá và quà tặng. Giỏ hàng và thanh toán kiểm tra điều kiện hiện tại.";
  const withName = createTranslator("en", { ...EN_CLIENT_MESSAGES, "Miễn phí vận chuyển mùa thu": "Autumn free shipping" });
  assert.equal(
    withName(detail),
    "Autumn free shipping. Only products bought within the campaign count, not gifts. Does not stack with discounts and gifts. The cart and checkout check the conditions as they stand.",
  );
  // No translation for the name: it stays as the shop wrote it, the rest is English, and nothing is garbled.
  const without = createTranslator("en", EN_CLIENT_MESSAGES)(detail);
  assert.ok(without.startsWith("Miễn phí vận chuyển mùa thu. Only products bought"), without);
  assert.ok(without.endsWith("Does not stack with discounts and gifts. The cart and checkout check the conditions as they stand."), without);
});

test("the voucher teaser's sentences read in English with dollar figures", () => {
  const en = createTranslator("en", EN_MESSAGES);
  assert.equal(en("Giảm 200.000đ cho đơn từ 2.000.000đ"), "$7.69 off orders from $76.92");
  assert.equal(en("Miễn phí vận chuyển cho đơn từ 600.000đ"), "Free shipping on orders from $23.08");
  assert.equal(en("Giảm 10% (tối đa 200.000đ) cho đơn từ 1.000.000đ"), "10% off (up to $7.69) on orders from $38.46");
  assert.equal(en("Giảm 10% cho đơn từ 1.000.000đ"), "10% off orders from $38.46");
  assert.equal(en("Đơn từ 1,5 triệu · tối đa 200K"), "Orders from $57.69 · up to $7.69");
});
