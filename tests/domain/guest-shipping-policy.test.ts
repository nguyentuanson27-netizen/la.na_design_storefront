import assert from "node:assert/strict";
import test from "node:test";
import { calculateGuestShippingFeeVnd, describeGuestShippingPromotion, describeGuestShippingPromotionHeadline, readGuestShippingPolicy, tryReadGuestShippingPolicy } from "../../src/commerce/guest-shipping-policy.ts";

test("base shipping has no automatic quantity or subtotal waiver", () => {
  assert.deepEqual(readGuestShippingPolicy({}), { feeVnd: 30_000 });
  for (const [subtotalVnd, totalQuantity] of [[0, 1], [500000, 2], [1000000, 3], [1000001, 1], [5000000, 10]]) {
    assert.equal(calculateGuestShippingFeeVnd({ subtotalVnd, totalQuantity }, readGuestShippingPolicy({})), 30_000);
  }
});
test("stale and malformed removed environment thresholds cannot enable any shipping promotion", () => {
  for (const legacy of ["0", "2", "3", "1000000", "invalid", "-1"]) {
    const policy = readGuestShippingPolicy({ LA_SHIPPING_FEE_VND: "25000", LA_FREE_SHIPPING_MIN_QUANTITY: legacy, LA_FREE_SHIPPING_SUBTOTAL_VND: legacy, LA_FREE_SHIPPING_MIN_SET_QUANTITY: legacy });
    assert.deepEqual(policy, { feeVnd: 25_000 });
    assert.equal(calculateGuestShippingFeeVnd({ subtotalVnd: 1_500_000, totalQuantity: 4 }, policy), 25_000);
  }
});
test("only the base fee is configurable and supports whole safe VND including zero", () => {
  for (const feeVnd of [0, 17000, 30000, Number.MAX_SAFE_INTEGER]) {
    const policy = readGuestShippingPolicy({ LA_SHIPPING_FEE_VND: String(feeVnd) });
    assert.equal(calculateGuestShippingFeeVnd({ subtotalVnd: 100, totalQuantity: 1 }, policy), feeVnd);
  }
});
test("malformed base fee configuration fails closed", () => {
  for (const raw of ["", "-1", "+30000", " 30000", "30000.5", "3e4", "030000", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => readGuestShippingPolicy({ LA_SHIPPING_FEE_VND: raw }), RangeError);
    assert.equal(tryReadGuestShippingPolicy({ LA_SHIPPING_FEE_VND: raw }), undefined);
  }
});
test("malformed totals and policies are rejected rather than converted to money", () => {
  for (const subtotalVnd of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => calculateGuestShippingFeeVnd({ subtotalVnd, totalQuantity: 1 }), RangeError);
  for (const totalQuantity of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => calculateGuestShippingFeeVnd({ subtotalVnd: 100, totalQuantity }), RangeError);
  for (const feeVnd of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => calculateGuestShippingFeeVnd({ subtotalVnd: 100, totalQuantity: 1 }, { feeVnd }), RangeError);
    assert.throws(() => describeGuestShippingPromotionHeadline({ feeVnd }), RangeError);
  }
});
test("base copy uses the configured fee without advertising a permanent campaign", () => {
  const copy = describeGuestShippingPromotion({ feeVnd: 25_000 });
  assert.match(copy.detail, /25\.000/);
  assert.doesNotMatch(copy.detail, /2 Set|3 s\u1ea3n ph\u1ea9m|1\.000\.000/);
  assert.match(describeGuestShippingPromotionHeadline({ feeVnd: 17_000 }), /17\.000/);
  assert.notEqual(copy.detail, describeGuestShippingPromotion({ feeVnd: 30_000 }).detail);
});
