import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZED_CODES,
  AUTHORIZED_SHOP_ID,
  PancakeCapabilityProbeHarness,
  type ProbeApiClient,
} from "../../src/integrations/pancake/capability-probe.ts";
import { PancakeHttpError, PancakeNetworkError } from "../../src/integrations/pancake/client.ts";

type JsonRecord = Record<string, unknown>;

const IDS = {
  ordinary: "var-v8014-s",
  parent: "var-sv1683-s",
  ao: "var-sv1683-ao-s",
  vay: "var-sv1683-vay-s",
  warehouse: "wh-test",
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixtureVariations(): JsonRecord[] {
  const wh = (quantity: number) => [{ warehouse_id: IDS.warehouse, remain_quantity: quantity }];
  return [
    {
      id: IDS.ordinary,
      product_id: "prod-v8014",
      display_id: "V8014-S",
      product: { id: "prod-v8014", display_id: AUTHORIZED_CODES.ORDINARY },
      is_composite: false,
      variations_warehouses: wh(10),
    },
    {
      id: IDS.parent,
      product_id: "prod-sv1683",
      display_id: AUTHORIZED_CODES.COMPOSITE_PARENT,
      product: { id: "prod-sv1683", display_id: "SV1683" },
      is_composite: true,
      variations_warehouses: wh(0),
      composite_products: [
        {
          component_id: IDS.ao,
          quantity: 1,
          component: { id: IDS.ao, display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_AO },
        },
        {
          component_id: IDS.vay,
          quantity: 1,
          component: { id: IDS.vay, display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY },
        },
      ],
    },
    {
      id: IDS.ao,
      product_id: "prod-ao",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_AO,
      product: { id: "prod-ao", display_id: "SV1683-AO" },
      is_composite: false,
      variations_warehouses: wh(0),
    },
    {
      id: IDS.vay,
      product_id: "prod-vay",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY,
      product: { id: "prod-vay", display_id: "SV1683-VAY" },
      is_composite: false,
      variations_warehouses: wh(0),
    },
  ];
}

function createClient(options: {
  orderHttpStatus?: number;
  cleanupRegression?: boolean;
}): ProbeApiClient & { getOrderStatus(id: number): number | undefined; getOrderListCalls(): number } {
  const source = fixtureVariations();
  const stock: Record<string, number> = {
    [IDS.ordinary]: 10,
    [IDS.ao]: 0,
    [IDS.vay]: 0,
  };
  const orders: Array<{ id: number; status: number; note: string; shipping_address: { address: string } }> = [];
  let listCalls = 0;
  let nextOrderId = 100;

  const parentStock = () => Math.min(stock[IDS.ao] ?? 0, stock[IDS.vay] ?? 0);
  const materialize = (variation: JsonRecord): JsonRecord => {
    const id = String(variation.id);
    const quantity = id === IDS.parent ? parentStock() : (stock[id] ?? 0);
    return {
      ...variation,
      remain_quantity: quantity,
      variations_warehouses: [{ warehouse_id: IDS.warehouse, remain_quantity: quantity }],
    };
  };

  function createOrder(body: unknown) {
    const record = isRecord(body) ? body : {};
    const items = Array.isArray(record.items) ? record.items : [];
    const firstItem = isRecord(items[0]) ? items[0] : {};
    const variationId = String(firstItem.variation_id ?? "");
    const quantity = typeof firstItem.quantity === "number" ? firstItem.quantity : 1;
    if (variationId === IDS.parent) {
      stock[IDS.ao] = (stock[IDS.ao] ?? 0) - quantity;
      stock[IDS.vay] = (stock[IDS.vay] ?? 0) - quantity;
    } else if (variationId in stock) {
      stock[variationId] = (stock[variationId] ?? 0) - quantity;
    }
    const shippingAddress = isRecord(record.shipping_address) ? record.shipping_address : {};
    const order = {
      id: nextOrderId++,
      status: 0,
      note: typeof record.note === "string" ? record.note : "",
      shipping_address: {
        address: typeof shippingAddress.address === "string" ? shippingAddress.address : "",
      },
    };
    orders.push(order);
    return order;
  }

  const client: ProbeApiClient & {
    getOrderStatus(id: number): number | undefined;
    getOrderListCalls(): number;
  } = {
    getOrderStatus(id) {
      return orders.find((order) => order.id === id)?.status;
    },
    getOrderListCalls() {
      return listCalls;
    },
    async getJson(endpoint, query = {}) {
      if (endpoint.includes("/products/variations")) {
        const variationId = query["variation_ids[]"];
        const data = source
          .filter((variation) => variationId === undefined || variation.id === variationId)
          .map(materialize);
        return { data, total_pages: 1 };
      }

      const byId = endpoint.match(/\/orders\/(\d+)$/);
      if (byId) {
        const id = Number(byId[1]);
        const order = orders.find((candidate) => candidate.id === id);
        return { data: order ?? { id, status: 7 } };
      }

      if (endpoint.endsWith("/orders")) {
        listCalls += 1;
        if (!options.cleanupRegression) return { data: [], total_pages: 1 };
        if (listCalls === 1) {
          return { data: orders.filter((order) => order.id === 100), total_pages: 1 };
        }
        const s0 = orders.find((order) => order.id === 100);
        const duplicateS0 = s0
          ? { ...s0, id: 999, status: 7 }
          : { id: 999, status: 7, note: "G2-PROBE-cleanup-S0", shipping_address: { address: "" } };
        return { data: [...orders, duplicateS0], total_pages: 1 };
      }

      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async postJson(endpoint, body) {
      if (endpoint.includes("/update_quantity")) {
        const variationId = endpoint.split("/variations/")[1]!.split("/")[0]!;
        const record = isRecord(body) ? body : {};
        const rows = Array.isArray(record.variations_warehouses) ? record.variations_warehouses : [];
        const row = isRecord(rows[0]) ? rows[0] : {};
        stock[variationId] = Number(row.remain_quantity);
        return { success: true };
      }

      if (endpoint.endsWith("/orders")) {
        if (options.orderHttpStatus !== undefined) {
          throw new PancakeHttpError(options.orderHttpStatus, endpoint);
        }
        const order = createOrder(body);
        if (options.cleanupRegression && order.note.includes("-S1")) {
          throw new PancakeNetworkError(endpoint);
        }
        return order;
      }

      throw new Error(`Unexpected POST ${endpoint}`);
    },
    async putJson(endpoint) {
      const id = Number(endpoint.match(/\/orders\/(\d+)$/)?.[1]);
      const order = orders.find((candidate) => candidate.id === id);
      if (order) order.status = 7;
      return { data: { status: 7 } };
    },
  };

  return client;
}

for (const status of [400, 401, 403, 404, 422]) {
  test(`generic HTTP ${status} non-write never becomes capability UNSUPPORTED`, async () => {
    const client = createClient({ orderHttpStatus: status });
    const harness = new PancakeCapabilityProbeHarness({
      client,
      isDryRun: false,
      runId: `http-${status}`,
    });

    const results = await harness.runAllScenarios();
    assert.equal(results.length, 7);
    assert.equal(results[0]?.classification, "NOT PROBED");
    assert.equal(results[3]?.classification, "NOT PROBED");
    assert.equal(
      results.some((result) => result.classification === "UNSUPPORTED"),
      false,
      "generic request/auth/routing/validation failures are not stock-capability evidence",
    );
  });
}

test("cleanup continues past an ambiguous marker and still cancels a later active order", async () => {
  const client = createClient({ cleanupRegression: true });
  const harness = new PancakeCapabilityProbeHarness({
    client,
    isDryRun: false,
    runId: "cleanup",
  });

  await assert.rejects(() => harness.runAllScenarios());
  assert.equal(client.getOrderStatus(101), 7, "later marker order must still be cancelled");
  assert.ok(
    client.getOrderListCalls() >= 6,
    "final reconciliation/sweep must still run after cleanup reports marker ambiguity",
  );
});
