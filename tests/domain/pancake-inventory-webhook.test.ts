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

test("a variations_warehouses row, as the body, as data, or as a data array, names its pairs and nothing else", () => {
  const row = { variation_id: "v-1", warehouse_id: "w-1", remain_quantity: 999 };
  const expected = { ok: true, events: [{ variationId: "v-1", warehouseId: "w-1" }] };
  assert.deepEqual(parseVariationsWarehousesWebhook(row), expected);
  assert.deepEqual(parseVariationsWarehousesWebhook({ type: "variations_warehouses", data: row }), expected);
  assert.deepEqual(
    parseVariationsWarehousesWebhook({ data: [row, { variation_id: "v-2", warehouse_id: "w-1" }] }),
    { ok: true, events: [{ variationId: "v-1", warehouseId: "w-1" }, { variationId: "v-2", warehouseId: "w-1" }] },
  );
  // The quantity is never part of what the webhook contributes.
  assert.equal(JSON.stringify(parseVariationsWarehousesWebhook(row)).includes("999"), false);
});

test("another webhook type is accepted with no work; malformed or oversized payloads are rejected", () => {
  assert.deepEqual(parseVariationsWarehousesWebhook({ type: "orders", data: {} }), { ok: true, events: [] });
  for (const invalid of [
    null,
    [],
    "text",
    {},
    { data: [] },
    { variation_id: "v-1" },
    { variation_id: "", warehouse_id: "w-1" },
    { variation_id: " v-1", warehouse_id: "w-1" },
    { variation_id: 1, warehouse_id: "w-1" },
    { data: [{ variation_id: "v-1", warehouse_id: "w-1" }, "row"] },
  ]) {
    assert.deepEqual(parseVariationsWarehousesWebhook(invalid), { ok: false, reason: "malformed" }, JSON.stringify(invalid));
  }
  const tooMany = { data: Array.from({ length: 1_001 }, (_, i) => ({ variation_id: `v-${i}`, warehouse_id: "w" })) };
  assert.deepEqual(parseVariationsWarehousesWebhook(tooMany), { ok: false, reason: "too-large" });
});

test("the endpoint authenticates the custom secret header before reading anything", async () => {
  const { handle, recorded } = harness();
  const body = JSON.stringify({ variation_id: "v-1", warehouse_id: "w-1" });

  assert.equal((await handle(request(body), "")).status, 503, "disabled without a configured secret");
  assert.equal((await handle(request(body, {}))).status, 401, "missing header");
  assert.equal((await handle(request(body, { [PANCAKE_WEBHOOK_SECRET_HEADER]: "wrong" }))).status, 401);
  assert.equal((await handle(request(body, { [PANCAKE_WEBHOOK_SECRET_HEADER]: `${SECRET}x` }))).status, 401);
  assert.equal(recorded.length, 0);

  const accepted = await handle(request(body));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: 1 });
  assert.deepEqual(recorded, [{ events: [{ variationId: "v-1", warehouseId: "w-1" }], at: RECEIVED_AT }]);
});

test("an invalid payload is a 4xx and a fixed log line, never a thrown error or a recorded marker", async () => {
  const { handle, recorded, lines } = harness();
  assert.equal((await handle(request("{not json"))).status, 400);
  assert.equal((await handle(request(JSON.stringify({ variation_id: 42 })))).status, 400);
  assert.equal((await handle(request("x".repeat(300 * 1024)))).status, 413);
  assert.equal(recorded.length, 0);
  assert.ok(lines.every((line) => !line.includes("42") && !line.includes("{not")), "payloads are never echoed");
});

test("a marker store outage is a 503 so the sender can retry, and the handler still does not throw", async () => {
  const { handle, lines } = harness(async () => {
    throw new Error("database down: secret connection string");
  });
  const response = await handle(request(JSON.stringify({ variation_id: "v-1", warehouse_id: "w-1" })));
  assert.equal(response.status, 503);
  assert.equal(lines.some((line) => line.includes("secret connection")), false);
});
