import assert from "node:assert/strict";
import test from "node:test";
import { summarizeHistoricalOrderPricing } from "../../src/commerce/historical-list-price.ts";
const paid = {
  productName: "Set",
  color: null,
  size: "M",
  role: "PAID" as const,
  quantity: 2,
  unitPriceVnd: "562000",
  lineTotalVnd: "1124000",
  listUnitPriceVnd: "749000",
};
test("historical savings use frozen paid segments once, exclude gifts and suppress incomplete totals", () => {
  assert.equal(
    summarizeHistoricalOrderPricing([
      paid,
      {
        ...paid,
        role: "GIFT",
        quantity: 1,
        unitPriceVnd: "0",
        lineTotalVnd: "0",
        listUnitPriceVnd: null,
      },
    ]).savingVnd,
    "374000",
  );
  assert.equal(
    summarizeHistoricalOrderPricing([paid, { ...paid, listUnitPriceVnd: null }])
      .savingVnd,
    null,
  );
  assert.equal(
    summarizeHistoricalOrderPricing([{ ...paid, listUnitPriceVnd: "1" }])
      .savingVnd,
    null,
  );
  assert.equal(summarizeHistoricalOrderPricing([]).savingVnd, null);
});
