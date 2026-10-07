import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildMetaConversionsRequest,
  buildMetaPurchaseEvent,
  hashMetaIdentifier,
  normalizeVietnamesePhone,
  sendMetaConversionEvents,
  splitVietnameseName,
} from "../../src/integrations/meta/conversions-api.ts";
import type { MetaConversionsConfig } from "../../src/integrations/meta/pixel-config.ts";

const config: MetaConversionsConfig = Object.freeze({
  pixelId: "123456789012345",
  accessToken: "secret-token",
  graphApiVersion: "v21.0",
  testEventCode: null,
});

const identity = {
  phone: "0912 345 678",
  fullName: "Nguyễn Văn An",
  clientIpAddress: "203.0.113.9",
  clientUserAgent: "Mozilla/5.0",
  fbp: "fb.1.1700000000000.1234567890",
  fbc: "fb.1.1700000000000.AbCd",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("every spelling of a Vietnamese number normalizes to the same digits", () => {
  const expected = "84912345678";
  for (const written of [
    "0912345678",
    "0912 345 678",
    "+84912345678",
    "84912345678",
    "0084912345678",
    // A country code followed by the national trunk zero is a common way people write it.
    "+84 0912 345 678",
    "0084 0912345678",
    // Written without the trunk zero at all.
    "912345678",
  ]) {
    assert.equal(normalizeVietnamesePhone(written), expected, written);
  }
  assert.equal(normalizeVietnamesePhone("không có số"), null);
});

test("a Vietnamese name maps given name to fn and family name to ln", () => {
  // Vietnamese order is family first, given last — the reverse of what Meta's fields mean.
  assert.deepEqual(splitVietnameseName("Nguyễn Văn An"), { fn: "An", ln: "Nguyễn" });
  assert.deepEqual(splitVietnameseName("  Trần   Bình  "), { fn: "Bình", ln: "Trần" });
  assert.deepEqual(splitVietnameseName("An"), { fn: "An", ln: "An" });
  assert.equal(splitVietnameseName("   "), null);
});

test("names follow Meta's whitespace/punctuation normalization and retain Vietnamese accents", () => {
  assert.equal(hashMetaIdentifier("  An  "), sha256("an"));
  assert.equal(hashMetaIdentifier("Nguyễn  Văn"), sha256("nguyễnvăn"));
  assert.equal(hashMetaIdentifier("  An-O'Neil!$  "), sha256("anoneil"));
});

test("a purchase event hashes identifiers and leaves context in the clear", () => {
  const event = buildMetaPurchaseEvent({
    eventId: "ORDER-123",
    eventTimeSeconds: 1_700_000_000,
    eventSourceUrl: "https://example.test/checkout",
    valueVnd: 1_290_000,
    contents: [{ id: "ao-a054", quantity: 2, itemPrice: 429_000 }],
    identity,
  });

  assert.equal(event.event_name, "Purchase");
  // The event id is what pairs this with the browser pixel's Purchase.
  assert.equal(event.event_id, "ORDER-123");
  assert.equal(event.action_source, "website");

  const userData = event.user_data as Record<string, unknown>;
  assert.deepEqual(userData.ph, [sha256("84912345678")]);
  assert.deepEqual(userData.fn, [sha256("an")]);
  assert.deepEqual(userData.ln, [sha256("nguyễn")]);
  // Meta documents these as plain context, so hashing them would break matching outright.
  assert.equal(userData.client_ip_address, "203.0.113.9");
  assert.equal(userData.fbp, identity.fbp);

  // No raw identifier may survive anywhere in the payload.
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("912345678"), false);
  assert.equal(serialized.includes("Nguyễn"), false);

  assert.deepEqual(event.custom_data, {
    currency: "VND",
    value: 1_290_000,
    contents: [{ id: "ao-a054", quantity: 2, item_price: 429_000 }],
    content_type: "product",
  });
});

test("an absent identifier is omitted rather than hashed empty", () => {
  const event = buildMetaPurchaseEvent({
    eventId: "ORDER-124",
    eventTimeSeconds: 1_700_000_000,
    eventSourceUrl: null,
    valueVnd: 100_000,
    contents: [],
    identity: { ...identity, phone: null, fullName: null },
  });

  const userData = event.user_data as Record<string, unknown>;
  assert.equal("ph" in userData, false);
  assert.equal("fn" in userData, false);
  assert.equal("event_source_url" in event, false);
});

