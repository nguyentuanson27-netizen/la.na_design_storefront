import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZED_CODES,
  AUTHORIZED_SHOP_ID,
  AmbiguousWriteError,
  CapabilityProbeGuardError,
  CleanupFailureError,
  MAX_MUTATION_BUDGET,
  MutationTracker,
  PancakeCapabilityProbeHarness,
  cancelProbeOrder,
  discoverAndValidateProbeTargets,
  fetchVariationStock,
  sanitizeSecrets,
  searchOrderByMarker,
  setVariationStockSafely,
  submitProbeOrder,
  type ProbeApiClient,
  type ResolvedProbeTargets,
} from "../../src/integrations/pancake/capability-probe.ts";
import { PancakeHttpError, PancakeNetworkError } from "../../src/integrations/pancake/client.ts";
import { assertTrustedProbeEnvironment } from "../../scripts/pancake-capability-probe.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const IDS = {
  ordinary: "var-v8014-s",
  parent: "var-sv1683-s",
  ao: "var-sv1683-ao-s",
  vay: "var-sv1683-vay-s",
  warehouse: "wh-test",
} as const;

function variations(overrides: { ordinary?: number; ao?: number; vay?: number } = {}): JsonRecord[] {
  const ordinary = overrides.ordinary ?? 10;
  const ao = overrides.ao ?? 0;
  const vay = overrides.vay ?? 0;
  const parent = Math.min(ao, vay);
  const wh = (quantity: number) => [{ warehouse_id: IDS.warehouse, remain_quantity: quantity }];
  return [
    {
      id: IDS.ordinary,
      product_id: "prod-v8014",
      display_id: "V8014-S",
      product: { id: "prod-v8014", display_id: "V8014" },
      is_composite: false,
      remain_quantity: ordinary,
      variations_warehouses: wh(ordinary),
    },
    {
      id: IDS.parent,
      product_id: "prod-sv1683",
      display_id: AUTHORIZED_CODES.COMPOSITE_PARENT,
      product: { id: "prod-sv1683", display_id: "SV1683" },
      is_composite: true,
      remain_quantity: parent,
      variations_warehouses: wh(parent),
      composite_products: [
        { component_id: IDS.ao, quantity: 1, component: { id: IDS.ao, display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_AO } },
        { component_id: IDS.vay, quantity: 1, component: { id: IDS.vay, display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY } },
      ],
    },
    {
      id: IDS.ao,
      product_id: "prod-ao",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_AO,
      product: { id: "prod-ao", display_id: "SV1683-AO" },
      is_composite: false,
      remain_quantity: ao,
      variations_warehouses: wh(ao),
    },
    {
      id: IDS.vay,
      product_id: "prod-vay",
      display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY,
      product: { id: "prod-vay", display_id: "SV1683-VAY" },
      is_composite: false,
      remain_quantity: vay,
      variations_warehouses: wh(vay),
    },
  ];
}

type MockOptions = {
  sourceVariations?: JsonRecord[];
  stock?: Partial<Record<string, number>>;
  stockWriteError?: Error;
  stockWriteApplyBeforeError?: boolean;
  orderError?: Error;
  orderErrorCreatesOrder?: boolean;
  orderListHiddenCalls?: number;
  cancelWriteError?: Error;
  cancelWriteApplyBeforeError?: boolean;
  cancelReadbackStatus?: number;
  cancelReadbackError?: boolean;
  orderPages?: (page: number) => { data: JsonRecord[]; total_pages: number } | null;
};

