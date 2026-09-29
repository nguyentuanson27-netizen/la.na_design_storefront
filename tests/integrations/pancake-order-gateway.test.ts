import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPancakeOrderGateway } from "../../src/integrations/pancake/order-gateway.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";

type PostJsonOptions = Readonly<{ expectedStatus?: number | readonly number[] }>;
type TestGatewayClient = {
  getJson(
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  ): Promise<unknown>;
  postJson(endpoint: string, body: unknown, options?: PostJsonOptions): Promise<unknown>;
};

const request: PancakeCreateOrderRequest = {
  shop_id: 4_741_464,
  bill_full_name: "Nguyễn Văn A",
  bill_phone_number: "0901234567",
  shipping_fee: 30_000,
  is_free_shipping: false,
  received_at_shop: false,
  shipping_address: {
    full_name: "Nguyễn Văn A",
    phone_number: "0901234567",
    address: "12 Đường A",
    province_id: "province-01",
    district_id: "district-001",
    commune_id: "commune-0001",
  },
  items: [
    {
      variation_id: "variation-001",
      quantity: 1,
      variation_info: { retail_price: 500_000 },
    },
  ],
};

const variation: PancakeCatalogVariation = {
  id: "variation-001",
  productId: "product-001",
  displayId: "display-001",
  barcode: "barcode-001",
  fields: [],
  imageUrls: [],
  isHidden: false,
  isLocked: false,
  retailPrice: 500_000,
  retailPriceAfterDiscount: 500_000,
  product: { id: "product-001", name: "Product" },
  warehouseStocks: [{ warehouseId: "warehouse-001", remainQuantity: 2 }],
  sellableStock: 2,
};

test("order gateway delegates live validation to the reviewed complete catalog traversal", async () => {
  const client: TestGatewayClient = {
    async getJson() {
      throw new Error("gateway must not invent its own catalog request");
    },
    async postJson() {
      throw new Error("not used");
    },
  };
  let observedClient: unknown;
  let observedShopId: number | undefined;

  const gateway = createPancakeOrderGateway(
    client,
    async ({ client: inputClient, shopId }: { client: TestGatewayClient; shopId: number }) => {
      observedClient = inputClient;
      observedShopId = shopId;
      return [variation];
    },
  );

  assert.deepEqual(await gateway.fetchCompleteCatalog(4_741_464), [variation]);
  assert.equal(observedClient, client);
  assert.equal(observedShopId, 4_741_464);
});

const variationFixture = (
  JSON.parse(
    readFileSync(new URL("../fixtures/pancake/product-variations.json", import.meta.url), "utf8"),
  ) as { data: Record<string, unknown>[] }
).data[0]!;

function rawVariation(id: string) {
  return { ...variationFixture, id };
}

function variationPage(data: unknown[]) {
  return {
    success: true,
    data,
    page_number: 1,
    page_size: 100,
    total_entries: data.length,
    total_pages: 1,
  };
}

test("checkout reads only the variations an order touches, in one filtered request", async () => {
  const calls: { endpoint: string; query: unknown }[] = [];
  const client: TestGatewayClient = {
    async getJson(endpoint, query) {
      calls.push({ endpoint, query });
      const ids = (query?.["variation_ids[]"] ?? []) as readonly string[];
      return variationPage(ids.map(rawVariation));
    },
    async postJson() {
      throw new Error("not used");
    },
  };
  const gateway = createPancakeOrderGateway(client, async () => {
    throw new Error("a two-line order must not page the whole catalog");
  });

  const live = await gateway.fetchVariations(4_741_464, ["v-1", "v-2", "v-1"]);

  assert.deepEqual(live.map((row) => row.id), ["v-1", "v-2"]);
  assert.deepEqual(calls, [
    {
      endpoint: "/shops/4741464/products/variations",
      query: { page_number: 1, page_size: 100, "variation_ids[]": ["v-1", "v-2"] },
    },
  ]);
  assert.deepEqual(await gateway.fetchVariations(4_741_464, []), []);
  assert.equal(calls.length, 1, "nothing to read means no request");
});

test("checkout splits a large targeted read into concurrent 100-id requests", async () => {
  const sizes: number[] = [];
  const client: TestGatewayClient = {
    async getJson(_endpoint, query) {
      const ids = (query?.["variation_ids[]"] ?? []) as readonly string[];
      sizes.push(ids.length);
      return variationPage(ids.map(rawVariation));
    },
    async postJson() {
      throw new Error("not used");
    },
  };
  const gateway = createPancakeOrderGateway(client);
  const ids = Array.from({ length: 150 }, (_, index) => `v-${index}`);

  const live = await gateway.fetchVariations(4_741_464, ids);

  assert.equal(live.length, 150);
  assert.deepEqual(sizes, [100, 50]);
});

test("checkout falls back to the complete traversal when Pancake ignores the id filter", async () => {
  const client: TestGatewayClient = {
    async getJson() {
      // The filter was not honoured: the answer names a variation nobody asked for.
      return variationPage([rawVariation("someone-else")]);
    },
    async postJson() {
      throw new Error("not used");
    },
  };
  let traversals = 0;
  const gateway = createPancakeOrderGateway(client, async () => {
    traversals += 1;
    return [variation, { ...variation, id: "not-in-this-order" }];
  });

  assert.deepEqual(await gateway.fetchVariations(4_741_464, ["variation-001"]), [variation]);
  assert.equal(traversals, 1);
});

test("a failed targeted read is not retried as a full traversal", async () => {
  const client: TestGatewayClient = {
    async getJson() {
      throw new Error("network down");
    },
    async postJson() {
      throw new Error("not used");
    },
  };
  const gateway = createPancakeOrderGateway(client, async () => {
    throw new Error("must not page the catalog after a transport failure");
  });

  await assert.rejects(gateway.fetchVariations(4_741_464, ["variation-001"]), /network down/);
});

test("order gateway posts the strict reviewed request and accepts documented/observed create statuses", async () => {
  let endpoint = "";
  let postedBody: unknown;
  let postOptions: PostJsonOptions | undefined;
  const client: TestGatewayClient = {
    async getJson() {
      throw new Error("not used");
    },
    async postJson(inputEndpoint: string, body: unknown, options?: PostJsonOptions) {
      endpoint = inputEndpoint;
      postedBody = body;
      postOptions = options;
      return { id: 700_001 };
    },
  };

  const gateway = createPancakeOrderGateway(client, async () => []);
  assert.deepEqual(await gateway.createOrder(request), { id: 700_001 });
  assert.equal(endpoint, "/shops/4741464/orders");
  assert.equal(postedBody, request);
  assert.deepEqual(postOptions, { expectedStatus: [200, 201] });
  assert.equal("cod" in request, false);
});
