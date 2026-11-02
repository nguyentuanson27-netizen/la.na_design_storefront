import assert from "node:assert/strict";
import test from "node:test";

import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import {
  addSecondaryShopStock,
  SECONDARY_LOOKUP_CONCURRENCY,
  SECONDARY_LOOKUP_MAX_PAGES,
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

function page(rows: unknown[], pageNumber = 1, totalPages = 1, totalEntries = rows.length * totalPages) {
  return {
    success: true,
    page_number: pageNumber,
    page_size: SECONDARY_LOOKUP_PAGE_SIZE,
    total_entries: totalEntries,
    total_pages: totalPages,
    data: rows,
  };
}

const shopId = 407_962_350;
const primaryShopId = 4_741_464;

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
    { primaryShopId, warn: () => assert.fail("no warning expected") },
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
  }, { primaryShopId });
  assert.equal(result!.secondarySellableStock, 5);
  assert.equal(result!.sellableStock, 6);
  assert.equal(result!.warehouseStocks.length, 3);
});

test("no match leaves the primary variation untouched, without a warning", async () => {
  const original = primary("p1", "SKU-1", 4);
  const [result] = await addSecondaryShopStock(
    [original],
    { shopId, client: { getJson: async () => page([secondaryRow("s2", "SKU-12", 9)]) } },
    { primaryShopId, warn: () => assert.fail("a miss is not a failure") },
  );
  assert.equal(result, original);
});

test("a variation without a SKU is never looked up", async () => {
  const original = primary("p1", null, 4);
  const [result] = await addSecondaryShopStock([original], {
    shopId,
    client: { getJson: async () => assert.fail("must not be called") },
  }, { primaryShopId });
  assert.equal(result, original);
});

test("failed and unreadable lookups fall back to primary stock and are reported once, with counts only", async () => {
  const warnings: string[] = [];
  const variations = [primary("p1", "SKU-1", 2), primary("p2", "SKU-2", 2), primary("p3", "SKU-3", 2)];

  const result = await addSecondaryShopStock(
    variations,
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          if (query?.search === "SKU-1") return page([], 1, SECONDARY_LOOKUP_MAX_PAGES + 1);
          if (query?.search === "SKU-2") throw new Error("network down: secret-token");
          return page([secondaryRow("s3", "SKU-3", 7)]);
        },
      },
    },
    { primaryShopId, warn: (message) => warnings.push(message) },
  );

  assert.equal(result[0]!.sellableStock, 2, "too many pages to read: inconclusive, not zero");
  assert.equal(result[1]!.sellableStock, 2);
  assert.equal(result[2]!.sellableStock, 9);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /2 of 3/);
  assert.ok(!warnings[0]!.includes("secret-token") && !warnings[0]!.includes("SKU-"));
});

test("an exact SKU spread over several pages of a fuzzy search is added up across all of them", async () => {
  const requested: unknown[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 1)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          requested.push(query?.page_number);
          const pageNumber = Number(query?.page_number);
          return pageNumber === 1
            ? page([secondaryRow("s1", "SKU-1", 2, "wh_a"), secondaryRow("s9", "SKU-10", 50)], 1, 2, 3)
            : page([secondaryRow("s2", "SKU-1", 3, "wh_b")], 2, 2, 3);
        },
      },
    },
    { primaryShopId, warn: () => assert.fail("no warning expected") },
  );

  assert.deepEqual(requested, [1, 2]);
  assert.equal(result!.secondarySellableStock, 5, "matches on both pages count, like the mirror sync");
  assert.equal(result!.sellableStock, 6);
});

test("a match missing from page 1 but present on a later page is still found", async () => {
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 0)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          return Number(query?.page_number) === 1
            ? page([secondaryRow("s9", "SKU-10", 50)], 1, 2, 2)
            : page([secondaryRow("s1", "SKU-1", 4)], 2, 2, 2);
        },
      },
    },
    { primaryShopId, warn: () => assert.fail("no warning expected") },
  );
  assert.equal(result!.sellableStock, 4);
});

test("an unreadable payload counts as a failed lookup, not as stock", async () => {
  const warnings: string[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 2)],
    { shopId, client: { getJson: async () => ({ success: false }) } },
    { primaryShopId, warn: (message) => warnings.push(message) },
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
  }, { primaryShopId });

  assert.equal(peak, SECONDARY_LOOKUP_CONCURRENCY);
  assert.equal(result.length, variations.length);
  assert.ok(result.every((variation, i) => variation.id === `p${i}` && variation.sellableStock === 2), "order is preserved");
});

