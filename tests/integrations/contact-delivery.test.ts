import assert from "node:assert/strict";
import test from "node:test";

import {
  createContactDelivery,
  sendContactEmailViaResend,
  validateContactPayload,
} from "../../src/contact/contact-delivery.ts";

const validPayload = {
  name: "  Nguyễn An  ",
  email: " an@example.com ",
  message: "  Tôi cần tư vấn sản phẩm.  ",
};

test("contact validation accepts only the approved payload and trims values", () => {
  assert.deepEqual(validateContactPayload(validPayload), {
    ok: true,
    value: {
      name: "Nguyễn An",
      email: "an@example.com",
      message: "Tôi cần tư vấn sản phẩm.",
    },
  });

  assert.equal(validateContactPayload(null).ok, false);
  assert.equal(validateContactPayload([]).ok, false);
  assert.equal(validateContactPayload({ ...validPayload, phone: "0923159666" }).ok, false);
  assert.equal(validateContactPayload({ ...validPayload, name: "a".repeat(101) }).ok, false);
  assert.equal(validateContactPayload({ ...validPayload, email: `a@${"b".repeat(250)}.com` }).ok, false);
  assert.equal(validateContactPayload({ ...validPayload, email: "a@example.com\r\nBcc:x@example.com" }).ok, false);
  assert.equal(validateContactPayload({ ...validPayload, message: "a".repeat(4001) }).ok, false);
});

test("contact delivery consumes the limiter before calling the provider", async () => {
  const calls: string[] = [];
  const delivery = createContactDelivery({
    consumeRateLimits: async () => {
      calls.push("limit");
      return true;
    },
    sendEmail: async () => {
      calls.push("send");
      return { ok: true, id: "email-1" };
    },
  });

  assert.deepEqual(await delivery.submit(validPayload, "bucket-1", "submission-1"), { ok: true });
  assert.deepEqual(calls, ["limit", "send"]);
});

test("contact delivery returns a bounded rate-limit error without provider access", async () => {
  let sends = 0;
  const delivery = createContactDelivery({
    consumeRateLimits: async () => false,
    sendEmail: async () => {
      sends += 1;
      return { ok: true, id: "email-1" };
    },
  });

  assert.deepEqual(await delivery.submit(validPayload, "bucket-1", "submission-1"), {
    ok: false,
    reason: "RATE_LIMITED",
  });
  assert.equal(sends, 0);
});

test("Resend transport owns fixed headers and accepts success only with an email id", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ id: "email-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await sendContactEmailViaResend(
    { name: "Nguyễn An", email: "an@example.com", message: "Xin chào" },
    {
      apiKey: "test-api-key",
      to: "support@example.com",
      idempotencyKey: "submission-1",
      fetchImpl,
    },
  );

  assert.deepEqual(result, { ok: true, id: "email-123" });
  assert.equal(request?.input, "https://api.resend.com/emails");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(request?.init?.headers, {
    Authorization: "Bearer test-api-key",
    "Content-Type": "application/json",
    "Idempotency-Key": "submission-1",
    "User-Agent": "la-na-design-contact/1.0",
  });
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    from: "website@lanadesign.vn",
    to: ["support@example.com"],
    reply_to: "an@example.com",
    subject: "Liên hệ website La.na Design",
    text: "Tên: Nguyễn An\nEmail: an@example.com\n\nXin chào",
  });
});

test("Resend transport never treats provider errors or malformed success as sent", async () => {
  const payload = { name: "Nguyễn An", email: "an@example.com", message: "Xin chào" };
  const base = { apiKey: "test-api-key", to: "support@example.com", idempotencyKey: "submission-1" };

  assert.deepEqual(
    await sendContactEmailViaResend(payload, {
      ...base,
      fetchImpl: async () =>
        new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429 }),
    }),
    { ok: false, reason: "PROVIDER_ERROR", status: 429 },
  );

  assert.deepEqual(
    await sendContactEmailViaResend(payload, {
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    { ok: false, reason: "PROVIDER_ERROR", status: 200 },
  );
});
