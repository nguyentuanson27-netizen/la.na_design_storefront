import assert from "node:assert/strict";
import test from "node:test";

import { createPancakeOrderGateway } from "../../src/integrations/pancake/order-gateway.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";

type PostJsonOptions = Readonly<{ expectedStatus?: number | readonly number[] }>;
type TestGatewayClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, string | number | boolean>>): Promise<unknown>;
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