test("the access token travels in the body, never the URL", () => {
  const { url, body } = buildMetaConversionsRequest(config, [{ event_name: "Purchase" }]);

  assert.equal(url, "https://graph.facebook.com/v21.0/123456789012345/events");
  assert.equal(url.includes("secret-token"), false);
  assert.equal(JSON.parse(body).access_token, "secret-token");

  const withTestCode = buildMetaConversionsRequest({ ...config, testEventCode: "TEST99" }, []);
  assert.equal(JSON.parse(withTestCode.body).test_event_code, "TEST99");
});

test("transport accepts only an explicit Graph acceptance and returns safe response metadata", async () => {
  const result = await sendMetaConversionEvents(config, [{ event_name: "Purchase" }],
    async () => Response.json({ events_received: 1, messages: ["opaque warning"], fbtrace_id: "trace_1" }));
  assert.deepEqual(result, { ok: true, attempts: 1, eventsReceived: 1, traceId: "trace_1", warningCount: 1 });
});

test("200 with a missing, zero, or partial receipt is never successful", async () => {
  for (const response of [{}, { events_received: 0 }, { events_received: "1" }, { events_received: 2 }]) {
    const result = await sendMetaConversionEvents(config, [{ event_name: "Purchase" }],
      async () => Response.json(response), 100, { maxAttempts: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "INVALID_RESPONSE");
  }
});

test("transient retries preserve the complete event body and honor bounded Retry-After", async () => {
  const bodies: string[] = [];
  const delays: number[] = [];
  const event = buildMetaPurchaseEvent({ eventId: "ORDER-123", eventTimeSeconds: 1_700_000_000,
    eventSourceUrl: "https://example.test/checkout", valueVnd: 99_000, contents: [], identity });
  const result = await sendMetaConversionEvents(config, [event], async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? Response.json({ error: { code: 2, is_transient: true } }, { status: 503, headers: { "retry-after": "2" } })
      : Response.json({ events_received: 1 });
  }, 100, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(delays, [2000]);
});

test("invalid-token and invalid-payload Graph errors are permanent, even inside HTTP 200", async () => {
  for (const code of [100, 190]) {
    let attempts = 0;
    const result = await sendMetaConversionEvents(config, [{ event_name: "Purchase" }], async () => {
      attempts += 1;
      return Response.json({ error: { code, error_subcode: 99, message: "secret-token raw PII", fbtrace_id: "safe_trace" } });
    }, 100, { sleep: async () => undefined });
    assert.equal(attempts, 1);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes("raw PII"), false);
  }
});

test("network failure retries are bounded and never throw", async () => {
  let attempts = 0;
  const result = await sendMetaConversionEvents(config, [{}], async () => {
    attempts += 1; throw new Error("network down secret-token");
  }, 100, { sleep: async () => undefined });
  assert.deepEqual(result, { ok: false, reason: "NETWORK_ERROR", attempts: 3 });
  assert.equal(attempts, 3);
});

test("each retry has a fresh deadline that aborts a stalled transport", async () => {
  const signals: AbortSignal[] = [];
  const result = await sendMetaConversionEvents(config, [{}], async (_url, init) => {
    const signal = init!.signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("deadline was not applied")), 1000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  }, 10, { sleep: async () => undefined });
  assert.deepEqual(result, { ok: false, reason: "NETWORK_ERROR", attempts: 3 });
  assert.equal(new Set(signals).size, 3);
  assert.equal(signals.every((signal) => signal.aborted), true);
});

test("current optional Meta cookie appendices are preserved unhashed and organic traffic gets no fbc", () => {
  for (const fbc of [null, "fb.1.1700000000000.RealClick.UE"] as const) {
    const event = buildMetaPurchaseEvent({ eventId: "ORDER-123", eventTimeSeconds: 1_700_000_000,
      eventSourceUrl: null, valueVnd: 10, contents: [], identity: { ...identity, fbp: `${identity.fbp}.UE`, fbc } });
    const data = event.user_data as Record<string, unknown>;
    assert.equal(data.fbp, `${identity.fbp}.UE`);
    assert.equal(data.fbc, fbc ?? undefined);
  }
});

test("malformed cookies, empty names, bad phone and spoofed IP are omitted", () => {
  const event = buildMetaPurchaseEvent({ eventId: "ORDER-123", eventTimeSeconds: 1_700_000_000,
    eventSourceUrl: null, valueVnd: 10, contents: [], identity: {
      ...identity, phone: "1", fullName: "!!", clientIpAddress: "203.0.113.1, 10.0.0.1", fbp: "invalid", fbc: "invalid",
    } });
  assert.deepEqual(event.user_data, { client_user_agent: identity.clientUserAgent });
});
