import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAiAdsConversionsRequest,
  buildOpenAiAdsOrderCreatedEvent,
  sendOpenAiAdsConversionEvents,
} from "../../src/integrations/openai-ads/conversions-api.ts";
import type { OpenAiAdsConversionsConfig } from "../../src/integrations/openai-ads/config.ts";

const config: OpenAiAdsConversionsConfig = {
  pixelId: "pixel_abc",
  apiKey: "server-secret",
};

test("order_created uses the canonical order id, VND totals, contents, and matching context", () => {
  const event = buildOpenAiAdsOrderCreatedEvent({
    eventId: "LA-2026-0001",
    timestampMs: 1_773_892_800_000,
    sourceUrl: "https://www.lanadesign.vn/checkout",
    oppref: "oppref_abc",
    totalVnd: 828_000,
    contents: [
      {
        id: "pan-var-101",
        groupId: "pan-prod-999",
        name: "Áo Polo Pima",
        quantity: 2,
        amountVnd: 399_000,
      },
    ],
    user: {
      obref: "123e4567-e89b-42d3-a456-426614174000",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
    },
  });

  assert.equal(event.id, "LA-2026-0001");
  assert.equal(event.type, "order_created");
  assert.equal(event.action_source, "web");
  assert.equal(event.oppref, "oppref_abc");
  assert.deepEqual(event.user, {
    obref: "123e4567-e89b-42d3-a456-426614174000",
    ip_address: "203.0.113.9",
    user_agent: "Mozilla/5.0",
  });
  assert.deepEqual(event.data, {
    type: "contents",
    amount: 828_000,
    currency: "VND",
    contents: [
      {
        id: "pan-var-101",
        group_id: "pan-prod-999",
        name: "Áo Polo Pima",
        content_type: "product",
        quantity: 2,
        amount: 399_000,
        currency: "VND",
      },
    ],
  });
});

test("untrusted OpenAI attribution cookies are bounded before entering a CAPI event", () => {
  const event = buildOpenAiAdsOrderCreatedEvent({
    eventId: "LA-2026-0002",
    timestampMs: 1_773_892_800_000,
    sourceUrl: "https://www.lanadesign.vn/checkout",
    oppref: "bad\nvalue",
    totalVnd: 100_000,
    contents: [],
    user: {
      obref: "x".repeat(300),
      ipAddress: null,
      userAgent: null,
    },
  });

  assert.equal("oppref" in event, false);
  assert.equal("user" in event, false);
});

test("the CAPI key travels only in the Authorization header", () => {
  const request = buildOpenAiAdsConversionsRequest(config, [{ type: "order_created" }]);

  assert.equal(request.url, "https://bzr.openai.com/v1/events?pid=pixel_abc");
  assert.equal(request.url.includes("server-secret"), false);
  assert.equal(request.body.includes("server-secret"), false);
  assert.equal(request.authorization, "Bearer server-secret");
  assert.deepEqual(JSON.parse(request.body), {
    validate_only: false,
    events: [{ type: "order_created" }],
  });
});

test("CAPI transport failures never throw into checkout", async () => {
  assert.deepEqual(
    await sendOpenAiAdsConversionEvents(
      config,
      [],
      async () => new Response("{}", { status: 200 }),
    ),
    { ok: true },
  );
  assert.deepEqual(
    await sendOpenAiAdsConversionEvents(
      config,
      [],
      async () => new Response("nope", { status: 400 }),
    ),
    { ok: false, reason: "HTTP_ERROR", status: 400 },
  );
  assert.deepEqual(
    await sendOpenAiAdsConversionEvents(config, [], async () => {
      throw new Error("network down");
    }),
    { ok: false, reason: "NETWORK_ERROR" },
  );
});
