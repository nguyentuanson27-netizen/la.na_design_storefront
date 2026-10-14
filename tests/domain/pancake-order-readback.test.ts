import assert from "node:assert/strict";
import test from "node:test";

import { compareOrderReadBack } from "../../src/commerce/pancake-order-readback-check.ts";
import { parsePancakeOrderReadBack, PancakeOrderReadBackError } from "../../src/integrations/pancake/order-readback.ts";

const item = (variation_id: unknown, quantity: unknown, retail_price: unknown) => ({ variation_id, quantity, variation_info: { retail_price } });
const expected = [
  { pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 },
  { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 },
  { pancakeVariationId: "g", quantity: 1, unitPriceVnd: 1000 },
];

test("the production parser reads exactly the fields the acceptance run used, with or without the data envelope", () => {
  const order = { items: [item("v", 2, 100_001), item("v", 1, 90_001)], total_price: 290_003 };
  assert.deepEqual(parsePancakeOrderReadBack(order), { lines: [{ pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 }], totalPriceVnd: 290_003 });
  assert.deepEqual(parsePancakeOrderReadBack({ data: order }), parsePancakeOrderReadBack(order));
  assert.equal(parsePancakeOrderReadBack({ items: [item("v", 1, 5)] }).totalPriceVnd, null);
  assert.equal(parsePancakeOrderReadBack({ items: [item("v", 1, 5)], total_price: "5" }).totalPriceVnd, null);
});

test("anything it cannot read exactly is refused, never guessed", () => {
  for (const payload of [null, undefined, "x", 7, [], {}, { items: [] }, { items: "nope" }, { items: [item(undefined, 1, 5)] }, { items: [item("", 1, 5)] }, { items: [item("v", 0, 5)] }, { items: [item("v", 1.5, 5)] }, { items: [item("v", 1, -1)] }, { items: [item("v", 1, 5.5)] }, { items: [item("v", 1, "5")] }, { items: [null] }, { items: Array.from({ length: 501 }, () => item("v", 1, 5)) }]) {
    assert.throws(() => parsePancakeOrderReadBack(payload), PancakeOrderReadBackError, JSON.stringify(payload)?.slice(0, 60));
  }
});

test("a POS that re-orders lines still matches", () => {
  const readBack = { lines: [...expected].reverse(), totalPriceVnd: 291_003 };
  assert.deepEqual(compareOrderReadBack(expected, readBack), { kind: "MATCH" });
  assert.deepEqual(compareOrderReadBack(expected, { lines: expected, totalPriceVnd: null }), { kind: "MATCH" });
});

test("split quantities of one (variation, price) are summed before comparing", () => {
  const readBack = { lines: [{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 100_001 }, ...expected.slice(1)], totalPriceVnd: null };
  assert.deepEqual(compareOrderReadBack(expected, readBack), { kind: "MATCH" });
});

test("a merged, averaged, dropped, moved or re-priced line is a drift, to the đồng", () => {
  const drift = (lines: typeof expected, totalPriceVnd: number | null = null) => compareOrderReadBack(expected, { lines, totalPriceVnd }).kind;
  assert.equal(drift([{ pancakeVariationId: "v", quantity: 3, unitPriceVnd: 96_667 }, expected[2]!]), "DRIFT"); // averaged
  assert.equal(drift([{ pancakeVariationId: "v", quantity: 3, unitPriceVnd: 100_001 }, expected[2]!]), "DRIFT"); // merged to one price
  assert.equal(drift([expected[0]!, expected[1]!]), "DRIFT"); // gift line dropped
  assert.equal(drift([expected[0]!, { ...expected[1]!, unitPriceVnd: 90_000 }, expected[2]!]), "DRIFT"); // one đồng off
  assert.equal(drift([{ ...expected[0]!, quantity: 1 }, { ...expected[1]!, quantity: 2 }, expected[2]!]), "DRIFT"); // a unit moved between prices
  assert.equal(drift([...expected, { pancakeVariationId: "x", quantity: 1, unitPriceVnd: 1 }]), "DRIFT"); // extra line
  assert.equal(drift(expected, 291_004), "DRIFT"); // the POS's own total disagrees
  // The same total re-split between prices (1 x 100.001 + 2 x 95.001 = 2 x 100.001 + 1 x 90.001): only the key catches it.
  assert.equal(drift([{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 2, unitPriceVnd: 95_001 }, expected[2]!], 291_003), "DRIFT");
  assert.equal(drift([{ ...expected[2]!, pancakeVariationId: "other" }, expected[0]!, expected[1]!]), "DRIFT"); // gift on another variation
});

test("the gateway reads an order by its canonical id from the shop-scoped endpoint and refuses anything else", async () => {
  const { createPancakeOrderGateway } = await import("../../src/integrations/pancake/order-gateway.ts");
  const requested: string[] = [];
  const gateway = createPancakeOrderGateway({
    getJson: async (endpoint: string) => { requested.push(endpoint); return { data: { items: [item("v", 1, 5)], total_price: 5 } }; },
    postJson: async () => ({}),
  });
  assert.deepEqual(await gateway.readOrder(715_077_776, "800001"), { lines: [{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 5 }], totalPriceVnd: 5 });
  assert.deepEqual(requested, ["/shops/715077776/orders/800001"]);
  await assert.rejects(() => gateway.readOrder(715_077_776, "../1"), TypeError);
  await assert.rejects(() => gateway.readOrder(0, "800001"), TypeError);
  const broken = createPancakeOrderGateway({ getJson: async () => ({ data: {} }), postJson: async () => ({}) });
  await assert.rejects(() => broken.readOrder(715_077_776, "800001"), PancakeOrderReadBackError);
});
