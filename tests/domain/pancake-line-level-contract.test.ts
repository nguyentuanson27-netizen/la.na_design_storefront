import assert from "node:assert/strict";
import test from "node:test";

import { buildPancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";
import { LINE_LEVEL_PRICING_VERIFIED_SHOPS_ENV, readLineLevelPricingVerifiedShopIds } from "../../src/commerce/pancake-line-level-contract.ts";

const base = {
  shopId: 715_077_776, guestName: "TEST", guestPhone: "0900000000", provinceRef: "p", districtRef: "d", communeRef: "c",
  addressDetail: "a", note: null, shippingFeeVnd: 30_000,
};

test("GQ20: several lines of one variation at different unit prices are sent as separate items, never merged or averaged", () => {
  const request = buildPancakeCreateOrderRequest({
    ...base,
    lines: [
      { pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 },
      { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 },
    ],
  });
  assert.deepEqual(request.items.map((item) => [item.variation_id, item.quantity, item.variation_info.retail_price]), [["v", 2, 100_001], ["v", 1, 90_001]]);
  assert.equal(request.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0), 290_003);
});

test("GQ20: a paid unit and a 1.000đ gift unit of one variation stay two items (the case GQ01 accepted live)", () => {
  const request = buildPancakeCreateOrderRequest({
    ...base,
    lines: [
      { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 99_000 },
      { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 1000 },
    ],
  });
  assert.deepEqual(request.items.map((item) => item.variation_info.retail_price), [99_000, 1000]);
});

test("GQ20: money stays integer VND and a malformed line refuses the whole request", () => {
  for (const unitPriceVnd of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => buildPancakeCreateOrderRequest({ ...base, lines: [{ pancakeVariationId: "v", quantity: 2, unitPriceVnd }] }), /invalid/i, String(unitPriceVnd));
  }
  assert.throws(() => buildPancakeCreateOrderRequest({ ...base, lines: [{ pancakeVariationId: "v", quantity: 0, unitPriceVnd: 5 }] }), /invalid/i);
  assert.throws(() => buildPancakeCreateOrderRequest({ ...base, lines: [] }), /invalid/i);
});

test("GQ20: only shops listed by the operator have the benefit path; anything malformed fails closed", () => {
  const read = (value: string | undefined) => readLineLevelPricingVerifiedShopIds({ [LINE_LEVEL_PRICING_VERIFIED_SHOPS_ENV]: value });
  assert.deepEqual(read(undefined), []);
  assert.deepEqual(read(""), []);
  assert.deepEqual(read("715077776"), [715_077_776]);
  assert.deepEqual(read(" 715077776 , 920007,715077776"), [715_077_776, 920_007]);
  assert.deepEqual(read("0,-5,abc,1.5,1e3,9999999999999999,"), []);
  assert.deepEqual(read("715077776;920007"), []);
  assert.deepEqual(readLineLevelPricingVerifiedShopIds({}), []);
});
