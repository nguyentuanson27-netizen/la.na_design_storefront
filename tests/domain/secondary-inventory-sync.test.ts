import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSku,
  purgeSecondaryWarehouseStock,
  syncSecondaryShopInventory,
} from "../../src/commerce/secondary-inventory-sync.ts";
import { writeObservedWarehouseStocks } from "../../src/commerce/catalog-mirror-repository.ts";
import {
  secondaryWarehouseKey,
  warehouseStockKey,
} from "../../src/commerce/warehouse-stock-scope.ts";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";

test("normalizeSku trims whitespace and converts to uppercase", () => {
  assert.equal(normalizeSku("  svd468-ao-xl  "), "SVD468-AO-XL");
  assert.equal(normalizeSku("Sq069-s"), "SQ069-S");
  assert.equal(normalizeSku(""), null);
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku(null), null);
  assert.equal(normalizeSku(undefined), null);
  // Inner characters are significant: different codes must never be folded together.
  assert.notEqual(normalizeSku("AO-XL"), normalizeSku("AO XL"));
});

test("warehouse keys namespace secondary warehouses and refuse a colliding primary id", () => {
  assert.equal(secondaryWarehouseKey(407962350, "wh-1"), "secondary:407962350:wh-1");
  assert.equal(warehouseStockKey({ kind: "primary" }, "wh-1"), "wh-1");
  assert.equal(
    warehouseStockKey({ kind: "secondary", shopId: 407962350 }, "wh-1"),
    "secondary:407962350:wh-1",
  );
  assert.throws(() => warehouseStockKey({ kind: "primary" }, "secondary:1:wh-1"));
  assert.throws(() => secondaryWarehouseKey(0, "wh-1"));
});

function recordingTx(options: { newerCount?: number } = {}) {
  type RecordedArgs = {
    create?: { pancakeWarehouseId?: string };
  } & Record<string, unknown>;
  const operations: Array<{ op: string; args: RecordedArgs }> = [];
  const tx = {
    warehouseStock: {
      async count(args: RecordedArgs) {
        operations.push({ op: "count", args });
        return options.newerCount ?? 0;
      },
      async deleteMany(args: RecordedArgs) {
        operations.push({ op: "deleteMany", args });
        return { count: 1 };
      },
      async upsert(args: RecordedArgs) {
        operations.push({ op: "upsert", args });
        return {};
      },
    },
    variantMirror: {
      async updateMany(args: RecordedArgs) {
        operations.push({ op: "updateMany", args });
        return { count: 1 };
      },
    },
  } as unknown as Parameters<typeof writeObservedWarehouseStocks>[0];
  return { tx, operations };
}

const now = new Date("2026-11-02T12:00:00Z");

test("a secondary write is confined to its own namespace and never touches the primary watermark", async () => {
  const { tx, operations } = recordingTx();
  const written = await writeObservedWarehouseStocks(
    tx,
    "variant-001",
    [{ warehouseId: "wh_sec_1", remainQuantity: 5 }],
    now,
    { kind: "secondary", shopId: 407962350 },
  );
  assert.equal(written, true);

  assert.deepEqual(operations.find((o) => o.op === "count")?.args, {
    where: {
      variantId: "variant-001",
      syncedAt: { gt: now },
      pancakeWarehouseId: { startsWith: "secondary:407962350:" },
    },
  });
  assert.deepEqual(operations.find((o) => o.op === "deleteMany")?.args, {
    where: {
      variantId: "variant-001",
      pancakeWarehouseId: {
        startsWith: "secondary:407962350:",
        notIn: ["secondary:407962350:wh_sec_1"],
      },
    },
  });
  assert.equal(operations.find((o) => o.op === "upsert")?.args.create?.pancakeWarehouseId, "secondary:407962350:wh_sec_1");
  assert.equal(operations.find((o) => o.op === "updateMany"), undefined);
});

test("a secondary write with no stock clears only its own namespace", async () => {
  const { tx, operations } = recordingTx();
  await writeObservedWarehouseStocks(tx, "variant-001", [], now, { kind: "secondary", shopId: 407962350 });
  assert.deepEqual(operations.find((o) => o.op === "deleteMany")?.args, {
    where: { variantId: "variant-001", pancakeWarehouseId: { startsWith: "secondary:407962350:" } },
  });
});

test("a primary write stamps the watermark and leaves every secondary row alone", async () => {
  const { tx, operations } = recordingTx();
  await writeObservedWarehouseStocks(tx, "variant-001", [{ warehouseId: "wh_pri_1", remainQuantity: 2 }], now);

  const notSecondary = { NOT: { pancakeWarehouseId: { startsWith: "secondary:" } } };
  assert.deepEqual(operations.find((o) => o.op === "count")?.args, {
    where: { variantId: "variant-001", syncedAt: { gt: now }, ...notSecondary },
  });
  assert.deepEqual(operations.find((o) => o.op === "deleteMany")?.args, {
    where: {
      variantId: "variant-001",
      ...notSecondary,
      pancakeWarehouseId: { notIn: ["wh_pri_1"] },
    },
  });
  assert.ok(operations.find((o) => o.op === "updateMany"), "primary writes stamp stockObservedAt");
});

