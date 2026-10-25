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
