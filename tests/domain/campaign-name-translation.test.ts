import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_NAME_LIMITS,
  campaignNameMap,
  isTranslatableCampaignName,
  localizeCampaignName,
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

test("an empty or oversized name is not a key", () => {
  assert.equal(isTranslatableCampaignName("Mua 3 tặng 1"), true);
  // It is a lookup of its own, not a translator pattern, so braces are an ordinary character.
  assert.equal(isTranslatableCampaignName("Giảm {amount}"), true);
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
  assert.deepEqual(parseCampaignNameInput("   ", "a"), { ok: false, reason: "SOURCE" });
  assert.deepEqual(parseCampaignNameInput(42, "a"), { ok: false, reason: "SOURCE" });
  assert.deepEqual(parseCampaignNameInput("Mua 3 tặng 1", "y".repeat(CAMPAIGN_NAME_LIMITS.text + 1)), {
    ok: false,
    reason: "TEXT_TOO_LONG",
  });
});

test("only filled, usable rows become lookups", () => {
  const names = campaignNameMap([
    { source: "Mua 3 tặng 1", text: "Buy 3 get 1" },
    { source: "Chưa dịch", text: "   " },
    { source: "", text: "Empty" },
    { source: "Cũ".normalize("NFD"), text: "Old" },
  ]);
  assert.deepEqual(names, { "Mua 3 tặng 1": "Buy 3 get 1", "Cũ": "Old" });
});

test("a campaign name is its English when an admin gave one, and as written otherwise", () => {
  const names = campaignNameMap([{ source: "Ưu đãi mùa thu", text: "Autumn offer" }]);
  assert.equal(localizeCampaignName(names, "Ưu đãi mùa thu"), "Autumn offer");
  assert.equal(localizeCampaignName(names, " Ưu đãi mùa thu "), "Autumn offer");
  assert.equal(localizeCampaignName(names, "Quà tri ân khách hàng"), "Quà tri ân khách hàng");
  assert.equal(localizeCampaignName(undefined, "Ưu đãi mùa thu"), "Ưu đãi mùa thu");
});

test("a campaign called like an interface label never changes the interface's own label", () => {
  // "Ưu đãi" is the eyebrow of the eligible-offers page and also a name a shop might give a campaign.
  const names = campaignNameMap([{ source: "Ưu đãi", text: "Autumn promotion" }]);
  const en = createTranslator("en", EN_MESSAGES);
  assert.equal(en("Ưu đãi"), "Offers");
  // The campaign's name is the admin's, through its own lookup.
  assert.equal(localizeCampaignName(names, "Ưu đãi"), "Autumn promotion");
  // Nothing about the names is in the translator: its output for the label is the catalog's, always.
  assert.equal(createTranslator("en", { ...EN_MESSAGES })("Ưu đãi"), "Offers");
});

test("sentences are translated one by one, whatever the loose patterns say, and a name is looked up on its own", () => {
  const detail =
    "Miễn phí vận chuyển mùa thu. Chỉ tính sản phẩm mua trong phạm vi chiến dịch, không tính quà tặng. Không cộng dồn với giảm giá và quà tặng. Giỏ hàng và thanh toán kiểm tra điều kiện hiện tại.";
  const rule = detail.slice("Miễn phí vận chuyển mùa thu. ".length);
  const en = createTranslator("en", EN_CLIENT_MESSAGES);
  assert.equal(
    en(rule),
    "Only products bought within the campaign count, not gifts. Does not stack with discounts and gifts. The cart and checkout check the conditions as they stand.",
  );
  // Joined whole, with a name the catalog does not know: the name stays, the rest is English, nothing is garbled.
  const whole = en(detail);
  assert.ok(whole.startsWith("Miễn phí vận chuyển mùa thu. Only products bought"), whole);
  assert.ok(whole.endsWith("Does not stack with discounts and gifts. The cart and checkout check the conditions as they stand."), whole);
});

test("the voucher teaser's sentences read in English with dollar figures", () => {
  const en = createTranslator("en", EN_MESSAGES);
  assert.equal(en("Giảm 200.000đ cho đơn từ 2.000.000đ"), "$9.99 off orders from $99.99");
  assert.equal(en("Miễn phí vận chuyển cho đơn từ 600.000đ"), "Free shipping on orders from $29.99");
  assert.equal(en("Giảm 10% (tối đa 200.000đ) cho đơn từ 1.000.000đ"), "10% off (up to $9.99) on orders from $49.99");
  assert.equal(en("Giảm 10% cho đơn từ 1.000.000đ"), "10% off orders from $49.99");
  assert.equal(en("Đơn từ 1,5 triệu · tối đa 200K"), "Orders from $74.99 · up to $9.99");
});