test("a primary write with no stock still never matches a secondary row", async () => {
  const { tx, operations } = recordingTx();
  await writeObservedWarehouseStocks(tx, "variant-001", [], now);
  assert.deepEqual(operations.find((o) => o.op === "deleteMany")?.args, {
    where: {
      variantId: "variant-001",
      NOT: { pancakeWarehouseId: { startsWith: "secondary:" } },
    },
  });
});

function variationRow(id: string, displayId: string | null, stocks: Array<[string, number]>) {
  return {
    id,
    product_id: `${id}-product`,
    display_id: displayId,
    barcode: `BC-${id}`,
    fields: [],
    images: [],
    is_hidden: false,
    is_locked: false,
    retail_price: 200_000,
    retail_price_after_discount: 200_000,
    product: { id: `${id}-product`, name: id },
    variations_warehouses: stocks.map(([warehouse_id, remain_quantity]) => ({ warehouse_id, remain_quantity })),
  };
}

function syncHarness({
  secondary,
  primary,
}: {
  secondary: ReturnType<typeof variationRow>[];
  primary: Array<{ id: string; pancakeDisplayId: string | null; isPresent: boolean }>;
}) {
  const hookCalls: string[] = [];
  const observed: Array<{ shopId: number; variantIds: readonly string[]; observedAt: Date }> = [];
  let findManyWhere: unknown;
  const client = {
    async getJson(endpoint: string) {
      if (endpoint !== "/shops/407962350/products/variations") throw new Error(`Unexpected endpoint: ${endpoint}`);
      return {
        success: true,
        page_number: 1,
        page_size: 100,
        total_entries: secondary.length,
        total_pages: 1,
        data: secondary,
      };
    },
  };
  const writes: Array<{ variantId: string; keys: string[]; quantities: number[] }> = [];
  const tx = {
    warehouseStock: {
      async count() {
        return 0;
      },
      async deleteMany(args: { where: { variantId: string } }) {
        writes.push({ variantId: args.where.variantId, keys: [], quantities: [] });
        return { count: 0 };
      },
      async upsert({ create }: { create: { variantId: string; pancakeWarehouseId: string; quantity: number } }) {
        const current = writes.findLast((w) => w.variantId === create.variantId)!;
        current.keys.push(create.pancakeWarehouseId);
        current.quantities.push(create.quantity);
        return {};
      },
    },
    variantMirror: {
      async updateMany() {
        throw new Error("a secondary sync must not stamp the primary watermark");
      },
    },
  };
  const prisma = {
    variantMirror: {
      async findMany({ where }: { where: { product: { pancakeShopId: number } } }) {
        assert.equal(where.product.pancakeShopId, 4_741_464);
        findManyWhere = where;
        return primary;
      },
    },
    async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  } as unknown as PrismaClient;
  const warnings: string[] = [];
  return {
    writes,
    warnings,
    hookCalls,
    observed,
    findManyWhere: () => findManyWhere,
    run: () =>
      syncSecondaryShopInventory({
        primaryShopId: 4_741_464,
        secondaryShopId: 407_962_350,
        secondaryClient: client,
        prisma,
        clock: () => now,
        warn: (message) => warnings.push(message),
        hooks: {
          async acquireLock(_tx, shopId) {
            hookCalls.push(`lock:${shopId}`);
          },
          async observeAvailability(_tx, input) {
            hookCalls.push("observe");
            observed.push(input);
          },
        },
      }),
  };
}

test("syncSecondaryShopInventory matches SKUs, aggregates stock, and ignores unmatched", async () => {
  const harness = syncHarness({
    secondary: [
      variationRow("sec_var_1", "svd468-ao-xl ", [["wh_sec_1", 8], ["wh_sec_2", 0]]),
      variationRow("sec_var_2", "UNMATCHED-SKU-999", [["wh_sec_1", 10]]),
      variationRow("sec_var_3", null, [["wh_sec_1", 99]]),
    ],
    primary: [
      { id: "pri_var_1", pancakeDisplayId: "SVD468-AO-XL", isPresent: true },
      { id: "pri_var_2", pancakeDisplayId: "OTHER-SKU-NO-STOCK", isPresent: true },
    ],
  });

  const result = await harness.run();

  assert.deepEqual(result, {
    secondaryShopId: 407_962_350,
    totalSecondaryVariations: 3,
    matchedCount: 1,
    unmatchedCount: 1,
    ambiguousCount: 0,
    totalStockAggregated: 8,
    warehouseCount: 2,
  });
  assert.deepEqual(harness.writes, [
    {
      variantId: "pri_var_1",
      keys: ["secondary:407962350:wh_sec_1", "secondary:407962350:wh_sec_2"],
      quantities: [8, 0],
    },
    { variantId: "pri_var_2", keys: [], quantities: [] },
  ]);
  assert.deepEqual(harness.warnings, []);
});

