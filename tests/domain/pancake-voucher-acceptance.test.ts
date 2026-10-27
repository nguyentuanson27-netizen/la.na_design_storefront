import assert from "node:assert/strict";
import test from "node:test";

import { PancakeHttpError } from "../../src/integrations/pancake/client.ts";
import type { PancakeOrderReadBack } from "../../src/integrations/pancake/order-readback.ts";
import { deriveVendorLines, runVoucherAcceptance, VOUCHER_CASE_IDS, VOUCHER_CASES } from "../../scripts/pancake-voucher-acceptance.ts";
import { PROBE_APPROVAL_ENV, PROBE_PRODUCT_CODE_ENV, PROBE_VARIATION_ENV } from "../../scripts/pancake-gift-quantity-capability-probe.ts";
import type { ControlledAcceptanceClient } from "../../scripts/pancake-p10-custom-price-acceptance.ts";

/**
 * The voucher (H1-V) acceptance script, against a fake POS. It must never reach the network from here; what
 * is under test is the script's safety model and its verdicts: the production parser and comparison drive
 * every outcome, and no path leaves a created order open without saying so.
 */

const VARIATION = "11111111-2222-3333-4444-555555555555";
const SHOP_ID = 920007;
const ENV = {
  PANCAKE_API_KEY: "super-secret-api-key",
  PANCAKE_SHOP_ID: String(SHOP_ID),
  [PROBE_APPROVAL_ENV]: `shop:${SHOP_ID}`,
  [PROBE_VARIATION_ENV]: VARIATION,
  [PROBE_PRODUCT_CODE_ENV]: "FIXTURE-1",
} as const;

type Item = { variation_id: string; quantity: number; variation_info: { retail_price: number } };
type Behavior = "faithful" | "merge-average" | "reject" | "network" | "no-id" | "cancel-fails" | "status-not-applied" | "no-total";

function fakePos(behavior: Behavior, stock = 10) {
  const calls: string[] = [];
  const orders = new Map<number, { items: Item[]; status: number }>();
  let nextId = 7000;
  const client: ControlledAcceptanceClient = {
    async getJson(endpoint) {
      calls.push(`GET ${endpoint}`);
      return { data: [{ id: VARIATION, remain_quantity: stock }] };
    },
    async postJson() { throw new Error("the script must create through the gateway"); },
    async putJson() { throw new Error("the script must cancel through the gateway"); },
  } as ControlledAcceptanceClient;

  const readOrder = async (_shop: number, orderId: string): Promise<PancakeOrderReadBack> => {
    calls.push(`READ ${orderId}`);
    const order = orders.get(Number(orderId))!;
    const items = behavior === "merge-average"
      ? [{ variation_id: VARIATION, quantity: order.items.reduce((s, i) => s + i.quantity, 0), variation_info: { retail_price: Math.round(order.items.reduce((s, i) => s + i.quantity * i.variation_info.retail_price, 0) / order.items.reduce((s, i) => s + i.quantity, 0)) } }]
      : order.items;
    return {
      lines: items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
      totalPriceVnd: behavior === "no-total" ? null : items.reduce((s, i) => s + i.quantity * i.variation_info.retail_price, 0),
      orderId,
      shopId: SHOP_ID,
      status: order.status,
    };
  };

  const gateway = {
    async createOrder(request: { items: Item[] }) {
      calls.push("CREATE");
      if (behavior === "reject") throw new PancakeHttpError(422, "refused");
      if (behavior === "network") throw new Error("socket hang up");
      const id = nextId++;
      orders.set(id, { items: request.items, status: 0 });
      return behavior === "no-id" ? { success: true } : { data: { id } };
    },
    readOrder,
    async cancelOrder(_shop: number, orderId: string) {
      calls.push(`CANCEL ${orderId}`);
      if (behavior === "cancel-fails") throw new Error("Order cancellation readback failed");
      if (behavior !== "status-not-applied") orders.get(Number(orderId))!.status = 7;
    },
  };
  return { client, gateway, calls, orders };
}

const run = (pos: ReturnType<typeof fakePos>, env: Record<string, string | undefined> = ENV) =>
  runVoucherAcceptance(env, { client: pos.client, gateway: pos.gateway as never, newRunId: () => "abcdef123456", now: () => new Date("2026-10-26T00:00:00Z") });

test("the pinned fixtures are exactly what the production allocation and projection derive", () => {
  for (const id of VOUCHER_CASE_IDS) {
    const derived = deriveVendorLines(VOUCHER_CASES[id], VARIATION)!;
    assert.deepEqual(derived.map((l) => [l.quantity, l.unitPriceVnd]), VOUCHER_CASES[id].expectedVendorLines.map((l) => [l.quantity, l.unitPriceVnd]), id);
    assert.equal(derived.reduce((s, l) => s + l.quantity * l.unitPriceVnd, 0), VOUCHER_CASES[id].expectedTotalVnd, id);
  }
});

test("a faithful POS: every fixture MATCHes while open, reads back canceled, nothing stays open, one create per case", async () => {
  const pos = fakePos("faithful");
  const report = await run(pos);
  assert.equal(report.allCasesPassed, true);
  assert.equal(report.noOrderMayBeOpen, true);
  assert.deepEqual(report.cases.map((c) => [c.caseId, c.outcome, c.orderState, c.statusWhileOpen, c.statusAfterCancel]), VOUCHER_CASE_IDS.map((id) => [id, "PASS", "CREATED_CANCELLED", 0, 7]));
  assert.equal(pos.calls.filter((c) => c === "CREATE").length, VOUCHER_CASE_IDS.length);
  assert.equal(JSON.stringify(report).includes("super-secret-api-key"), false);
});

test("a POS that merges lines is a failure and its order is still cancelled", async () => {
  const report = await run(fakePos("merge-average"));
  assert.equal(report.allCasesPassed, false);
  assert.equal(report.cases[0]!.outcome, "FAIL_READBACK_NOT_MATCH");
  assert.equal(report.cases[0]!.orderState, "CREATED_CANCELLED");
  assert.equal(report.noOrderMayBeOpen, true);
});

test("an unproven cancellation is never a pass and stops the run", async () => {
  const report = await run(fakePos("cancel-fails"));
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0]!.outcome, "CLEANUP_NOT_CONFIRMED");
  assert.equal(report.noOrderMayBeOpen, false);
});

test("a definite 4xx refusal is recorded without an order; a network failure stops the run as unknown", async () => {
  const refused = await run(fakePos("reject"));
  assert.equal(refused.cases[0]!.outcome, "REJECTED_BY_POS");
  assert.equal(refused.noOrderMayBeOpen, true);
  const unknown = await run(fakePos("network"));
  assert.equal(unknown.cases.length, 1);
  assert.equal(unknown.cases[0]!.outcome, "UNKNOWN_RESPONSE");
  assert.equal(unknown.noOrderMayBeOpen, false);
});

test("refuses without the per-shop approval and when stock cannot cover the largest case", async () => {
  await assert.rejects(run(fakePos("faithful"), { ...ENV, [PROBE_APPROVAL_ENV]: undefined }));
  const pos = fakePos("faithful", 3);
  await assert.rejects(run(pos), /Insufficient sellable stock/);
  assert.equal(pos.calls.some((c) => c === "CREATE"), false);
});
