import assert from "node:assert/strict";
import test from "node:test";

import {
  configureSecondaryShop,
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
  // It is ordered by its own marker, never the primary's.
  assert.deepEqual(operations.find((o) => o.op === "updateMany")?.args, {
    where: {
      id: "variant-001",
      OR: [{ secondaryStockObservedAt: null }, { secondaryStockObservedAt: { lte: now } }],
    },
    data: { secondaryStockObservedAt: now },
  });
});

test("a secondary read that began earlier than the one already applied writes nothing, even over an empty set", async () => {
  const operations: string[] = [];
  const tx = {
    warehouseStock: {
      async count() {
        return 0;
      },
      async deleteMany() {
        operations.push("deleteMany");
        return { count: 0 };
      },
      async upsert() {
        operations.push("upsert");
        return {};
      },
    },
    variantMirror: {
      async updateMany() {
        return { count: 0 };
      },
    },
  } as unknown as Parameters<typeof writeObservedWarehouseStocks>[0];

  const written = await writeObservedWarehouseStocks(
    tx,
    "variant-001",
    [{ warehouseId: "wh_sec_1", remainQuantity: 5 }],
    now,
    { kind: "secondary", shopId: 407962350 },
  );

  assert.equal(written, false);
  assert.deepEqual(operations, []);
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

type PrimaryRow = { id: string; pancakeDisplayId: string | null; isPresent: boolean };

function syncHarness({
  secondary,
  primary,
  primaryAtLockTime = primary,
  activeShop = 407_962_350 as number | null,
  pages,
}: {
  secondary: ReturnType<typeof variationRow>[];
  /** What the candidate read sees. */
  primary: PrimaryRow[];
  /** What the mapping really is once the lock is held (a primary sync may have committed in between). */
  primaryAtLockTime?: PrimaryRow[];
  /** The secondary shop stored as configured when the chunk takes the lock. */
  activeShop?: number | null;
  /** Serve the secondary catalog in these pages instead of one (to test repeated rows). */
  pages?: ReturnType<typeof variationRow>[][];
}) {
  const hookCalls: string[] = [];
  const locked: Array<readonly string[]> = [];
  const observed: Array<{ shopId: number; variantIds: readonly string[]; observedAt: Date }> = [];
  let findManyWhere: unknown;
  const client = {
    async getJson(endpoint: string, query?: Readonly<Record<string, string | number | boolean>>) {
      if (endpoint !== "/shops/407962350/products/variations") throw new Error(`Unexpected endpoint: ${endpoint}`);
      const served = pages ?? [secondary];
      const pageNumber = Number(query?.page_number ?? 1);
      return {
        success: true,
        page_number: pageNumber,
        page_size: 100,
        total_entries: served.reduce((total, rows) => total + rows.length, 0),
        total_pages: served.length,
        data: served[pageNumber - 1] ?? [],
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
      async updateMany(args: { data: Record<string, unknown> }) {
        assert.deepEqual(Object.keys(args.data), ["secondaryStockObservedAt"], "a secondary sync must not stamp the primary watermark");
        return { count: 1 };
      },
    },
  };
  const prisma = {
    variantMirror: {
      async findMany({ where }: { where: { product: { pancakeShopId: number } } }) {
        assert.equal(where.product.pancakeShopId, 4_741_464);
        findManyWhere = where;
        return primary.map(({ id }) => ({ id }));
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
    locked,
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
          async lockVariants(_tx, variantIds) {
            hookCalls.push("lockRows");
            locked.push(variantIds);
          },
          async readMapping(_tx, variantIds) {
            hookCalls.push("mapping");
            return primaryAtLockTime.filter(({ id }) => variantIds.includes(id));
          },
          async readActiveShop() {
            hookCalls.push("readActive");
            return { present: true, shopId: activeShop, epoch: 0 };
          },
          async setActiveShop() {},
          async findAmbiguousSkus(_tx, _shop, skus) {
            const counts = new Map<string, number>();
            for (const row of primaryAtLockTime) {
              const sku = normalizeSku(row.pancakeDisplayId);
              if (sku && row.isPresent) counts.set(sku, (counts.get(sku) ?? 0) + 1);
            }
            return new Set(skus.filter((sku) => (counts.get(sku) ?? 0) > 1));
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
    discarded: false,
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

function purgeHarness(options: { present?: boolean; activeShop?: number | null; affected?: string[] } = {}) {
  const { present = true, affected = ["v1", "v2"] } = options;
  let activeShop = options.activeShop ?? null;
  const steps: string[] = [];
  const wheres: unknown[] = [];
  const tx = {
    warehouseStock: {
      async findMany(args: { where: unknown }) {
        steps.push("find");
        wheres.push(args.where);
        return affected.map((variantId) => ({ variantId }));
      },
      async deleteMany(args: { where: unknown }) {
        steps.push("delete");
        wheres.push(args.where);
        return { count: affected.length * 3 };
      },
    },
  };
  const observed: unknown[] = [];
  const hooks = {
    async acquireLock(_tx: unknown, shopId: number) {
      steps.push(`lock:${shopId}`);
    },
    async lockVariants(_tx: unknown, ids: readonly string[]) {
      steps.push(`lockRows:${ids.join(",")}`);
    },
    async observeAvailability(_tx: unknown, input: unknown) {
      steps.push("observe");
      observed.push(input);
    },
    async readMapping() {
      return [];
    },
    async findAmbiguousSkus() {
      return new Set<string>();
    },
    async readActiveShop() {
      steps.push("readActive");
      return { present, shopId: activeShop, epoch: 0 };
    },
    async setActiveShop(_tx: unknown, _shop: number, value: number | null) {
      steps.push(`setActive:${value}`);
      activeShop = value;
    },
  };
  const prisma = {
    async $transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  } as unknown as PrismaClient;
  return { steps, wheres, observed, hooks, prisma, activeShop: () => activeShop };
}

test("purgeSecondaryWarehouseStock deletes under the shop lock, locks the rows, and re-observes what it changed", async () => {
  const h = purgeHarness();

  const removed = await purgeSecondaryWarehouseStock(h.prisma, {
    primaryShopId: 4_741_464,
    shopId: 2,
    syncedBefore: now,
    observedAt: now,
    hooks: h.hooks,
  });

  assert.equal(removed, 6);
  assert.deepEqual(h.steps, ["lock:4741464", "find", "lockRows:v1,v2", "delete", "observe"]);
  assert.deepEqual(h.wheres, [
    { pancakeWarehouseId: { startsWith: "secondary:2:" }, syncedAt: { lt: now } },
    { pancakeWarehouseId: { startsWith: "secondary:2:" }, syncedAt: { lt: now }, variantId: { in: ["v1", "v2"] } },
  ]);
  assert.deepEqual(h.observed, [{ shopId: 4_741_464, variantIds: ["v1", "v2"], observedAt: now }]);
});

test("a purge that finds nothing locks no variant and observes nothing", async () => {
  const h = purgeHarness({ affected: [] });
  assert.equal(await purgeSecondaryWarehouseStock(h.prisma, { primaryShopId: 1, hooks: h.hooks }), 0);
  assert.deepEqual(h.steps, ["lock:1", "find"]);
});

test("configuring a different secondary shop stores it and removes every other shop's stock, under one lock", async () => {
  const h = purgeHarness({ activeShop: 1 });

  const result = await configureSecondaryShop(h.prisma, {
    primaryShopId: 4_741_464,
    secondaryShopId: 2,
    observedAt: now,
    hooks: h.hooks,
  });

  assert.deepEqual(result, { changed: true, removed: 6 });
  assert.deepEqual(h.steps, ["lock:4741464", "readActive", "setActive:2", "find", "lockRows:v1,v2", "delete", "observe"]);
  assert.deepEqual(h.wheres[0], {
    pancakeWarehouseId: { startsWith: "secondary:" },
    NOT: { pancakeWarehouseId: { startsWith: "secondary:2:" } },
  });
});

test("switching the feature off stores none and removes every secondary row", async () => {
  const h = purgeHarness({ activeShop: 2 });
  const result = await configureSecondaryShop(h.prisma, { primaryShopId: 1, secondaryShopId: null, observedAt: now, hooks: h.hooks });
  assert.deepEqual(result, { changed: true, removed: 6 });
  assert.equal(h.activeShop(), null);
  assert.deepEqual(h.wheres[0], { pancakeWarehouseId: { startsWith: "secondary:" } });
});

test("a steady-state configure changes nothing and only looks for strays", async () => {
  const h = purgeHarness({ activeShop: 2, affected: [] });
  const result = await configureSecondaryShop(h.prisma, { primaryShopId: 1, secondaryShopId: 2, observedAt: now, hooks: h.hooks });
  assert.deepEqual(result, { changed: false, removed: 0 });
  assert.deepEqual(h.steps, ["lock:1", "readActive", "find"], "nothing stored, nothing observed");
});

test("before the first catalog sync there is no state to configure: nothing happens", async () => {
  const h = purgeHarness({ present: false });
  const result = await configureSecondaryShop(h.prisma, { primaryShopId: 1, secondaryShopId: 2, observedAt: now, hooks: h.hooks });
  assert.deepEqual(result, { changed: false, removed: 0 });
  assert.deepEqual(h.steps, ["lock:1", "readActive"]);
});

test("the SKU mapping that decides the writes is the one read under the lock, not the candidate read", async () => {
  // The candidate read saw v1 as SKU-A; a primary sync that committed before the lock renamed it
  // to SKU-B, and made v2 (SKU-A) a second owner of nothing. SKU-A's 5 units must not land on v1.
  const harness = syncHarness({
    secondary: [
      variationRow("sec_a", "SKU-A", [["wh", 5]]),
      variationRow("sec_b", "SKU-B", [["wh", 2]]),
    ],
    primary: [
      { id: "v1", pancakeDisplayId: "SKU-A", isPresent: true },
      { id: "v2", pancakeDisplayId: "SKU-C", isPresent: true },
    ],
    primaryAtLockTime: [
      { id: "v1", pancakeDisplayId: "SKU-B", isPresent: true },
      { id: "v2", pancakeDisplayId: "SKU-A", isPresent: true },
    ],
  });

  await harness.run();

  assert.deepEqual(harness.writes, [
    { variantId: "v1", keys: ["secondary:407962350:wh"], quantities: [2] },
    { variantId: "v2", keys: ["secondary:407962350:wh"], quantities: [5] },
  ]);
});

test("a SKU that became shared after the candidate read gets no stock", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_a", "SKU-A", [["wh", 5]])],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
    primaryAtLockTime: [
      { id: "v1", pancakeDisplayId: "SKU-A", isPresent: true },
      { id: "v1b", pancakeDisplayId: "sku-a", isPresent: true },
    ],
  });

  const result = await harness.run();

  assert.equal(result.ambiguousCount, 1);
  assert.deepEqual(harness.writes, [{ variantId: "v1", keys: [], quantities: [] }]);
});

test("a variant that lost its SKU or was retired after the candidate read is cleared", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_a", "SKU-A", [["wh", 5]])],
    primary: [
      { id: "v1", pancakeDisplayId: "SKU-A", isPresent: true },
      { id: "v2", pancakeDisplayId: "SKU-A", isPresent: true },
    ],
    primaryAtLockTime: [
      { id: "v1", pancakeDisplayId: null, isPresent: true },
      { id: "v2", pancakeDisplayId: "SKU-A", isPresent: false },
    ],
  });

  await harness.run();

  assert.deepEqual(harness.writes, [
    { variantId: "v1", keys: [], quantities: [] },
    { variantId: "v2", keys: [], quantities: [] },
  ]);
});

test("a sync for a shop that is no longer the configured one discards everything and says so", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_a", "SKU-A", [["wh", 5]])],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
    activeShop: 999,
  });

  const result = await harness.run();

  assert.equal(result.discarded, true);
  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.hookCalls, ["readActive"], "found out before anything is read from the secondary shop; nothing is locked or written");
  assert.equal(harness.warnings.length, 1);
});