test("a SKU shared by several present primary variants gets no secondary stock, so it is never counted twice", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_var_1", "DUP-SKU", [["wh_sec_1", 5]])],
    primary: [
      { id: "pri_a", pancakeDisplayId: "DUP-SKU", isPresent: true },
      { id: "pri_b", pancakeDisplayId: " dup-sku", isPresent: true },
    ],
  });

  const result = await harness.run();

  assert.equal(result.matchedCount, 0);
  assert.equal(result.ambiguousCount, 1);
  assert.equal(result.totalStockAggregated, 0);
  // Both are cleared, so stock a previous run may have given them does not linger.
  assert.deepEqual(harness.writes, [
    { variantId: "pri_a", keys: [], quantities: [] },
    { variantId: "pri_b", keys: [], quantities: [] },
  ]);
  assert.equal(harness.warnings.length, 1);
  assert.ok(!harness.warnings[0]!.includes("DUP-SKU"), "the warning must not carry the SKU");
});

test("a retired variant sharing a SKU does not make the live one ambiguous, and gets no stock itself", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_var_1", "SKU-1", [["wh_sec_1", 5]])],
    primary: [
      { id: "pri_live", pancakeDisplayId: "SKU-1", isPresent: true },
      { id: "pri_retired", pancakeDisplayId: "SKU-1", isPresent: false },
    ],
  });

  const result = await harness.run();

  assert.equal(result.ambiguousCount, 0);
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(harness.writes, [
    { variantId: "pri_live", keys: ["secondary:407962350:wh_sec_1"], quantities: [5] },
    { variantId: "pri_retired", keys: [], quantities: [] },
  ]);
});

test("purgeSecondaryWarehouseStock selects only the rows it is asked to drop", async () => {
  const calls: unknown[] = [];
  const prisma = {
    warehouseStock: {
      async deleteMany(args: unknown) {
        calls.push(args);
        return { count: 3 };
      },
    },
  } as unknown as PrismaClient;

  assert.equal(await purgeSecondaryWarehouseStock(prisma), 3);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { exceptShopId: 2 }), 3);
  assert.equal(await purgeSecondaryWarehouseStock(prisma, { shopId: 2, syncedBefore: now }), 3);

  assert.deepEqual(calls, [
    { where: { pancakeWarehouseId: { startsWith: "secondary:" } } },
    {
      where: {
        pancakeWarehouseId: { startsWith: "secondary:" },
        NOT: { pancakeWarehouseId: { startsWith: "secondary:2:" } },
      },
    },
    { where: { pancakeWarehouseId: { startsWith: "secondary:2:" }, syncedAt: { lt: now } } },
  ]);
});

test("a variant that lost its SKU is still read and has its secondary stock cleared", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_var_1", "SKU-1", [["wh_sec_1", 5]])],
    primary: [
      { id: "pri_no_sku", pancakeDisplayId: null, isPresent: true },
      { id: "pri_blank_sku", pancakeDisplayId: "   ", isPresent: true },
    ],
  });

  const result = await harness.run();

  assert.equal(result.matchedCount, 0);
  assert.deepEqual(harness.writes, [
    { variantId: "pri_no_sku", keys: [], quantities: [] },
    { variantId: "pri_blank_sku", keys: [], quantities: [] },
  ]);
  // The query must not exclude them: it also selects variants that still carry this shop's rows.
  assert.deepEqual(harness.findManyWhere(), {
    product: { pancakeShopId: 4_741_464 },
    OR: [
      { pancakeDisplayId: { not: null } },
      { warehouseStocks: { some: { pancakeWarehouseId: { startsWith: "secondary:407962350:" } } } },
    ],
  });
});

test("each chunk takes the catalog lock, writes, then re-observes availability for exactly its variants", async () => {
  const primary = Array.from({ length: 101 }, (_, i) => ({
    id: `pri_${i}`,
    pancakeDisplayId: `SKU-${i}`,
    isPresent: true,
  }));
  const harness = syncHarness({ secondary: [variationRow("s", "SKU-0", [["wh", 1]])], primary });

  await harness.run();

  assert.deepEqual(harness.hookCalls, ["lock:4741464", "observe", "lock:4741464", "observe"]);
  assert.equal(harness.observed[0]!.variantIds.length, 100);
  assert.deepEqual(harness.observed[1]!.variantIds, ["pri_100"]);
  assert.equal(harness.observed[0]!.shopId, 4_741_464);
  assert.deepEqual(harness.observed[0]!.observedAt, now);
});
