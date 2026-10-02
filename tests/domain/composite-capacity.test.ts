import assert from "node:assert/strict";
import test from "node:test";

import { deriveCompositeCapacitySnapshot } from "../../src/commerce/composite-capacity.ts";

const component = (stock: number, requiredQuantity = 1) => ({
  requiredQuantity,
  componentVariant: {
    isPresent: true,
    product: { pancakeShopId: 1, isPresent: true },
    warehouseStocks: [{ quantity: stock }],
  },
});

test("composite flexible capacity stops exactly at the component floor", () => {
  const capacity = deriveCompositeCapacitySnapshot({
    shopId: 1,
    components: [component(-10)],
    sellingMode: "PREORDER",
    negativeStockLimit: -10,
  });

  assert.deepEqual(capacity, {
    readyQuantity: 0,
    reservableQuantity: 0,
    reason: "negative-limit-reached",
  });
});

test("composite capacity accounts for component multipliers without losing ready-stock semantics", () => {
  const capacity = deriveCompositeCapacitySnapshot({
    shopId: 1,
    components: [component(2, 2)],
    sellingMode: "PREORDER",
    negativeStockLimit: -20,
  });

  assert.deepEqual(capacity, {
    readyQuantity: 1,
    reservableQuantity: 11,
    reason: "capacity-available",
  });
});
