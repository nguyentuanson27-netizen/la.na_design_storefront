import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSku,
  syncSecondaryShopInventory,
} from "../../src/commerce/secondary-inventory-sync.ts";
import { writeObservedWarehouseStocks } from "../../src/commerce/catalog-mirror-repository.ts";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";

test("normalizeSku trims whitespace and converts to uppercase", () => {
  assert.equal(normalizeSku("  svd468-ao-xl  "), "SVD468-AO-XL");
  assert.equal(normalizeSku("Sq069-s"), "SQ069-S");
  assert.equal(normalizeSku(""), null);
  assert.equal(normalizeSku("   "), null);
  assert.equal(normalizeSku(null), null);
  assert.equal(normalizeSku(undefined), null);
});

test("writeObservedWarehouseStocks scopes warehouse deletion when scopeWarehouseIds is provided", async () => {
  const operations: Array<{ op: string; args: unknown }> = [];

  const tx = {
    warehouseStock: {
      async count(args: unknown) {
        operations.push({ op: "count", args });
        return 0;
      },
      async deleteMany(args: unknown) {
        operations.push({ op: "deleteMany", args });
        return { count: 1 };
      },
      async upsert(args: unknown) {
        operations.push({ op: "upsert", args });
        return {};
      },
    },
    variantMirror: {
      async updateMany(args: unknown) {
        operations.push({ op: "updateMany", args });
        return { count: 1 };
      },
    },
  } as unknown as Parameters<typeof writeObservedWarehouseStocks>[0];

  const now = new Date("2026-11-02T12:00:00Z");
  const secondaryWarehouses = ["wh_sec_1", "wh_sec_2"];

  // Variant has stock in wh_sec_1, none in wh_sec_2
  const written = await writeObservedWarehouseStocks(
    tx,
    "variant-001",
    [{ warehouseId: "wh_sec_1", remainQuantity: 5 }],
    now,
    { scopeWarehouseIds: secondaryWarehouses, stampVariantWatermark: false },
  );

  assert.equal(written, true);

  // Verify count only scoped to secondaryWarehouses
  const countOp = operations.find((o) => o.op === "count");
  assert.deepEqual(countOp?.args, {
    where: {
      variantId: "variant-001",
      syncedAt: { gt: now },
      pancakeWarehouseId: { in: secondaryWarehouses },
    },
  });

  // Verify deleteMany only deleted warehouses in secondaryWarehouses NOT in current (i.e. wh_sec_2)
  const deleteOp = operations.find((o) => o.op === "deleteMany");
  assert.deepEqual(deleteOp?.args, {
    where: {
      variantId: "variant-001",
      pancakeWarehouseId: {
        in: secondaryWarehouses,
        notIn: ["wh_sec_1"],
      },
    },
  });

  // Verify upsert wrote wh_sec_1
  const upsertOp = operations.find((o) => o.op === "upsert");
  assert.deepEqual(upsertOp?.args, {
    where: {
      variantId_pancakeWarehouseId: { variantId: "variant-001", pancakeWarehouseId: "wh_sec_1" },
    },
    create: {
      variantId: "variant-001",
      pancakeWarehouseId: "wh_sec_1",
      quantity: 5,
      syncedAt: now,
    },
    update: {
      quantity: 5,
      syncedAt: now,
    },
  });

  // Verify stampVariantWatermark was false, so variantMirror was NOT updated
  const updateManyOp = operations.find((o) => o.op === "updateMany");
  assert.equal(updateManyOp, undefined);
});

test("syncSecondaryShopInventory matches SKUs, aggregates stock, and ignores unmatched", async () => {
  const secondaryWarehouses = [
    { id: "wh_sec_1", name: "Kho Taobao", allow_create_order: true },
    { id: "wh_sec_2", name: "Kho Cong So", allow_create_order: true },
  ];

  const secondaryVariationsData = [
    {
      id: "sec_var_1",
      product_id: "sec_prod_1",
      display_id: "SVD468-AO-XL",
      barcode: "BC-1",
      fields: [],
      images: [],
      is_hidden: false,
      is_locked: false,
      retail_price: 200_000,
      retail_price_after_discount: 200_000,
      product: { id: "sec_prod_1", name: "ÁO SVD468" },
      variations_warehouses: [
        { warehouse_id: "wh_sec_1", remain_quantity: 8 },
        { warehouse_id: "wh_sec_2", remain_quantity: 0 },
      ],
    },
    {
      id: "sec_var_2",
      product_id: "sec_prod_2",
      display_id: "UNMATCHED-SKU-999",
      barcode: "BC-2",
      fields: [],
      images: [],
      is_hidden: false,
      is_locked: false,
      retail_price: 300_000,
      retail_price_after_discount: 300_000,
      product: { id: "sec_prod_2", name: "SẢN PHẨM RIÊNG" },
      variations_warehouses: [
        { warehouse_id: "wh_sec_1", remain_quantity: 10 },
      ],
    },
  ];

  const mockClient = {
    async getJson(endpoint: string, query?: Readonly<Record<string, unknown>>) {
      if (endpoint === "/shops/407962350/warehouses") {
        return { success: true, data: secondaryWarehouses };
      }
      if (endpoint === "/shops/407962350/products/variations") {
        return {
          success: true,
          page_number: 1,
          page_size: 100,
          total_entries: secondaryVariationsData.length,
          total_pages: 1,
          data: secondaryVariationsData,
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };

  const writtenStocks: Array<{ variantId: string; stocks: unknown[]; scopeWarehouseIds?: unknown }> = [];

  const mockTx = {
    warehouseStock: {
      async count() {
        return 0;
      },
      async deleteMany() {
        return { count: 0 };
      },
      async upsert({ where, create }: { where: unknown; create: unknown }) {
        return {};
      },
    },
    variantMirror: {
      async updateMany() {
        return { count: 1 };
      },
    },
  };

  const mockPrisma = {
    variantMirror: {
      async findMany({ where }: { where: { product: { pancakeShopId: number } } }) {
        assert.equal(where.product.pancakeShopId, 4_741_464);
        return [
          { id: "pri_var_1", pancakeDisplayId: "SVD468-AO-XL" },
          { id: "pri_var_2", pancakeDisplayId: "OTHER-SKU-NO-STOCK" },
        ];
      },
    },
    async $transaction<T>(fn: (tx: typeof mockTx) => Promise<T>): Promise<T> {
      return fn(mockTx);
    },
  } as unknown as PrismaClient;

  const fixedClock = () => new Date("2026-11-02T12:00:00Z");

  const result = await syncSecondaryShopInventory({
    primaryShopId: 4_741_464,
    secondaryShopId: 407_962_350,
    secondaryClient: mockClient,
    prisma: mockPrisma,
    clock: fixedClock,
  });

  assert.deepEqual(result, {
    secondaryShopId: 407_962_350,
    totalSecondaryVariations: 2,
    matchedCount: 1,
    unmatchedCount: 1,
    totalStockAggregated: 8,
    warehouseCount: 2,
  });
});
