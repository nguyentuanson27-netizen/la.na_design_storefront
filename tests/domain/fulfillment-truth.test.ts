import assert from "node:assert/strict";
import test from "node:test";

import { BRAND, FULFILLMENT } from "../../src/brand/index.ts";
import {
  buildPublicBrandFacts,
  describePublicDeliveryEstimate,
} from "../../src/content/public-brand-facts.ts";
import { buildReturnsViewModel, buildShippingViewModel } from "../../src/routes/evergreen-model.ts";

/**
 * A5 — delivery, payment, returns and complaint-handling truth, from master spec PART D.
 *
 * These are contractual commitments, so the assertions quote them rather than sampling. The
 * regressions guarded at the end are the specific Brand #1 clauses this slice retires: a 3–15 day
 * window for everywhere outside Hanoi, a delivery split that reads as inner-city only, a bank
 * transfer the site cannot actually take, and a right to exchange size or colour on an order the
 * shop fulfilled correctly.
 */

const POLICY = { feeVnd: 25_000, freeShippingSubtotalVnd: 750_000, freeShippingMinQuantity: 4 } as const;

test("A5 delivery is nationwide, through the four approved carriers", () => {
  assert.equal(FULFILLMENT.delivery.coverage, "Giao hàng toàn quốc");
  assert.deepEqual(FULFILLMENT.delivery.carriers, ["GHN", "GHTK", "Viettel Post", "J&T"]);
  // §12: which carrier handles an order may vary. Listing four without saying so would read as a
  // choice the shopper gets to make.
  assert.match(FULFILLMENT.delivery.carrierSelectionNote, /tùy|thay đổi/i);
});

test("A5 the approved delivery windows are Hà Nội 1–3 days and everywhere else 3–10", () => {
  assert.deepEqual(FULFILLMENT.delivery.estimateDays.innerCity, { minimum: 1, maximum: 3 });
  assert.deepEqual(FULFILLMENT.delivery.estimateDays.otherProvince, { minimum: 3, maximum: 10 });

  // The scope labels are half the fact: 1–3 days applies to Hà Nội, not to its inner districts.
  assert.equal(FULFILLMENT.deliveryScopeLabels.innerCity, "Hà Nội");
  assert.equal(FULFILLMENT.deliveryScopeLabels.otherProvince, "Tỉnh, thành khác");

  const shipping = buildShippingViewModel({ policy: POLICY });
  assert.equal(shipping.innerCityLabel, "Hà Nội");
  assert.equal(shipping.innerCityEstimate, describePublicDeliveryEstimate({ minimum: 1, maximum: 3 }));
  assert.equal(shipping.otherProvinceLabel, "Tỉnh, thành khác");
  assert.equal(
    shipping.otherProvinceEstimate,
    describePublicDeliveryEstimate({ minimum: 3, maximum: 10 }),
  );
});

test("A5 the windows stay estimates, and no carrier tracking is promised", () => {
  assert.match(FULFILLMENT.delivery.estimateCaveat, /dự kiến/);
  assert.match(FULFILLMENT.delivery.carrierTrackingNote, /không cung cấp mã vận đơn/);
  // §12: confirmation calls are not mandatory, so the wording may not promise one on every order.
  assert.doesNotMatch(FULFILLMENT.delivery.phoneConfirmationWording, /mọi đơn|tất cả đơn|luôn gọi/);
});

test("A5 the website takes COD only, and says so about bank transfer in the approved words", () => {
  assert.equal(FULFILLMENT.payment.codNote, "Thanh toán khi nhận hàng (COD).");
  assert.equal(
    FULFILLMENT.payment.bankTransferUnavailableNote,
    "Chuyển khoản ngân hàng hiện tạm thời chưa khả dụng trên website.",
  );

  // The public projections carry the same two sentences, so the page cannot word it differently.
  const facts = buildPublicBrandFacts(POLICY);
  assert.equal(facts.paymentMethod, FULFILLMENT.payment.codNote);
  assert.equal(facts.bankTransferUnavailable, FULFILLMENT.payment.bankTransferUnavailableNote);

  const shipping = buildShippingViewModel({ policy: POLICY });
  assert.equal(shipping.paymentMethod, FULFILLMENT.payment.codNote);
  assert.equal(shipping.bankTransferUnavailable, FULFILLMENT.payment.bankTransferUnavailableNote);
});