test("with no secondary shop configured at all, a sync writes nothing", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_a", "SKU-A", [["wh", 5]])],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
    activeShop: null,
  });
  assert.equal((await harness.run()).discarded, true);
  assert.deepEqual(harness.writes, []);
});

test("a sync for the configured shop is applied", async () => {
  const harness = syncHarness({
    secondary: [variationRow("sec_a", "SKU-A", [["wh", 5]])],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
    activeShop: 407_962_350,
  });
  const result = await harness.run();
  assert.equal(result.discarded, false);
  assert.equal(harness.writes.length, 1);
});

test("a variation id repeated across pages refuses the whole snapshot: nothing is written", async () => {
  const repeated = variationRow("sec-1", "SKU-A", [["wh", 5]]);
  const harness = syncHarness({
    secondary: [],
    pages: [[repeated], [repeated]],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
  });

  await assert.rejects(() => harness.run(), /repeats a variation id/);

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.hookCalls, ["readActive"], "only the activation was read; no lock, no write");
});

test("distinct variations that share a SKU are still summed, only a repeated id is refused", async () => {
  const harness = syncHarness({
    secondary: [],
    pages: [[variationRow("sec-1", "SKU-A", [["wh", 2]])], [variationRow("sec-2", "SKU-A", [["wh", 3]])]],
    primary: [{ id: "v1", pancakeDisplayId: "SKU-A", isPresent: true }],
  });

  await harness.run();

  assert.deepEqual(harness.writes, [{ variantId: "v1", keys: ["secondary:407962350:wh"], quantities: [5] }]);
});
