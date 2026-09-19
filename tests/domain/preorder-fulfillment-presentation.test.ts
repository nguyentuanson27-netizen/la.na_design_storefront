import assert from "node:assert/strict";
import test from "node:test";

import { FULFILLMENT } from "../../src/brand/index.ts";
import { buildPreorderFulfillmentNotice } from "../../src/commerce/preorder-fulfillment-presentation.ts";
import { PREORDER_PREPARATION_DAYS } from "../../src/commerce/preorder-order-snapshot.ts";

/**
 * F8b — what a basket containing a `Đặt trước` line tells the shopper, in the cart and at checkout.
 *
 * One projection feeds both pages, so these cases are the contract for both at once: if the cart
 * and the checkout could disagree about a basket, it would be because one of them decided something
 * itself, and neither does.
 *
 * `inventory-buyer-presentation.test.ts` covers the half of the journey before this one, where a
 * line is classified as a preorder sale in the first place.
 */

const readyLine = { available: true, isPreorderSale: false } as const;
const preorderLine = { available: true, isPreorderSale: true } as const;

test("F8b a ready-only basket carries no preorder notice at all", () => {
  assert.equal(buildPreorderFulfillmentNotice([readyLine, readyLine]), null);
});

test("F8b a preorder basket states 15 calendar days from successful system confirmation", () => {
  const notice = buildPreorderFulfillmentNotice([preorderLine]);

  assert.ok(notice);
  assert.equal(notice.preorderLabel, "Đặt trước");
  assert.equal(notice.preparationDays, 15);
  assert.equal(
    notice.preparationDays,
    PREORDER_PREPARATION_DAYS,
    "the cart must count the same days the confirmation snapshot will",
  );
  assert.match(notice.preparationBasis, /xác nhận thành công/);
  assert.ok(
    !/thêm vào giỏ|giỏ hàng/i.test(notice.preparationBasis),
    "§30 starts the clock at confirmation, never at add-to-cart",
  );
});

test("F8b the shipping windows are the approved policy's, not a second copy", () => {
  const notice = buildPreorderFulfillmentNotice([preorderLine]);

  assert.ok(notice);
  assert.deepEqual(
    notice.shippingWindows.map((window) => window.zoneLabel),
    [FULFILLMENT.deliveryScopeLabels.innerCity, FULFILLMENT.deliveryScopeLabels.otherProvince],
  );
  const [innerCity, otherProvince] = notice.shippingWindows;
  assert.equal(innerCity?.estimateText, "1–3 ngày");
  assert.equal(otherProvince?.estimateText, "3–10 ngày");
  assert.equal(
    innerCity?.estimateText,
    `${FULFILLMENT.delivery.estimateDays.innerCity.minimum}–${FULFILLMENT.delivery.estimateDays.innerCity.maximum} ngày`,
  );
});

test("F8b the notice promises no date and no guaranteed delivery", () => {
  const notice = buildPreorderFulfillmentNotice([preorderLine, readyLine]);

  assert.ok(notice);
  const words = JSON.stringify(notice);
  for (const forbidden of ["cam kết", "bảo đảm", "đảm bảo", "chắc chắn"]) {
    assert.ok(
      !words.includes(forbidden) || notice.estimateCaveat.includes(forbidden),
      `a preorder notice must not guarantee delivery ("${forbidden}")`,
    );
  }
  // The caveat the approved delivery policy requires alongside any window travels with it.
  assert.equal(notice.estimateCaveat, FULFILLMENT.delivery.estimateCaveat);
  // No ISO date, no formatted date: §30's clock has not started while this is still a basket.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(words), "no date may be produced before confirmation");
});

test("F8b a mixed basket is flagged as mixed, so one-shipment truth can be stated", () => {
  const mixed = buildPreorderFulfillmentNotice([readyLine, preorderLine]);
  const preorderOnly = buildPreorderFulfillmentNotice([preorderLine, preorderLine]);

  assert.equal(mixed?.hasMixedReadyLines, true);
  assert.equal(preorderOnly?.hasMixedReadyLines, false);
});

test("F8b several preorder lines share one preparation window rather than compounding", () => {
  const one = buildPreorderFulfillmentNotice([preorderLine]);
  const three = buildPreorderFulfillmentNotice([preorderLine, preorderLine, preorderLine]);

  // §30 gives the order one readiness basis. Nothing may multiply or "slowest-of" it per line.
  assert.equal(three?.preparationDays, one?.preparationDays);
  assert.equal(three?.preparationDays, PREORDER_PREPARATION_DAYS);
});

test("F8b an unavailable line neither creates a preorder notice nor makes a basket look mixed", () => {
  assert.equal(
    buildPreorderFulfillmentNotice([{ available: false, isPreorderSale: true }]),
    null,
    "a line that cannot be ordered cannot promise a preparation window",
  );

  const notice = buildPreorderFulfillmentNotice([
    preorderLine,
    { available: false, isPreorderSale: false },
  ]);
  assert.equal(
    notice?.hasMixedReadyLines,
    false,
    "an unavailable ready line is not being held with anything",
  );
});

test("F8b an oversell line reaches the notice as ordinary ready stock", () => {
  // An OVERSELL sale is `isPreorderSale: false` by construction upstream; this pins that the
  // projection has no other route to a preorder notice.
  assert.equal(buildPreorderFulfillmentNotice([readyLine, readyLine]), null);
});