test("A5 no bank account detail or selectable transfer method is published", () => {
  const published = JSON.stringify([
    FULFILLMENT,
    buildPublicBrandFacts(POLICY),
    buildShippingViewModel({ policy: POLICY }),
  ]);
  for (const forbidden of [/số tài khoản/i, /chủ tài khoản/i, /STK/, /swift/i, /vietcombank/i, /techcombank/i]) {
    assert.equal(forbidden.test(published), false, forbidden.source);
  }
});

test("A5 the return window and the supported cases are the approved ones", () => {
  assert.equal(FULFILLMENT.returns.windowDays, 15);
  assert.deepEqual(FULFILLMENT.returns.supportedCases, [
    "Sản phẩm lỗi hoặc có vết bẩn từ phía sản xuất.",
    `${BRAND.identity.name} giao sai mẫu.`,
    "Giao sai màu.",
    "Giao sai size.",
    "Khách hàng chủ động đổi sang mẫu khác.",
  ]);
});

test("A5 who pays the return shipping follows fault, and the fees are the approved ones", () => {
  assert.equal(FULFILLMENT.returns.customerInitiatedExchangeFeeVnd, 50_000);
  assert.match(FULFILLMENT.returns.customerInitiatedShippingNote, /hai chiều/);
  assert.match(FULFILLMENT.returns.shopFaultShippingNote, /toàn bộ phí vận chuyển/);
  assert.equal(FULFILLMENT.returnLogistics.restockingFeeVnd, 0);
  assert.deepEqual(FULFILLMENT.returns.nonReturnableCategories, []);
  assert.deepEqual(FULFILLMENT.returns.refundWorkingDays, { minimum: 7, maximum: 10 });
  // §13: the original payment method comes first, and the alternatives are agreed, not imposed.
  assert.match(FULFILLMENT.returns.refundChannelNote, /ưu tiên/i);
});

test("A5 complaints carry the approved response target", () => {
  assert.equal(FULFILLMENT.support.complaintResponseNote, "24–48 giờ làm việc kể từ khi tiếp nhận đủ thông tin.");
});

test("A5 the retired Brand #1 clauses do not survive anywhere a reader can reach", () => {
  const published = JSON.stringify([
    FULFILLMENT,
    buildPublicBrandFacts(POLICY),
    buildShippingViewModel({ policy: POLICY }),
    buildReturnsViewModel(),
  ]);

  // The 3–15 day window, in both the config's numbers and the rendered range.
  assert.equal(published.includes("3–15"), false, "the legacy 3–15 day estimate must not survive");
  assert.equal(FULFILLMENT.delivery.estimateDays.otherProvince.maximum === 15, false);

  // The inner-city framing: 1–3 days is Hà Nội, and "Nội thành" narrows it to part of the city.
  assert.equal(published.includes("Nội thành"), false, "the inner-city scope label must not survive");
  assert.equal(published.includes("Ngoại tỉnh"), false);

  // The unsupported legacy promise: an exchange of size or colour on a correctly fulfilled order.
  assert.equal(
    published.includes("Khách hàng mua đúng hàng nhưng muốn đổi size hoặc đổi màu."),
    false,
    "the unapproved size/colour exchange case must not survive",
  );
  assert.equal(
    /đổi size hoặc đổi màu|chính sách đổi mẫu \/ size \/ màu/.test(published),
    false,
    "no projection may restate that promise in other words",
  );
});