test("a SKU shared by several primary variants is never looked up, so its units are not counted twice", async () => {
  const asked: unknown[] = [];
  const lookups: unknown[] = [];
  const original = primary("p-dup", "dup-sku", 1);
  const result = await addSecondaryShopStock(
    [original, primary("p-ok", "SKU-OK", 1)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          lookups.push(query?.search);
          return page([secondaryRow("s", String(query?.search), 4)]);
        },
      },
      async findUnsafeSkus(shop, entries) {
        asked.push([shop, entries.map(({ variationId, sku }) => `${variationId}:${sku}`)]);
        return new Set(["DUP-SKU"]);
      },
    },
    { primaryShopId, warn: () => assert.fail("no warning expected") },
  );

  assert.deepEqual(asked, [[primaryShopId, ["p-dup:DUP-SKU", "p-ok:SKU-OK"]]]);
  assert.deepEqual(lookups, ["SKU-OK"]);
  assert.equal(result[0], original);
  assert.equal(result[1]!.sellableStock, 5);
});

test("if the uniqueness check cannot run, no secondary stock is added at all", async () => {
  const warnings: string[] = [];
  const variations = [primary("p1", "SKU-1", 1)];
  const result = await addSecondaryShopStock(
    variations,
    {
      shopId,
      client: { getJson: async () => assert.fail("must not be called") },
      findUnsafeSkus: async () => {
        throw new Error("database down");
      },
    },
    { primaryShopId, warn: (message) => warnings.push(message) },
  );
  assert.equal(result[0]!.sellableStock, 1);
  assert.equal(warnings.length, 1);
});

async function lookupWithPages(pages: (pageNumber: number) => unknown) {
  const warnings: string[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 1)],
    { shopId, client: { getJson: async (_endpoint, query) => pages(Number(query?.page_number)) } },
    { primaryShopId, warn: (message) => warnings.push(message) },
  );
  return { result: result!, warnings };
}

test("a proxy that ignores page_number and repeats page 1 cannot add the same units twice", async () => {
  const { result, warnings } = await lookupWithPages(() => page([secondaryRow("s1", "SKU-1", 5)], 1, 2, 2));
  assert.equal(result.sellableStock, 1, "inconclusive: primary stock only");
  assert.equal(result.secondarySellableStock, undefined);
  assert.equal(warnings.length, 1);
});

test("a repeated variation across pages is inconclusive even when the page number is right", async () => {
  const { result } = await lookupWithPages((n) => page([secondaryRow("same-id", "SKU-1", 5)], n, 2, 2));
  assert.equal(result.sellableStock, 1);
});

test("pagination metadata that changes during the walk is inconclusive", async () => {
  const changedTotals = await lookupWithPages((n) =>
    n === 1 ? page([secondaryRow("s1", "SKU-1", 5)], 1, 2, 2) : page([secondaryRow("s2", "SKU-1", 5)], 2, 2, 9),
  );
  assert.equal(changedTotals.result.sellableStock, 1);

  const changedPages = await lookupWithPages((n) =>
    n === 1 ? page([secondaryRow("s1", "SKU-1", 5)], 1, 2, 2) : page([secondaryRow("s2", "SKU-1", 5)], 2, 3, 2),
  );
  assert.equal(changedPages.result.sellableStock, 1);
});

test("fewer rows than the reported total is inconclusive", async () => {
  const { result } = await lookupWithPages((n) => page([secondaryRow(`s${n}`, "SKU-1", 5)], n, 2, 5));
  assert.equal(result.sellableStock, 1);
});

test("a consistent two-page walk is still added up", async () => {
  const { result, warnings } = await lookupWithPages((n) =>
    page([secondaryRow(`s${n}`, "SKU-1", n === 1 ? 2 : 3)], n, 2, 2),
  );
  assert.equal(result.secondarySellableStock, 5);
  assert.deepEqual(warnings, []);
});

test("two variations of the same live read that share a SKU get no secondary stock, whatever the mirror says", async () => {
  const lookups: unknown[] = [];
  const a = primary("p-a", "SKU-A", 1);
  const b = primary("p-b", " sku-a ", 1);
  const result = await addSecondaryShopStock(
    [a, b],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          lookups.push(query?.search);
          return page([secondaryRow("s", "SKU-A", 5)]);
        },
      },
      // The mirror still has them under different SKUs, so it reports nothing unsafe.
      findUnsafeSkus: async () => new Set<string>(),
    },
    { primaryShopId, warn: () => assert.fail("a deliberate skip is not a failure") },
  );

  assert.deepEqual(lookups, [], "the shared pool is never even asked for");
  assert.equal(result[0], a);
  assert.equal(result[1], b);
});

