import assert from "node:assert/strict";
import test from "node:test";

import {
  PANCAKE_ORDER_STATUS_CODES,
  PancakeOrderStatusContractError,
  comparePancakeOrderStatusTimestamps,
  parsePancakeOrderStatusResponse,
} from "../../src/integrations/pancake/order-status.ts";

const EXPECTED_STATUS_CODES = [0, 17, 11, 12, 13, 20, 1, 8, 9, 2, 3, 16, 4, 15, 5, 6, 7] as const;

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1418,
    system_id: 862,
    shop_id: 4,
    inserted_at: "2026-08-12T08:10:11Z",
    updated_at: "2026-08-12T09:12:13Z",
    status: 9,
    bill_full_name: "must not escape parser",
    bill_phone_number: "must not escape parser",
    ...overrides,
  };
}

test("Pancake order status codes match the verified OpenAPI enum", () => {
  assert.deepEqual(PANCAKE_ORDER_STATUS_CODES, EXPECTED_STATUS_CODES);
});

test("order status parser returns only the allowlisted status fields for the expected shop and order", () => {
  assert.deepEqual(
    parsePancakeOrderStatusResponse(validPayload(), { shopId: 4, orderId: "1418" }),
    {
      orderId: "1418",
      systemId: 862,
      shopId: 4,
      status: 9,
      insertedAt: "2026-08-12T08:10:11Z",
      updatedAt: "2026-08-12T09:12:13Z",
    },
  );
});

test("order status parser accepts data-wrapped responses as returned by Pancake API", () => {
  assert.deepEqual(
    parsePancakeOrderStatusResponse(
      { success: true, data: validPayload() },
      { shopId: 4, orderId: "1418" },
    ),
    {
      orderId: "1418",
      systemId: 862,
      shopId: 4,
      status: 9,
      insertedAt: "2026-08-12T08:10:11Z",
      updatedAt: "2026-08-12T09:12:13Z",
    },
  );
});

test("order status parser accepts timezone-less Pancake wall-clock timestamps without inventing an offset", () => {
  assert.deepEqual(
    parsePancakeOrderStatusResponse(
      validPayload({
        inserted_at: "2026-08-12T08:10:11.123456789",
        updated_at: "2026-08-12T09:12:13.987654321",
      }),
      { shopId: 4, orderId: "1418" },
    ),
    {
      orderId: "1418",
      systemId: 862,
      shopId: 4,
      status: 9,
      insertedAt: "2026-08-12T08:10:11.123456789",
      updatedAt: "2026-08-12T09:12:13.987654321",
    },
  );
});

test("order status timestamp comparison orders timezone-less wall clocks but rejects mixed timezone semantics", () => {
  assert.equal(
    comparePancakeOrderStatusTimestamps(
      "2026-08-12T10:00:00.123456800",
      "2026-08-12T10:00:00.123456700",
    ),
    1,
  );
  assert.equal(
    comparePancakeOrderStatusTimestamps(
      "2026-08-12T09:59:59.999999999",
      "2026-08-12T10:00:00",
    ),
    -1,
  );
  assert.throws(
    () =>
      comparePancakeOrderStatusTimestamps(
        "2026-08-12T10:00:00",
        "2026-08-12T10:00:00Z",
      ),
    PancakeOrderStatusContractError,
  );
});

test("order status parser accepts every verified status code", () => {
  for (const status of EXPECTED_STATUS_CODES) {
    assert.equal(
      parsePancakeOrderStatusResponse(validPayload({ status }), { shopId: 4, orderId: "1418" })
        .status,
      status,
    );
  }
});

test("order status parser fails closed on unknown statuses and mismatched identity", () => {
  for (const [payload, expected] of [
    [validPayload({ status: 99 }), { shopId: 4, orderId: "1418" }],
    [validPayload({ shop_id: 5 }), { shopId: 4, orderId: "1418" }],
    [validPayload({ id: 1419 }), { shopId: 4, orderId: "1418" }],
  ] as const) {
    assert.throws(
      () => parsePancakeOrderStatusResponse(payload, expected),
      PancakeOrderStatusContractError,
    );
  }
});

test("order status parser rejects missing, malformed, or non-canonical required fields", () => {
  const invalidPayloads = [
    null,
    [],
    validPayload({ id: 0 }),
    validPayload({ system_id: 0 }),
    validPayload({ shop_id: 4.5 }),
    validPayload({ inserted_at: "not-a-date" }),
    validPayload({ updated_at: "2026-08-12" }),
    validPayload({ updated_at: " 2026-08-12T09:12:13Z" }),
    validPayload({ updated_at: "2026-02-31T09:12:13Z" }),
    validPayload({ updated_at: "2026-02-31T09:12:13" }),
    validPayload({ updated_at: "2026-08-12T25:12:13Z" }),
    validPayload({ updated_at: "2026-08-12T25:12:13" }),
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => parsePancakeOrderStatusResponse(payload, { shopId: 4, orderId: "1418" }),
      PancakeOrderStatusContractError,
    );
  }
});

test("order status parser rejects invalid expected identifiers before trusting the response", () => {
  for (const expected of [
    { shopId: 0, orderId: "1418" },
    { shopId: 4, orderId: "" },
    { shopId: 4, orderId: "01418" },
    { shopId: 4, orderId: "1418 " },
    { shopId: 4, orderId: "9007199254740992" },
  ]) {
    assert.throws(
      () => parsePancakeOrderStatusResponse(validPayload(), expected),
      PancakeOrderStatusContractError,
    );
  }
});
