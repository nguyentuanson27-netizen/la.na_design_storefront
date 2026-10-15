import assert from "node:assert/strict";
import test from "node:test";

import { PancakeHttpError } from "../../src/integrations/pancake/client.ts";
import type { PancakeOrderReadBack } from "../../src/integrations/pancake/order-readback.ts";
import { ADAPTER_CASE_IDS, runAdapterAcceptance } from "../../scripts/pancake-gift-quantity-adapter-acceptance.ts";
import { PROBE_APPROVAL_ENV, PROBE_PRODUCT_CODE_ENV, PROBE_VARIATION_ENV } from "../../scripts/pancake-gift-quantity-capability-probe.ts";
import type { ControlledAcceptanceClient } from "../../scripts/pancake-p10-custom-price-acceptance.ts";

/**
 * The adapter-flow acceptance script, against a fake POS. It must never reach the network from here; what
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
  runAdapterAcceptance(env, { client: pos.client, gateway: pos.gateway as never, newRunId: () => "abcdef123456", now: () => new Date("2026-10-15T00:00:00Z") });

test("a faithful POS: both cases MATCH while open, read back as canceled afterwards, and nothing stays open", async () => {
  const pos = fakePos("faithful");
  const report = await run(pos);
  assert.equal(report.allCasesPassed, true);
  assert.equal(report.noOrderMayBeOpen, true);
  assert.deepEqual(report.cases.map((c) => [c.caseId, c.outcome, c.orderState, c.verdictWhileOpen, c.verdictAfterCancel]), ADAPTER_CASE_IDS.map((id) => [id, "PASS", "CREATED_CANCELLED", "MATCH", "DRIFT: the POS order is canceled"]));
  // The projection really went out: D-08 turned the gift case into 99.000đ + 1.000đ.
  assert.deepEqual(report.cases[1]!.sentLines.map((l) => [l.quantity, l.unitPriceVnd]).sort(), [[1, 1_000], [1, 99_000]]);
  assert.deepEqual(report.cases[0]!.sentLines.map((l) => [l.quantity, l.unitPriceVnd]).sort(), [[1, 90_001], [2, 100_001]]);
  assert.equal(pos.calls.filter((c) => c === "CREATE").length, 2, "one create per case, never a retry");
  assert.equal(JSON.stringify(report).includes("super-secret-api-key"), false);
});

test("a POS that merges the two prices is a failure, and its order is still cancelled", async () => {
  const pos = fakePos("merge-average");
  const report = await run(pos);
  assert.equal(report.allCasesPassed, false);
  assert.equal(report.cases[0]!.outcome, "FAIL_READBACK_NOT_MATCH");
  assert.match(report.cases[0]!.verdictWhileOpen, /^DRIFT/);
  assert.equal(report.cases[0]!.orderState, "CREATED_CANCELLED");
  assert.equal(report.noOrderMayBeOpen, true);
});

test("an order total the POS does not report cannot be confirmed (UNAVAILABLE), so it is not a pass", async () => {
  const report = await run(fakePos("no-total"));
  assert.equal(report.cases[0]!.outcome, "FAIL_READBACK_NOT_MATCH");
  assert.match(report.cases[0]!.verdictWhileOpen, /^UNAVAILABLE/);
});

test("a cancellation that cannot be proven is never a pass, leaves noOrderMayBeOpen false and stops the run", async () => {
  const pos = fakePos("cancel-fails");
  const report = await run(pos);
  assert.equal(report.cases.length, 1, "no second order is created on top of an open one");
  assert.equal(report.cases[0]!.outcome, "CLEANUP_NOT_CONFIRMED");
  assert.equal(report.cases[0]!.orderState, "CREATED_CLEANUP_UNCONFIRMED");
  assert.equal(report.noOrderMayBeOpen, false);
  assert.equal(report.allCasesPassed, false);
});

test("a cancel the POS acknowledges but does not apply is caught by the production cancel's own read-back", async () => {
  const pos = fakePos("status-not-applied");
  // The real gateway throws here; the fake gateway mirrors that by reporting an unapplied status.
  pos.gateway.cancelOrder = async (_shop: number, orderId: string) => { pos.calls.push(`CANCEL ${orderId}`); throw new Error("cancellation readback expected status 7, observed 0"); };
  const report = await run(pos);
  assert.equal(report.cases[0]!.outcome, "CLEANUP_NOT_CONFIRMED");
  assert.equal(report.noOrderMayBeOpen, false);
});

test("a refusal creates nothing and is reported as such; an unknown create stops the run and says do not retry", async () => {
  const refused = await run(fakePos("reject"));
  assert.deepEqual(refused.cases.map((c) => [c.outcome, c.orderState]), [["REJECTED_BY_POS", "NOT_CREATED"], ["REJECTED_BY_POS", "NOT_CREATED"]]);
  assert.equal(refused.noOrderMayBeOpen, true);
  assert.equal(refused.allCasesPassed, false);

  const network = await run(fakePos("network"));
  assert.equal(network.cases.length, 1);
  assert.deepEqual([network.cases[0]!.outcome, network.cases[0]!.orderState], ["UNKNOWN_RESPONSE", "CREATION_UNKNOWN"]);
  assert.match(network.cases[0]!.note, /Do NOT retry/);
  assert.equal(network.noOrderMayBeOpen, false);

  const noId = await run(fakePos("no-id"));
  assert.equal(noId.cases[0]!.orderState, "CREATION_UNKNOWN");
});

test("nothing is created without explicit approval for this exact shop, in CI, or with too little stock", async () => {
  const pos = fakePos("faithful");
  await assert.rejects(run(pos, { ...ENV, [PROBE_APPROVAL_ENV]: undefined }), /explicit operator approval/);
  await assert.rejects(run(pos, { ...ENV, [PROBE_APPROVAL_ENV]: "shop:1" }), /explicit operator approval/);
  await assert.rejects(run(pos, { ...ENV, CI: "true" }), /CI/i);
  await assert.rejects(run(fakePos("faithful", 2)), /Insufficient sellable stock/);
  assert.equal(pos.calls.includes("CREATE"), false);
});
