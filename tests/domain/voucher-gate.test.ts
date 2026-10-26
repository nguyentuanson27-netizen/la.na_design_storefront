import assert from "node:assert/strict";
import test from "node:test";

import { VOUCHER_ENV, canIssueNewVouchers, isVoucherEnabled } from "../../src/commerce/voucher-gate.ts";

test("only the exact string true turns vouchers on", () => {
  assert.equal(VOUCHER_ENV, "LA_VOUCHER_ENABLED");
  assert.equal(isVoucherEnabled({ LA_VOUCHER_ENABLED: "true" }), true);
  for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
    assert.equal(isVoucherEnabled({ LA_VOUCHER_ENABLED: value }), false, String(value));
  }
});

test("a NEXT_PUBLIC copy or another feature flag cannot enable vouchers", () => {
  assert.equal(isVoucherEnabled({ NEXT_PUBLIC_LA_VOUCHER_ENABLED: "true" }), false);
  assert.equal(isVoucherEnabled({ LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PROMOTION_ACTIVATION_ENABLED: "true" }), false);
  assert.equal(isVoucherEnabled({}), false);
});

test("issuing new vouchers follows the gate; there is no gate for settling existing holds", () => {
  assert.equal(canIssueNewVouchers({ LA_VOUCHER_ENABLED: "true" }), true);
  assert.equal(canIssueNewVouchers({ LA_VOUCHER_ENABLED: "false" }), false);
});

test("ADR 0019 D-6: a hold needs the feature AND a verified shop; malformed list entries never match", async () => {
  const { VOUCHER_VERIFIED_SHOPS_ENV, canGrantVoucherHolds, readVoucherVerifiedShopIds } = await import("../../src/commerce/voucher-gate.ts");
  const on = { LA_VOUCHER_ENABLED: "true" };
  assert.equal(canGrantVoucherHolds(715077776, on), false, "feature on, shop not listed");
  assert.equal(canGrantVoucherHolds(715077776, { ...on, [VOUCHER_VERIFIED_SHOPS_ENV]: "715077776" }), true);
  assert.equal(canGrantVoucherHolds(715077776, { [VOUCHER_VERIFIED_SHOPS_ENV]: "715077776" }), false, "listed, feature off");
  assert.deepEqual(readVoucherVerifiedShopIds({ [VOUCHER_VERIFIED_SHOPS_ENV]: " 715077776 , 12;3,0, -4, 1e3, 715077776, 99" }), [715077776, 99]);
  assert.deepEqual(readVoucherVerifiedShopIds({ [VOUCHER_VERIFIED_SHOPS_ENV]: "" }), []);
  assert.deepEqual(readVoucherVerifiedShopIds({}), []);
});