test("the same SKU twice in one read is caught even without a mirror check", async () => {
  let calls = 0;
  const result = await addSecondaryShopStock(
    [primary("p-a", "SKU-A", 1), primary("p-b", "SKU-A", 1)],
    {
      shopId,
      client: {
        async getJson() {
          calls += 1;
          return page([secondaryRow("s", "SKU-A", 5)]);
        },
      },
    },
    { primaryShopId, warn: () => undefined },
  );
  assert.equal(calls, 0, "no lookup is made for a SKU two variations of this read share");
  assert.deepEqual(result.map((v) => v.sellableStock), [1, 1]);
});

// ---- total deadline ----

const never = () => new Promise<never>(() => undefined);
const delay = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test("a secondary shop that never answers cannot hold the buyer past the deadline, however many lines", async () => {
  const warnings: string[] = [];
  const variations = Array.from({ length: 12 }, (_, i) => primary(`p${i}`, `SKU-${i}`, 1));
  const started = Date.now();
  const result = await addSecondaryShopStock(
    variations,
    { shopId, client: { getJson: () => never() } },
    { primaryShopId, deadlineMs: 60, warn: (message) => warnings.push(message) },
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 600, `took ${elapsed} ms`);
  assert.deepEqual(result.map((v) => v.sellableStock), variations.map(() => 1));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /12 of 12/);
  assert.match(warnings[0]!, /deadline/);
});

test("lookups answered before the deadline are kept and only the late ones fall back", async () => {
  const warnings: string[] = [];
  const result = await addSecondaryShopStock(
    [primary("p-fast", "SKU-FAST", 1), primary("p-slow", "SKU-SLOW", 1)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          if (query?.search === "SKU-FAST") return page([secondaryRow("s1", "SKU-FAST", 4)]);
          return never();
        },
      },
    },
    { primaryShopId, deadlineMs: 60, warn: (message) => warnings.push(message) },
  );

  assert.equal(result[0]!.sellableStock, 5);
  assert.equal(result[1]!.sellableStock, 1);
  assert.match(warnings[0]!, /1 of 2/);
});

test("a multi-page walk counts against the same deadline, not a fresh one per page", async () => {
  const requested: number[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 1)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          const n = Number(query?.page_number);
          requested.push(n);
          return delay(40, page([secondaryRow(`s${n}`, "SKU-1", 1)], n, 4, 4));
        },
      },
    },
    { primaryShopId, deadlineMs: 70, warn: () => undefined },
  );

  assert.equal(result!.sellableStock, 1, "four 40 ms pages cannot finish inside 70 ms");
});

test("no new lookup starts after the deadline", async () => {
  let calls = 0;
  const variations = Array.from({ length: 40 }, (_, i) => primary(`p${i}`, `SKU-${i}`, 1));
  await addSecondaryShopStock(
    variations,
    {
      shopId,
      client: {
        async getJson() {
          calls += 1;
          return delay(30, page([]));
        },
      },
    },
    { primaryShopId, deadlineMs: 50, warn: () => undefined },
  );
  const callsAtDeadline = calls;
  await delay(200, undefined);

  assert.equal(calls, callsAtDeadline, "the walk stopped starting lookups once time was up");
  assert.ok(callsAtDeadline < 40);
});

test("a lookup that is mid-walk when the deadline passes asks for no further page", async () => {
  const requested: number[] = [];
  const [result] = await addSecondaryShopStock(
    [primary("p1", "SKU-1", 1)],
    {
      shopId,
      client: {
        async getJson(_endpoint, query) {
          const n = Number(query?.page_number);
          requested.push(n);
          // Page 1 is quick; page 2 only completes after the deadline; pages 3-5 must never be asked for.
          return n === 1 ? page([secondaryRow("s1", "SKU-1", 1)], 1, 5, 5) : delay(120, page([secondaryRow(`s${n}`, "SKU-1", 1)], n, 5, 5));
        },
      },
    },
    { primaryShopId, deadlineMs: 60, warn: () => undefined },
  );
  await delay(400, undefined);

  assert.deepEqual(requested, [1, 2], "nothing past the page that was in flight at the deadline");
  assert.equal(result!.sellableStock, 1, "and the buyer got the primary stock");
});
