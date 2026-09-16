import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_DELIVERY_FACTS, PUBLIC_RETURNS_POLICY } from "../../src/content/public-brand-facts.ts";
import { FULFILLMENT } from "../../src/brand/index.ts";

test("M5 public return authority exposes the owner-approved Merchant-compatible facts", () => {
  assert.deepEqual(FULFILLMENT.returnLogistics, {
    returnMethods: {
      inStore: "Trả trực tiếp tại cửa hàng / địa điểm kinh doanh.",
      byMail: "Gửi trả qua đường vận chuyển / bưu gửi.",
      byMailResponsibility: "Khách hàng tự chịu trách nhiệm gửi hàng và nhãn/phiếu gửi trả.",
    },
    restockingFeeVnd: 0,
    restockingFeeNote: "Không thu phí restocking.",
    nonDefectiveRefundNote:
      "Sản phẩm đúng và không lỗi không được trả lại để hoàn tiền vì khách hàng đổi ý; khách hàng có thể đổi sang mẫu khác theo điều kiện đổi hàng hiện hành.",
  });

  // The existing customer-initiated exchange fee remains a different business fact.
  assert.equal(PUBLIC_RETURNS_POLICY.customerInitiatedExchangeFeeVnd, 50_000);
});

test("M5 public delivery authority names the owner-approved Hanoi scopes explicitly", () => {
  assert.deepEqual(FULFILLMENT.deliveryScopeLabels, {
    innerCity: "Hà Nội",
    otherProvince: "Tỉnh, thành khác",
  });

  assert.deepEqual(PUBLIC_DELIVERY_FACTS.estimateDays, {
    innerCity: { minimum: 1, maximum: 3 },
    otherProvince: { minimum: 3, maximum: 10 },
  });
});
