import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPancakeCreateOrderRequest,
  parsePancakeCreateOrderResponse,
} from "../../src/integrations/pancake/order-create.ts";
import { PancakeClient } from "../../src/integrations/pancake/client.ts";
import { createPancakeOrderGateway } from "../../src/integrations/pancake/order-gateway.ts";

test("create-order mapper emits only the reviewed server-owned allowlist and omits unverified semantic fields", () => {
  const request = buildPancakeCreateOrderRequest({
    shopId: 920_007,
    guestName: "Nguyễn Văn A",
    guestPhone: "0901234567",
    provinceRef: "province-01",
    districtRef: "district-001",
    communeRef: "commune-0001",
    addressDetail: "12 Đường A",
    note: "Gọi trước khi giao",
    shippingFeeVnd: 30_000,
    lines: [
      {
        pancakeVariationId: "variation-001",
        quantity: 2,
        unitPriceVnd: 500_000,
      },
    ],
  });

  assert.deepEqual(request, {
    shop_id: 920_007,
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
        quantity: 2,
        variation_info: { retail_price: 500_000 },
      },
    ],
    note: "Gọi trước khi giao",
  });

  assert.equal("cod" in request, false);
  assert.equal("custom_id" in request, false);
  assert.equal("cash" in request, false);
  assert.equal("status" in request, false);
});

test("create-order mapper omits blank optional note and optional unverified cod", () => {
  const request = buildPancakeCreateOrderRequest({
    shopId: 1,
    guestName: "A",
    guestPhone: "0900000000",
    provinceRef: "p",
    districtRef: "d",
    communeRef: "c",
    addressDetail: "x",
    note: null,
    shippingFeeVnd: 0,
    lines: [{ pancakeVariationId: "v", quantity: 1, unitPriceVnd: 0 }],
  });
  assert.equal("note" in request, false);
  assert.equal(request.is_free_shipping, true);
  assert.equal("cod" in request, false);

  assert.throws(
    () =>
      buildPancakeCreateOrderRequest({
        shopId: 1,
        guestName: "A",
        guestPhone: "0900000000",
        provinceRef: "p",
        districtRef: "d",
        communeRef: "c",
        addressDetail: "x",
        note: null,
        shippingFeeVnd: 0,
        lines: [{ pancakeVariationId: "", quantity: 1, unitPriceVnd: 1 }],
      }),
    /Pancake create-order input is invalid/,
  );

  assert.throws(
    () =>
      buildPancakeCreateOrderRequest({
        shopId: 1,
        guestName: "A",
        guestPhone: "0900000000",
        provinceRef: "p",
        districtRef: "d",
        communeRef: "c",
        addressDetail: "x",
        note: null,
        shippingFeeVnd: 0,
        lines: [{ pancakeVariationId: "v", quantity: 2, unitPriceVnd: Number.MAX_SAFE_INTEGER }],
      }),
    /Pancake create-order input is invalid/,
  );
});

test("create-order mapper does not infer cod even when subtotal plus shipping would overflow", () => {
  const request = buildPancakeCreateOrderRequest({
    shopId: 1,
    guestName: "A",
    guestPhone: "0900000000",
    provinceRef: "p",
    districtRef: "d",
    communeRef: "c",
    addressDetail: "x",
    note: null,
    shippingFeeVnd: 1,
    lines: [
      {
        pancakeVariationId: "v",
        quantity: 1,
        unitPriceVnd: Number.MAX_SAFE_INTEGER,
      },
    ],
  });
  assert.equal("cod" in request, false);
});

test("create-order response requires a positive safe integer Pancake order id", () => {
  assert.equal(parsePancakeCreateOrderResponse({ id: 123456 }), "123456");
  assert.equal(parsePancakeCreateOrderResponse({ success: true, data: { id: 123456 } }), "123456");

  for (const payload of [
    {},
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: "123" },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    null,
  ]) {
    assert.throws(() => parsePancakeCreateOrderResponse(payload), /Pancake create-order response is invalid/);
  }
});


test("order gateway accepts observed HTTP 201 create success", async () => {
  const client = new PancakeClient({
    apiKey: "test-api-key",
    fetcher: async (_input, init) => {
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ success: true, data: { id: 123456 } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const gateway = createPancakeOrderGateway(client);
  const request = buildPancakeCreateOrderRequest({
    shopId: 920_007,
    guestName: "Nguyễn Văn A",
    guestPhone: "0901234567",
    provinceRef: "province-01",
    districtRef: "district-001",
    communeRef: "commune-0001",
    addressDetail: "12 Đường A",
    note: "HTTP 201 regression",
    shippingFeeVnd: 0,
    lines: [{ pancakeVariationId: "variation-001", quantity: 1, unitPriceVnd: 500_000 }],
  });

  const response = await gateway.createOrder(request);
  assert.equal(parsePancakeCreateOrderResponse(response), "123456");
});
