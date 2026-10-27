import assert from "node:assert/strict";
import test from "node:test";

import type { VoucherCampaign } from "../../src/commerce/voucher-campaign.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";
import { buildVoucherTeaser, MAX_VOUCHER_TEASER_ITEMS } from "../../src/commerce/voucher-teaser.ts";

const SHOP = 940_014;
const dress = { productId: "dress", shopId: String(SHOP), categoryKeys: ["vayDam"] };
const bag = { productId: "bag", shopId: String(SHOP), categoryKeys: ["phuKien"] };

function voucher(id: string, input: Record<string, unknown>, extra: Partial<VoucherCampaign> = {}): VoucherCampaign {
  const parsed = validateVoucherCampaign({ name: id, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", scope: { mode: "ALL_SHOP", excludeProductIds: [] }, ...input });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return { ...(parsed as { value: object }).value, id, pancakeShopId: SHOP, revision: 1, isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), disabledAt: null, redeemedUses: 0, redeemedVnd: 0, reservedUses: 0, reservedVnd: 0, ...extra } as VoucherCampaign;
}
const fixed = (id: string, amountVnd: number, min: number, extra: Record<string, unknown> = {}) => voucher(id, { discount: { type: "FIXED_AMOUNT_VND", amountVnd }, minEligibleSubtotalVnd: min, ...extra });

test("the teaser states a voucher's own conditions, in its own words, and nothing about the shopper", () => {
  const items = buildVoucherTeaser({
    campaigns: [fixed("a", 30_000, 600_000), voucher("p", { discount: { type: "PERCENTAGE", percent: 10, maxDiscountVnd: 100_000 }, minEligibleSubtotalVnd: 300_000 }), voucher("s", { kind: "SHIPPING_FREE", minEligibleSubtotalVnd: 500_000 })],
    product: dress,
  });
  assert.equal(items.length, MAX_VOUCHER_TEASER_ITEMS);
  assert.deepEqual(items.map((i) => i.text), ["Giảm 10% (tối đa 100.000đ) cho đơn từ 300.000đ", "Giảm 30.000đ cho đơn từ 600.000đ"]);
  for (const item of items) assert.doesNotMatch(item.text, /bạn sẽ|nàng sẽ|chắc chắn|được giảm ngay/i);
});

test("only vouchers that cover this product are named (scope, shop and exclusions)", () => {
  const dressOnly = fixed("dress", 20_000, 100_000, { scope: { mode: "TARGETED", categoryKeys: ["vayDam"] } });
  const noBag = fixed("nobag", 15_000, 100_000, { scope: { mode: "ALL_SHOP", excludeProductIds: ["bag"] } });
  assert.deepEqual(buildVoucherTeaser({ campaigns: [dressOnly, noBag], product: dress }).map((i) => i.id), ["dress", "nobag"]);
  assert.deepEqual(buildVoucherTeaser({ campaigns: [dressOnly, noBag], product: bag }).map((i) => i.id), []);
  assert.deepEqual(buildVoucherTeaser({ campaigns: [dressOnly], product: { ...dress, shopId: "other-shop" } }), []);
});

test("private and used-up vouchers are never advertised", () => {
  const priv = fixed("priv", 50_000, 100_000, { issuance: "CODE", visibility: "PRIVATE", code: "KOLSECRET" });
  const full = fixed("full", 40_000, 100_000, { maxUses: 1 });
  const ok = fixed("ok", 10_000, 100_000);
  const items = buildVoucherTeaser({ campaigns: [priv, { ...full, redeemedUses: 1 }, ok], product: dress });
  assert.deepEqual(items.map((i) => i.id), ["ok"]);
  assert.doesNotMatch(JSON.stringify(items), /KOLSECRET/);
});

test("no vouchers means an empty teaser, and the order is stable", () => {
  assert.deepEqual(buildVoucherTeaser({ campaigns: [], product: dress }), []);
  const a = fixed("b", 10_000, 100_000);
  const b = fixed("a", 10_000, 100_000);
  assert.deepEqual(buildVoucherTeaser({ campaigns: [a, b], product: dress }).map((i) => i.id), buildVoucherTeaser({ campaigns: [b, a], product: dress }).map((i) => i.id));
});