function createMockClient(options: MockOptions = {}): ProbeApiClient {
  const source = options.sourceVariations ?? variations();
  const stock: Record<string, number> = {
    [IDS.ordinary]: 10,
    [IDS.ao]: 0,
    [IDS.vay]: 0,
    ...options.stock,
  };
  const orders: JsonRecord[] = [];
  let nextOrderId = 100;
  let orderListCalls = 0;

  const parentStock = () => Math.min(stock[IDS.ao] ?? 0, stock[IDS.vay] ?? 0);
  const materialize = (v: JsonRecord): JsonRecord => {
    const id = String(v.id);
    const quantity = id === IDS.parent ? parentStock() : (stock[id] ?? 0);
    return {
      ...v,
      remain_quantity: quantity,
      variations_warehouses: [{ warehouse_id: IDS.warehouse, remain_quantity: quantity }],
    };
  };

  function createOrder(body: unknown): JsonRecord {
    const record = isRecord(body) ? body : {};
    const items = Array.isArray(record.items) ? record.items : [];
    const line = isRecord(items[0]) ? items[0] : {};
    const variationId = String(line.variation_id ?? "");
    const quantity = typeof line.quantity === "number" ? line.quantity : 1;
    if (variationId === IDS.parent) {
      stock[IDS.ao] = (stock[IDS.ao] ?? 0) - quantity;
      stock[IDS.vay] = (stock[IDS.vay] ?? 0) - quantity;
    } else if (variationId in stock) {
      stock[variationId] = (stock[variationId] ?? 0) - quantity;
    }
    const order = {
      id: nextOrderId++,
      status: 0,
      note: record.note,
      shipping_address: record.shipping_address,
    };
    orders.push(order);
    return order;
  }

  return {
    async getJson(endpoint, query = {}) {
      if (endpoint.includes("/products/variations")) {
        const variationId = query["variation_ids[]"];
        const data = source
          .filter((v) => variationId === undefined || v.id === variationId)
          .map(materialize);
        return { data, total_pages: 1 };
      }
      const orderById = endpoint.match(/\/orders\/(\d+)$/);
      if (orderById) {
        if (options.cancelReadbackError) throw new PancakeNetworkError(endpoint);
        const order = orders.find((candidate) => String(candidate.id) === orderById[1]);
        return {
          data: {
            ...(order ?? { id: Number(orderById[1]) }),
            status: options.cancelReadbackStatus ?? order?.status ?? 7,
          },
        };
      }
      if (endpoint.endsWith("/orders")) {
        orderListCalls += 1;
        const page = Number(query.page_number ?? 1);
        const custom = options.orderPages?.(page);
        if (custom) return custom;
        if (orderListCalls <= (options.orderListHiddenCalls ?? 0)) {
          return { data: [], total_pages: 1 };
        }
        return { data: orders, total_pages: 1 };
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async postJson(endpoint, body) {
      if (endpoint.includes("/update_quantity")) {
        const variationId = endpoint.split("/variations/")[1]!.split("/")[0]!;
        const record = isRecord(body) ? body : {};
        const rows = Array.isArray(record.variations_warehouses) ? record.variations_warehouses : [];
        const row = isRecord(rows[0]) ? rows[0] : {};
        const desired = Number(row.remain_quantity);
        if (options.stockWriteApplyBeforeError) stock[variationId] = desired;
        if (options.stockWriteError) throw options.stockWriteError;
        stock[variationId] = desired;
        return { success: true };
      }
      if (endpoint.endsWith("/orders")) {
        if (options.orderErrorCreatesOrder) createOrder(body);
        if (options.orderError) throw options.orderError;
        return createOrder(body);
      }
      throw new Error(`Unexpected POST ${endpoint}`);
    },
    async putJson(endpoint) {
      const orderId = endpoint.split("/orders/")[1]!;
      const order = orders.find((candidate) => String(candidate.id) === orderId);
      if (options.cancelWriteApplyBeforeError && order) order.status = 7;
      if (options.cancelWriteError) throw options.cancelWriteError;
      if (order) order.status = 7;
      return { data: { status: 7 } };
    },
  };
}

async function targetsFor(client: ProbeApiClient): Promise<ResolvedProbeTargets> {
  return discoverAndValidateProbeTargets(client, AUTHORIZED_SHOP_ID);
}

test("generic sanitizer redacts query, key/value, bearer and hex-like secrets", () => {
  const dirty =
    'https://x.test?a=1&api_key=fake_secret_123 token=fake_token Authorization: Bearer abcdefghijkl "access_token":"fake_access" deadbeefdeadbeefdeadbeefdeadbeef';
  const clean = sanitizeSecrets(dirty);
  assert.equal(clean.includes("fake_secret_123"), false);
  assert.equal(clean.includes("fake_token"), false);
  assert.equal(clean.includes("fake_access"), false);
  assert.equal(clean.includes("abcdefghijkl"), false);
  assert.equal(clean.includes("deadbeefdeadbeefdeadbeefdeadbeef"), false);
});

test("probe environment refuses CI and refuses execution until credential rotation is attested", () => {
  assert.throws(() => assertTrustedProbeEnvironment({ CI: "true", PANCAKE_PROBE_CREDENTIAL_ROTATED: "true" }), /refuses CI/);
  assert.throws(() => assertTrustedProbeEnvironment({}), /CREDENTIAL_ROTATED/);
  assert.doesNotThrow(() => assertTrustedProbeEnvironment({ PANCAKE_PROBE_CREDENTIAL_ROTATED: "true" }));
});

test("target discovery resolves exact authorized variations and one common warehouse", async () => {
  const target = await targetsFor(createMockClient());
  assert.equal(target.ordinary.variationId, IDS.ordinary);
  assert.equal(target.compositeChildAo.variationId, IDS.ao);
  assert.equal(target.compositeChildVay.variationId, IDS.vay);
  assert.equal(target.ordinary.warehouseId, IDS.warehouse);
});

test("target discovery rejects parent relation pointing at a different child size", async () => {
  const source = variations();
  source.push({
    id: "var-ao-m",
    product_id: "prod-ao",
    display_id: "SV1683-AO-M",
    product: { id: "prod-ao", display_id: "SV1683-AO" },
    is_composite: false,
    variations_warehouses: [{ warehouse_id: IDS.warehouse, remain_quantity: 0 }],
  });
  const parent = source.find((v) => v.id === IDS.parent)!;
  parent.composite_products = [
    { component_id: "var-ao-m", quantity: 1, component: { id: "var-ao-m", display_id: "SV1683-AO-M" } },
    { component_id: IDS.vay, quantity: 1, component: { id: IDS.vay, display_id: AUTHORIZED_CODES.COMPOSITE_CHILD_VAY } },
  ];
  await assert.rejects(() => targetsFor(createMockClient({ sourceVariations: source })), CapabilityProbeGuardError);
});

test("target discovery rejects ordinary variation attached to another product", async () => {
  const source = variations();
  const ordinary = source.find((v) => v.id === IDS.ordinary)!;
  ordinary.product = { id: "other", display_id: "OTHER" };
  await assert.rejects(() => targetsFor(createMockClient({ sourceVariations: source })), /does not belong/);
});

test("stock mutation reconciles network failure when desired state was actually applied", async () => {
  const client = createMockClient({
    stockWriteError: new PancakeNetworkError("/stock"),
    stockWriteApplyBeforeError: true,
  });
  const targets = await targetsFor(client);
  const result = await setVariationStockSafely(client, new MutationTracker(), targets, IDS.ordinary, IDS.warehouse, 3);
  assert.equal(result.outcome, "RECONCILED_APPLIED");
  assert.equal(result.after, 3);
});

test("stock mutation reconciles network failure when no state changed", async () => {
  const client = createMockClient({ stockWriteError: new PancakeNetworkError("/stock") });
  const targets = await targetsFor(client);
  const result = await setVariationStockSafely(client, new MutationTracker(), targets, IDS.ordinary, IDS.warehouse, 3);
  assert.equal(result.outcome, "RECONCILED_NOT_APPLIED");
  assert.equal(result.after, 10);
});

test("stock mutation treats contradictory deterministic rejection plus changed stock as ambiguous", async () => {
  const client = createMockClient({
    stockWriteError: new PancakeHttpError(422, "/stock"),
    stockWriteApplyBeforeError: true,
  });
  const targets = await targetsFor(client);
  await assert.rejects(
    () => setVariationStockSafely(client, new MutationTracker(), targets, IDS.ordinary, IDS.warehouse, 3),
    AmbiguousWriteError,
  );
});

test("uncertain order error reconciles a remotely created order", async () => {
  const client = createMockClient({
    orderError: new PancakeHttpError(500, "/orders"),
    orderErrorCreatesOrder: true,
  });
  const targets = await targetsFor(client);
  const result = await submitProbeOrder(client, new MutationTracker(), targets, IDS.ordinary, 1, 599_000, "runx", "S0");
  assert.equal(result.ambiguous, false);
  assert.ok(result.orderId);
  assert.equal(result.rawOutcome, "RECONCILED_ACCEPTED");
});

test("uncertain order error with no marker remains ambiguous, not unsupported", async () => {
  const client = createMockClient({ orderError: new PancakeNetworkError("/orders") });
  const targets = await targetsFor(client);
  const result = await submitProbeOrder(client, new MutationTracker(), targets, IDS.ordinary, 1, 599_000, "runx", "S0");
  assert.equal(result.orderId, null);
  assert.equal(result.ambiguous, true);
  assert.match(result.rawOutcome, /^AMBIGUOUS_WRITE/);
});

test("deterministic 422 order rejection is classified as a definite non-write", async () => {
  const client = createMockClient({ orderError: new PancakeHttpError(422, "/orders") });
  const targets = await targetsFor(client);
  const result = await submitProbeOrder(client, new MutationTracker(), targets, IDS.ordinary, 1, 599_000, "runx", "S0");
  assert.equal(result.ambiguous, false);
  assert.equal(result.orderId, null);
  assert.equal(result.rawOutcome, "HTTP_NON_CAPABILITY_REJECTION_422");
  // The point of the split: a deterministic HTTP rejection is certain about the *write* and says
  // nothing about the *capability*. Pinning both fields here is what stops a future change from
  // quietly reading a generic 422 back as evidence that zero/negative stock is unsupported.
  assert.equal(result.writeCertainty, "DEFINITE_NO_WRITE");
  assert.equal(result.capabilityEvidence, "NONE");
});

test("marker search follows total_pages even when page 1 is short", async () => {
  const marker = "G2-PROBE-page2-S0";
  const client = createMockClient({
    orderPages: (page) => {
      if (page === 1) return { data: [{ id: 1, note: "other" }], total_pages: 2 };
      return { data: [{ id: 999, note: marker }], total_pages: 2 };
    },
  });
  assert.deepEqual(await searchOrderByMarker(client, AUTHORIZED_SHOP_ID, marker), { kind: "FOUND", orderId: "999" });
});

test("marker search refuses contradictory pagination metadata", async () => {
  const client = createMockClient({
    orderPages: (page) => ({ data: [], total_pages: page - 1 }),
  });
  const result = await searchOrderByMarker(client, AUTHORIZED_SHOP_ID, "missing");
  assert.equal(result.kind, "AMBIGUOUS");
});

test("marker search refuses to claim absence when reported pages exceed the bounded search", async () => {
  const client = createMockClient({
    orderPages: (page) => ({
      data: Array.from({ length: 50 }, (_, i) => ({ id: page * 100 + i, note: "other" })),
      total_pages: 10,
    }),
  });
  const result = await searchOrderByMarker(client, AUTHORIZED_SHOP_ID, "missing");
  assert.equal(result.kind, "AMBIGUOUS");
});

test("cancellation always validates independent readback", async () => {
  const client = createMockClient({ cancelReadbackStatus: 1 });
  await assert.rejects(
    () => cancelProbeOrder(client, new MutationTracker(), AUTHORIZED_SHOP_ID, "123"),
    CleanupFailureError,
  );
});

test("cancellation accepts lost PUT response only after readback proves status 7", async () => {
  const client = createMockClient({
    cancelWriteError: new PancakeNetworkError("/orders/100"),
    cancelWriteApplyBeforeError: true,
  });
  const targets = await targetsFor(client);
  const submission = await submitProbeOrder(
    client,
    new MutationTracker(),
    targets,
    IDS.ordinary,
    1,
    599_000,
    "cancel-lost",
    "S0",
  );
  assert.ok(submission.orderId);
  await assert.doesNotReject(() =>
    cancelProbeOrder(client, new MutationTracker(), AUTHORIZED_SHOP_ID, submission.orderId!),
  );
});

test("dry-run produces only NOT PROBED evidence with zero mutations", async () => {
  const tracker = new MutationTracker();
  const harness = new PancakeCapabilityProbeHarness({ client: createMockClient(), tracker, isDryRun: true, runId: "dry" });
  const results = await harness.runAllScenarios();
  assert.equal(results.length, 7);
  assert.equal(tracker.mutationCount, 0);
  for (const result of results) {
    assert.equal(result.classification, "NOT PROBED");
    assert.equal(result.apiOutcome, "DRY_RUN");
    assert.equal(result.submissions, 0);
    assert.equal(result.remoteOrderCreated, "no");
  }
});

test("live bounded mock run restores all inventory and stays inside the mutation budget", async () => {
  const tracker = new MutationTracker();
  const client = createMockClient();
  const harness = new PancakeCapabilityProbeHarness({ client, tracker, isDryRun: false, runId: "live" });
  const results = await harness.runAllScenarios();
  assert.equal(results.length, 7);
  assert.ok(tracker.mutationCount <= MAX_MUTATION_BUDGET);
  await harness.verifyFinalReconciliation();
});

test("runAllScenarios executes cleanup in finally after an ambiguous order failure", async () => {
  const client = createMockClient({
    stock: { [IDS.ordinary]: 0 },
    orderError: new PancakeNetworkError("/orders"),
  });
  const harness = new PancakeCapabilityProbeHarness({ client, isDryRun: false, runId: "ambiguous" });
  await assert.rejects(() => harness.runAllScenarios(), AmbiguousWriteError);
  const targets = await targetsFor(client);
  const stock = await fetchVariationStock(client, targets, IDS.ordinary);
  assert.equal(stock.remainQuantity, 0, "finally cleanup must restore the pre-run ordinary baseline");
});

test("cleanup re-searches attempted marker and cancels an order that becomes visible late", async () => {
  const client = createMockClient({
    orderError: new PancakeNetworkError("/orders"),
    orderErrorCreatesOrder: true,
    orderListHiddenCalls: 1,
  });
  const harness = new PancakeCapabilityProbeHarness({ client, isDryRun: false, runId: "late" });
  await assert.rejects(() => harness.runAllScenarios(), AmbiguousWriteError);
  const markerResult = await searchOrderByMarker(client, AUTHORIZED_SHOP_ID, "G2-PROBE-late-S0");
  assert.equal(markerResult.kind, "FOUND");
  if (markerResult.kind !== "FOUND") return;
  const raw = await client.getJson(`/shops/${AUTHORIZED_SHOP_ID}/orders/${markerResult.orderId}`);
  const record = isRecord(raw) && isRecord(raw.data) ? raw.data : isRecord(raw) ? raw : null;
  assert.equal(record?.status, 7);
});
