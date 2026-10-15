import assert from "node:assert/strict";
import test from "node:test";

import { compareOrderReadBack } from "../../src/commerce/pancake-order-readback-check.ts";
import { parsePancakeOrderReadBack, PancakeOrderReadBackError } from "../../src/integrations/pancake/order-readback.ts";

const item = (variation_id: unknown, quantity: unknown, retail_price: unknown) => ({ variation_id, quantity, variation_info: { retail_price } });
/** A read-back about the order that was asked for: right id and shop, a new (status 0) order. */
const about = (readBack: { lines: typeof expected; totalPriceVnd: number | null }) => ({ orderId: "800001", shopId: 715_077_776, status: 0, ...readBack });
const IDENTITY = { orderId: "800001", shopId: 715_077_776 } as const;
const expected = [
  { pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 },
  { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 },
  { pancakeVariationId: "g", quantity: 1, unitPriceVnd: 1000 },
];

test("the production parser reads exactly the fields the acceptance run used, with or without the data envelope", () => {
  const order = { items: [item("v", 2, 100_001), item("v", 1, 90_001)], total_price: 290_003 };
  assert.deepEqual(parsePancakeOrderReadBack(order), { lines: [{ pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 }], totalPriceVnd: 290_003, orderId: null, shopId: null, status: null });
  assert.deepEqual(
    parsePancakeOrderReadBack({ ...order, id: 800001, shop_id: 715_077_776, status: 0 }, IDENTITY),
    { lines: [{ pancakeVariationId: "v", quantity: 2, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 90_001 }], totalPriceVnd: 290_003, orderId: "800001", shopId: 715_077_776, status: 0 },
  );
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
  assert.deepEqual(compareOrderReadBack(expected, about(readBack), IDENTITY), { kind: "MATCH" });
});

test("an order total the POS did not report, or reported unreadably, confirms nothing even when every line matches", () => {
  for (const totalPriceVnd of [null, Number.NaN, 291_003.5, Number.MAX_SAFE_INTEGER + 2]) {
    const verdict = compareOrderReadBack(expected, about({ lines: expected, totalPriceVnd }), IDENTITY);
    assert.equal(verdict.kind, "UNAVAILABLE", String(totalPriceVnd));
  }
  assert.deepEqual(compareOrderReadBack(expected, about({ lines: expected, totalPriceVnd: 291_003 }), IDENTITY), { kind: "MATCH" });
  // The parser maps a missing or string total to null, so the same lines read back from the wire are not a match either.
  const wireItems = expected.map((line) => item(line.pancakeVariationId, line.quantity, line.unitPriceVnd));
  const wire = parsePancakeOrderReadBack({ items: wireItems, id: 800001, shop_id: 715_077_776, status: 0 });
  assert.equal(compareOrderReadBack(expected, wire, IDENTITY).kind, "UNAVAILABLE");
  const stringTotal = parsePancakeOrderReadBack({ items: wireItems, id: 800001, shop_id: 715_077_776, status: 0, total_price: "291003" });
  assert.equal(compareOrderReadBack(expected, stringTotal, IDENTITY).kind, "UNAVAILABLE");
});

test("a canceled order, or one that is not the order and shop that were asked about, is never confirmed on a money match", () => {
  const ok = about({ lines: expected, totalPriceVnd: 291_003 });
  assert.deepEqual(compareOrderReadBack(expected, ok, IDENTITY), { kind: "MATCH" });
  // Status 7 is canceled (the code cancelOrder writes and reads back); the money still matches exactly.
  assert.equal(compareOrderReadBack(expected, { ...ok, status: 7 }, IDENTITY).kind, "DRIFT");
  // Identity must be reported and be the requested one.
  assert.equal(compareOrderReadBack(expected, { ...ok, orderId: "800002" }, IDENTITY).kind, "UNAVAILABLE");
  assert.equal(compareOrderReadBack(expected, { ...ok, shopId: 1 }, IDENTITY).kind, "UNAVAILABLE");
  assert.equal(compareOrderReadBack(expected, { ...ok, orderId: null }, IDENTITY).kind, "UNAVAILABLE");
  assert.equal(compareOrderReadBack(expected, { ...ok, shopId: null }, IDENTITY).kind, "UNAVAILABLE");
  // A status that is missing or not a known code cannot be shown to be active.
  assert.equal(compareOrderReadBack(expected, { ...ok, status: null }, IDENTITY).kind, "UNAVAILABLE");
  const unknownStatus = parsePancakeOrderReadBack({ items: expected.map((line) => item(line.pancakeVariationId, line.quantity, line.unitPriceVnd)), total_price: 291_003, id: 800001, shop_id: 715_077_776, status: 99 });
  assert.equal(unknownStatus.status, null);
  assert.equal(compareOrderReadBack(expected, unknownStatus, IDENTITY).kind, "UNAVAILABLE");
});

test("the parser refuses a payload that names another order or shop than the one requested", () => {
  const body = { items: [item("v", 1, 5)], total_price: 5, status: 0 };
  assert.throws(() => parsePancakeOrderReadBack({ ...body, id: 800002, shop_id: 715_077_776 }, IDENTITY), PancakeOrderReadBackError);
  assert.throws(() => parsePancakeOrderReadBack({ ...body, id: 800001, shop_id: 1 }, IDENTITY), PancakeOrderReadBackError);
  assert.equal(parsePancakeOrderReadBack({ ...body, id: 800001, shop_id: 715_077_776 }, IDENTITY).orderId, "800001");
});

test("split quantities of one (variation, price) are summed before comparing", () => {
  const readBack = { lines: [{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 100_001 }, { pancakeVariationId: "v", quantity: 1, unitPriceVnd: 100_001 }, ...expected.slice(1)], totalPriceVnd: 291_003 };
  assert.deepEqual(compareOrderReadBack(expected, about(readBack), IDENTITY), { kind: "MATCH" });
});

test("a merged, averaged, dropped, moved or re-priced line is a drift, to the đồng", () => {
  const drift = (lines: typeof expected, totalPriceVnd: number | null = null) => compareOrderReadBack(expected, about({ lines, totalPriceVnd }), IDENTITY).kind;
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
    getJson: async (endpoint: string) => { requested.push(endpoint); return { data: { items: [item("v", 1, 5)], total_price: 5, id: 800001, shop_id: 715_077_776, status: 0 } }; },
    postJson: async () => ({}),
  });
  assert.deepEqual(await gateway.readOrder(715_077_776, "800001"), { lines: [{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 5 }], totalPriceVnd: 5, orderId: "800001", shopId: 715_077_776, status: 0 });
  assert.deepEqual(requested, ["/shops/715077776/orders/800001"]);
  await assert.rejects(() => gateway.readOrder(715_077_776, "../1"), TypeError);
  await assert.rejects(() => gateway.readOrder(0, "800001"), TypeError);
  // A response that names another order is refused by the gateway itself, whatever its money says.
  const other = createPancakeOrderGateway({ getJson: async () => ({ data: { items: [item("v", 1, 5)], total_price: 5, id: 800002, shop_id: 715_077_776, status: 0 } }), postJson: async () => ({}) });
  await assert.rejects(() => other.readOrder(715_077_776, "800001"), PancakeOrderReadBackError);
  const broken = createPancakeOrderGateway({ getJson: async () => ({ data: {} }), postJson: async () => ({}) });
  await assert.rejects(() => broken.readOrder(715_077_776, "800001"), PancakeOrderReadBackError);
});
