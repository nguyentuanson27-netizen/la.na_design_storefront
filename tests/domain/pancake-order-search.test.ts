import assert from "node:assert/strict";
import test from "node:test";

import {
  searchOrderByMarker,
  sanitizeSecrets,
} from "../../src/integrations/pancake/order-search.ts";

test("sanitizeSecrets removes credentials and keys from error messages", () => {
  const secretKey = "a1b2c3d4e5f607182930415263748596";
  const raw = `Failed to fetch https://pos.pages.fm/api/v1/shops/123/orders?api_key=${secretKey} with Authorization: Bearer secret-token-123456`;
  const sanitized = sanitizeSecrets(raw);

  assert.equal(sanitized.includes(secretKey), false);
  assert.equal(sanitized.includes("secret-token-123456"), false);
  assert.ok(sanitized.includes("[REDACTED]"));
});

test("searchOrderByMarker requires valid shopId and marker", async () => {
  const client = { async getJson() { return { data: [] }; } };

  await assert.rejects(
    () => searchOrderByMarker(client, 0, "marker"),
    /Pancake shop id must be a positive safe integer/,
  );
  await assert.rejects(
    () => searchOrderByMarker(client, 123, ""),
    /Marker must be a non-empty string/,
  );
});

test("searchOrderByMarker returns FOUND when exactly one order matches in note or address", async () => {
  const marker = "[ORDER:TEST-001]";
  const client = {
    async getJson(_endpoint: string, query?: Readonly<Record<string, unknown>>) {
      assert.equal(query?.page_number, 1);
      return {
        total_pages: 1,
        data: [
          { id: 1001, note: `Customer request ${marker}`, shipping_address: { address: "Hanoi" } },
          { id: 1002, note: "Another order", shipping_address: { address: "Hanoi" } },
        ],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker);
  assert.deepEqual(result, { kind: "FOUND", orderId: "1001" });
});

test("searchOrderByMarker returns ABSENT when full window has zero matches", async () => {
  const marker = "[ORDER:TEST-002]";
  let calls = 0;
  const client = {
    async getJson() {
      calls += 1;
      return {
        total_pages: 2,
        data: [{ id: calls, note: "Unrelated", shipping_address: { address: "HCM" } }],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker, { maxPages: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(result, { kind: "ABSENT" });
});

test("searchOrderByMarker returns AMBIGUOUS when multiple orders match unique marker", async () => {
  const marker = "[ORDER:TEST-DUPLICATE]";
  const client = {
    async getJson() {
      return {
        total_pages: 1,
        data: [
          { id: 2001, note: marker },
          { id: 2002, note: marker },
        ],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker);
  assert.deepEqual(result, {
    kind: "AMBIGUOUS",
    reason: "multiple orders matched the unique marker",
  });
});

test("searchOrderByMarker returns AMBIGUOUS when pagination is contradictory", async () => {
  const marker = "[ORDER:TEST-PAG]";
  for (const total_pages of ["invalid", -1, 0]) {
    const client = {
      async getJson() {
        return {
          total_pages: total_pages as unknown as number,
          data: [{ id: 1, note: "Unrelated" }],
        };
      },
    };

    const result = await searchOrderByMarker(client, 1720000650, marker);
    assert.deepEqual(result, {
      kind: "AMBIGUOUS",
      reason: "invalid or contradictory order pagination metadata",
    });
  }
});

test("searchOrderByMarker returns ABSENT when shop has 0 orders and total_pages is 0", async () => {
  const marker = "[ORDER:TEST-EMPTY]";
  const client = {
    async getJson() {
      return {
        total_pages: 0,
        data: [],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker);
  assert.deepEqual(result, { kind: "ABSENT" });
});

test("searchOrderByMarker returns AMBIGUOUS when maxPages is reached before covering all pages", async () => {
  const marker = "[ORDER:TEST-TRUNCATED]";
  const client = {
    async getJson() {
      return {
        total_pages: 5, // More than maxPages
        data: [],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker, { maxPages: 2 });
  assert.deepEqual(result, {
    kind: "AMBIGUOUS",
    reason: "bounded order search did not cover all reported pages",
  });
});

test("searchOrderByMarker catches errors and sanitizes secrets in reason", async () => {
  const secretKey = "a1b2c3d4e5f607182930415263748596";
  const client = {
    async getJson() {
      throw new Error(`API connection failed for api_key=${secretKey}`);
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, "marker");
  assert.equal(result.kind, "AMBIGUOUS");
  assert.equal(result.reason.includes(secretKey), false);
  assert.ok(result.reason.includes("[REDACTED]"));
});

test("searchOrderByMarker returns AMBIGUOUS when matching order has malformed id", async () => {
  const marker = "[ORDER:TEST-MALFORMED-ID]";
  const malformedIds = [
    "abc",
    1.5,
    {},
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "01001",
    "9007199254740992",
  ];

  for (const malformedId of malformedIds) {
    const client = {
      async getJson() {
        return {
          total_pages: 1,
          data: [{ id: malformedId, note: marker }],
        };
      },
    };

    const result = await searchOrderByMarker(client, 1720000650, marker);
    assert.equal(
      result.kind,
      "AMBIGUOUS",
      `Expected AMBIGUOUS for malformed id ${String(malformedId)}, got ${JSON.stringify(result)}`,
    );
    if (result.kind === "AMBIGUOUS") {
      assert.equal(result.reason, "matching order has invalid id");
    }
  }
});

test("searchOrderByMarker returns FOUND for canonical numeric string order id", async () => {
  const marker = "[ORDER:TEST-CANONICAL-STRING-ID]";
  const client = {
    async getJson() {
      return {
        total_pages: 1,
        data: [{ id: "987654", note: marker }],
      };
    },
  };

  const result = await searchOrderByMarker(client, 1720000650, marker);
  assert.deepEqual(result, { kind: "FOUND", orderId: "987654" });
});

