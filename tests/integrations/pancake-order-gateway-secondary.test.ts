import assert from "node:assert/strict";
import test from "node:test";

import { createPancakeOrderGateway } from "../../src/integrations/pancake/order-gateway.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

type QueryValue = string | number | boolean | readonly string[];
type TestGatewayClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
  postJson(endpoint: string, body: unknown): Promise<unknown>;
};

test("order gateway aggregates live sellable stock from secondary shop by SKU", async () => {
  const primaryVariation: PancakeCatalogVariation = {
    id: "variation-pri-1",
    productId: "prod-1",
    displayId: "SVD468-AO-XL",
    barcode: "BC-1",
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 450_000,
    product: { id: "prod-1", name: "Áo SVD468" },
    warehouseStocks: [{ warehouseId: "wh_pri_1", remainQuantity: 0 }],
    sellableStock: 0,
  };

  const primaryClient: TestGatewayClient = {
    async getJson(endpoint, query) {
      assert.equal(endpoint, "/shops/4741464/products/variations");
      return {
        success: true,
        page_number: 1,
        page_size: 100,
        total_entries: 1,
        total_pages: 1,
        data: [
          {
            id: "variation-pri-1",
            product_id: "prod-1",
            display_id: "SVD468-AO-XL",
            barcode: "BC-1",
            fields: [],
            images: [],
            is_hidden: false,
            is_locked: false,
            retail_price: 500_000,
            retail_price_after_discount: 450_000,
            product: { id: "prod-1", name: "Áo SVD468" },
            variations_warehouses: [{ warehouse_id: "wh_pri_1", remain_quantity: 0 }],
          },
        ],
      };
    },
    async postJson() {
      throw new Error("not used");
    },
  };

  let secondaryQueriedWithSearch = "";
  const secondaryClient: TestGatewayClient = {
    async getJson(endpoint, query) {
      assert.equal(endpoint, "/shops/407962350/products/variations");
      secondaryQueriedWithSearch = String(query?.search ?? "");
      return {
        success: true,
        page_number: 1,
        page_size: 30,
        total_entries: 1,
        total_pages: 1,
        data: [
          {
            id: "sec-var-999",
            product_id: "sec-prod-999",
            display_id: "SVD468-AO-XL",
            barcode: "BC-SEC",
            fields: [],
            images: [],
            is_hidden: false,
            is_locked: false,
            retail_price: 600_000, // Secondary shop has different price - must be ignored!
            retail_price_after_discount: 600_000,
            product: { id: "sec-prod-999", name: "Different Name" },
            variations_warehouses: [{ warehouse_id: "wh_sec_1", remain_quantity: 8 }],
          },
        ],
      };
    },
    async postJson() {
      throw new Error("not used");
    },
  };

  const gateway = createPancakeOrderGateway(
    primaryClient,
    undefined,
    undefined,
    {
      client: secondaryClient,
      shopId: 407_962_350,
    },
  );

  const variations = await gateway.fetchVariations(4_741_464, ["variation-pri-1"]);

  assert.equal(secondaryQueriedWithSearch, "SVD468-AO-XL");
  assert.equal(variations.length, 1);
  const result = variations[0]!;

  // Primary identity and pricing preserved 100%
  assert.equal(result.id, "variation-pri-1");
  assert.equal(result.retailPrice, 500_000);
  assert.equal(result.retailPriceAfterDiscount, 450_000);
  assert.equal(result.product.name, "Áo SVD468");

  // Stock aggregated: 0 (primary) + 8 (secondary) = 8
  assert.equal(result.sellableStock, 8);
  assert.equal(result.primarySellableStock, 0);
  assert.equal(result.secondarySellableStock, 8);
  assert.deepEqual(result.warehouseStocks, [
    { warehouseId: "wh_pri_1", remainQuantity: 0 },
    { warehouseId: "wh_sec_1", remainQuantity: 8 },
  ]);
});

test("order gateway falls back to primary stock when secondary shop query fails or has no match", async () => {
  const primaryClient: TestGatewayClient = {
    async getJson() {
      return {
        success: true,
        page_number: 1,
        page_size: 100,
        total_entries: 1,
        total_pages: 1,
        data: [
          {
            id: "variation-pri-1",
            product_id: "prod-1",
            display_id: "SVD468-AO-XL",
            barcode: "BC-1",
            fields: [],
            images: [],
            is_hidden: false,
            is_locked: false,
            retail_price: 500_000,
            retail_price_after_discount: 450_000,
            product: { id: "prod-1", name: "Áo SVD468" },
            variations_warehouses: [{ warehouse_id: "wh_pri_1", remain_quantity: 2 }],
          },
        ],
      };
    },
    async postJson() {
      throw new Error("not used");
    },
  };

  const failingSecondaryClient: TestGatewayClient = {
    async getJson() {
      throw new Error("Secondary Pancake network error");
    },
    async postJson() {
      throw new Error("not used");
    },
  };

  const gateway = createPancakeOrderGateway(
    primaryClient,
    undefined,
    undefined,
    {
      client: failingSecondaryClient,
      shopId: 407_962_350,
    },
  );

  const variations = await gateway.fetchVariations(4_741_464, ["variation-pri-1"]);
  assert.equal(variations.length, 1);
  assert.equal(variations[0]!.sellableStock, 2);
  assert.equal(variations[0]!.secondarySellableStock, undefined);
});
