import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePancakeInventoryWebhook,
  PANCAKE_WEBHOOK_SECRET_HEADER,
  parseVariationsWarehousesWebhook,
  type InventoryWebhookEvent,
} from "../../src/commerce/pancake-inventory-signals.ts";

const SECRET = "webhook-secret-for-tests-0123456789";
const RECEIVED_AT = new Date("2026-09-28T09:00:00.000Z");

function request(body: string, headers: Record<string, string> = { [PANCAKE_WEBHOOK_SECRET_HEADER]: SECRET }) {
  return new Request("http://127.0.0.1/api/pancake/inventory-webhook", { method: "POST", body, headers });
}

function harness(record: (events: readonly InventoryWebhookEvent[], at: Date) => Promise<void> = async () => {}) {
  const lines: string[] = [];
  const recorded: { events: readonly InventoryWebhookEvent[]; at: Date }[] = [];
  return {
    lines,
    recorded,
    handle: (req: Request, secret: string = SECRET) =>
      handlePancakeInventoryWebhook(req, {
        secret,
        record: async (events, at) => {
          recorded.push({ events, at });
          await record(events, at);
        },
        now: () => RECEIVED_AT,
        log: (line) => lines.push(line),
      }),
  };
}

/** A delivery in the exact `WebhookInventoryResponse` shape from the Pancake POS OpenAPI. */
function inventoryDelivery(record: Record<string, unknown>) {
  return { data: { record, success: true } };
}

const RECORD = {
  variation_id: "v-1",
  warehouse_id: "w-1",
  remain_quantity: 999,
  actual_remain_quantity: 999,
  change_quantity: -1,
  is_actual_remain_quantity: false,
  inserted_at: "2026-09-28T08:59:59Z",
  type: "order",
};

test("a variations_warehouses delivery names its (variation, warehouse) pair and nothing else", () => {
  assert.deepEqual(parseVariationsWarehousesWebhook(inventoryDelivery(RECORD)), {
    ok: true,
    events: [{ variationId: "v-1", warehouseId: "w-1" }],
  });
  // The quantity (and every other record field) is never part of what the webhook contributes.
  assert.equal(JSON.stringify(parseVariationsWarehousesWebhook(inventoryDelivery(RECORD))).includes("999"), false);
});

test("other webhook types sharing the URL are acknowledged with no work", () => {
  for (const other of [
    { data: { record: { id: "product-1", name: "Tee", variations: [] }, success: true } },
    { id: "order-1", status: 1 },
    { type: "auto_call", shop_id: 47, order_id: "o-1", answered: true },
    { data: { success: true } },
  ]) {
    assert.deepEqual(parseVariationsWarehousesWebhook(other), { ok: true, events: [] }, JSON.stringify(other));
  }
});

test("an inventory record with unusable ids, or a non-object body, is malformed", () => {
  for (const invalid of [
    null,
    [],
    "text",
    inventoryDelivery({ variation_id: "v-1" }),
    inventoryDelivery({ warehouse_id: "w-1" }),
    inventoryDelivery({ variation_id: "", warehouse_id: "w-1" }),
    inventoryDelivery({ variation_id: " v-1", warehouse_id: "w-1" }),
    inventoryDelivery({ variation_id: 1, warehouse_id: "w-1" }),
    inventoryDelivery({ variation_id: "v".repeat(513), warehouse_id: "w-1" }),
  ]) {
    assert.deepEqual(parseVariationsWarehousesWebhook(invalid), { ok: false, reason: "malformed" }, JSON.stringify(invalid)?.slice(0, 80));
  }
});

test("the endpoint authenticates the custom secret header before reading anything", async () => {
  const { handle, recorded } = harness();
  const body = JSON.stringify(inventoryDelivery(RECORD));

  assert.equal((await handle(request(body), "")).status, 503, "disabled without a configured secret");
  assert.equal((await handle(request(body, {}))).status, 401, "missing header");
  assert.equal((await handle(request(body, { [PANCAKE_WEBHOOK_SECRET_HEADER]: "wrong" }))).status, 401);
  assert.equal((await handle(request(body, { [PANCAKE_WEBHOOK_SECRET_HEADER]: `${SECRET}x` }))).status, 401);
  assert.equal(recorded.length, 0);

  const accepted = await handle(request(body));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: 1 });
  assert.deepEqual(recorded, [{ events: [{ variationId: "v-1", warehouseId: "w-1" }], at: RECEIVED_AT }]);
});

test("an invalid payload is a 4xx and a fixed log line, never a thrown error or a recorded marker", async () => {
  const { handle, recorded, lines } = harness();
  assert.equal((await handle(request("{not json"))).status, 400);
  assert.equal((await handle(request(JSON.stringify(inventoryDelivery({ variation_id: 42, warehouse_id: "w" }))))).status, 400);
  assert.equal((await handle(request("x".repeat(300 * 1024)))).status, 413);
  assert.equal(recorded.length, 0);
  assert.ok(lines.every((line) => !line.includes("42") && !line.includes("{not")), "payloads are never echoed");
});

test("a marker store outage is a 503 so the sender can retry, and the handler still does not throw", async () => {
  const { handle, lines } = harness(async () => {
    throw new Error("database down: secret connection string");
  });
  const response = await handle(request(JSON.stringify(inventoryDelivery(RECORD))));
  assert.equal(response.status, 503);
  assert.equal(lines.some((line) => line.includes("secret connection")), false);
});
