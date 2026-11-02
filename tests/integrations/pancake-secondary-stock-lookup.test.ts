import assert from "node:assert/strict";
import test from "node:test";

import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import {
  addSecondaryShopStock,
  SECONDARY_LOOKUP_CONCURRENCY,
  SECONDARY_LOOKUP_PAGE_SIZE,
} from "../../src/integrations/pancake/secondary-stock-lookup.ts";

function primary(id: string, displayId: string | null, sellableStock: number): PancakeCatalogVariation {
  return {
    id,
    productId: `${id}-product`,
    displayId,
    barcode: `BC-${id}`,
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 450_000,
    product: { id: `${id}-product`, name: id },
    warehouseStocks: [{ warehouseId: "wh_pri", remainQuantity: sellableStock }],
    sellableStock,
  };
}

function secondaryRow(id: string, displayId: string, stock: number, warehouse = "wh_sec") {
  return {
    id,
    product_id: `${id}-product`,
    display_id: displayId,
    barcode: `BC-${id}`,
    fields: [],
    images: [],
    is_hidden: false,
    is_locked: false,
    retail_price: 999_999,
    retail_price_after_discount: 999_999,
    product: { id: `${id}-product`, name: "Other" },
    variations_warehouses: [{ warehouse_id: warehouse, remain_quantity: stock }],
  };
}

function page(rows: unknown[]) {
  return { success: true, page_number: 1, page_size: SECONDARY_LOOKUP_PAGE_SIZE, total_entries: rows.length, total_pages: 1, data: rows };
}

const shopId = 407_962_350;

test("matches the exact SKU case-insensitively and adds only stock, never price or identity", async () => {
  const queries: unknown[] = [];
  const result = await addSecondaryShopStock(
    [primary("p1", " sku-1 ", -3)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          queries.push(query);
          // A fuzzy search also returns near-misses, which must not count.
          return page([secondaryRow("s1", "SKU-1", 5), secondaryRow("s2", "SKU-10", 100)]);
        },
      },
    },
    () => assert.fail("no warning expected"),
  );

  assert.deepEqual(queries, [{ page_number: 1, page_size: SECONDARY_LOOKUP_PAGE_SIZE, search: "sku-1" }]);
  assert.equal(result[0]!.sellableStock, 2, "negative primary stock nets against the secondary stock");
  assert.equal(result[0]!.primarySellableStock, -3);
  assert.equal(result[0]!.secondarySellableStock, 5);
  assert.equal(result[0]!.retailPrice, 500_000);
  assert.equal(result[0]!.product.name, "p1");
});

test("several exact matches in the secondary shop add up", async () => {
  const [result] = await addSecondaryShopStock([primary("p1", "SKU-1", 1)], {
    shopId,
    client: { getJson: async () => page([secondaryRow("s1", "SKU-1", 2, "wh_a"), secondaryRow("s2", "SKU-1", 3, "wh_b")]) },
  });
  assert.equal(result!.secondarySellableStock, 5);
  assert.equal(result!.sellableStock, 6);
  assert.equal(result!.warehouseStocks.length, 3);
});

test("no match leaves the primary variation untouched, without a warning", async () => {
  const original = primary("p1", "SKU-1", 4);
  const [result] = await addSecondaryShopStock(
    [original],
    { shopId, client: { getJson: async () => page([secondaryRow("s2", "SKU-12", 9)]) } },
    () => assert.fail("a miss is not a failure"),
  );
  assert.equal(result, original);
});

test("a variation without a SKU is never looked up", async () => {
  const original = primary("p1", null, 4);
  const [result] = await addSecondaryShopStock([original], {
    shopId,
    client: { getJson: async () => assert.fail("must not be called") },
  });
  assert.equal(result, original);
});

test("failed and possibly truncated lookups fall back to primary stock and are reported once, with counts only", async () => {
  const warnings: string[] = [];
  const fullPageWithoutExactSku = Array.from({ length: SECONDARY_LOOKUP_PAGE_SIZE }, (_, i) =>
    secondaryRow(`s${i}`, `SKU-1${String(i).padStart(3, "0")}`, 1),
  );
  const variations = [primary("p1", "SKU-1", 2), primary("p2", "SKU-2", 2), primary("p3", "SKU-3", 2)];

  const result = await addSecondaryShopStock(
    variations,
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          if (query?.search === "SKU-1") return page(fullPageWithoutExactSku);
          if (query?.search === "SKU-2") throw new Error("network down: secret-token");
          return page([secondaryRow("s3", "SKU-3", 7)]);
        },
      },
    },
    (message) => warnings.push(message),
  );

  assert.equal(result[0]!.sellableStock, 2);
  assert.equal(result[1]!.sellableStock, 2);
  assert.equal(result[2]!.sellableStock, 9);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /2 of 3/);
  assert.ok(!warnings[0]!.includes("secret-token") && !warnings[0]!.includes("SKU-"));
});

test("an unreadable payload counts as a failed lookup, not as stock", async () => {
  const warnings: string[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 2)],
    { shopId, client: { getJson: async () => ({ success: false }) } },
    (message) => warnings.push(message),
  );
  assert.equal(result!.sellableStock, 2);
  assert.equal(warnings.length, 1);
});

test("requests to the secondary shop never exceed the concurrency limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const variations = Array.from({ length: SECONDARY_LOOKUP_CONCURRENCY * 4 }, (_, i) => primary(`p${i}`, `SKU-${i}`, 1));
  const result = await addSecondaryShopStock(variations, {
    shopId,
    client: {
      async getJson(_endpoint, query) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return page([secondaryRow("s", String(query?.search), 1)]);
      },
    },
  });

  assert.equal(peak, SECONDARY_LOOKUP_CONCURRENCY);
  assert.equal(result.length, variations.length);
  assert.ok(result.every((variation, i) => variation.id === `p${i}` && variation.sellableStock === 2), "order is preserved");
});
