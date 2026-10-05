import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleFlowTryOnClient } from "../../src/integrations/google-flow-try-on/client.ts";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../support/try-on-fixtures.ts";

const config = {
  workerUrl: "http://flow-worker:8787",
  workerToken: "t".repeat(64),
} as const;
const person = { bytes: JPEG_BYTES, mimeType: "image/jpeg" } as const;
const product = { bytes: PNG_BYTES, mimeType: "image/png" } as const;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Call = { url: string; init: RequestInit };

function harness(response: Response | (() => Response | Promise<Response>)) {
  const calls: Call[] = [];
  const client = createGoogleFlowTryOnClient({
    config,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return typeof response === "function" ? response() : response;
    },
    timeoutMs: 5_000,
  });
  return { client, calls };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the storefront sends exactly the two approved images to the private worker and no prompt/model", async () => {
  const { client, calls } = harness(
    json({
      ok: true,
      model: "nano-banana-pro",
      mimeType: "image/png",
      imageBase64: b64(PNG_BYTES),
    }),
  );

  const result = await client.generate({ person, product });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://flow-worker:8787/v1/try-on");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.redirect, "error");

  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${config.workerToken}`);
  assert.equal(headers.get("content-type"), "application/json");

  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body, {
    person: { mimeType: "image/jpeg", imageBase64: b64(JPEG_BYTES) },
    product: { mimeType: "image/png", imageBase64: b64(PNG_BYTES) },
  });
  assert.equal("prompt" in body, false);
  assert.equal("model" in body, false);
});

test("a worker success returns one signature-validated image", async () => {
  const { client } = harness(
    json({
      ok: true,
      model: "nano-banana-2",
      mimeType: "image/png",
      imageBase64: b64(PNG_BYTES),
    }),
  );
  const result = await client.generate({ person, product });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/png");
    assert.deepEqual([...result.image.bytes], [...PNG_BYTES]);
  }
});

test("untrusted worker output is rejected", async () => {
  const cases = [
    {},
    { ok: true, model: "unknown", mimeType: "image/png", imageBase64: b64(PNG_BYTES) },
    { ok: true, model: "nano-banana-pro", mimeType: "text/html", imageBase64: b64(PNG_BYTES) },
    { ok: true, model: "nano-banana-pro", mimeType: "image/jpeg", imageBase64: b64(PNG_BYTES) },
    { ok: true, model: "nano-banana-pro", mimeType: "image/png", imageBase64: "not base64!!" },
    { ok: true, model: "nano-banana-pro", mimeType: "image/png", imageBase64: b64(WEBP_BYTES) },
  ];
  for (const body of cases) {
    const { client } = harness(json(body));
    assert.deepEqual(await client.generate({ person, product }), {
      ok: false,
      reason: "GENERATION_FAILED",
    });
  }
});

test("worker failure classes map to the existing safe try-on reasons", async () => {
  const cases: Array<[number, unknown, string]> = [
    [401, { ok: false, reason: "AUTH_FAILED" }, "AUTH_FAILED"],
    [403, { ok: false, reason: "AUTH_FAILED" }, "AUTH_FAILED"],
    [409, { ok: false, reason: "BUSY" }, "BUSY"],
    [429, { ok: false, reason: "BUSY" }, "BUSY"],
    [422, { ok: false, reason: "SAFETY_BLOCKED" }, "SAFETY_BLOCKED"],
    [504, { ok: false, reason: "TIMEOUT" }, "TIMEOUT"],
    [502, { ok: false, reason: "GENERATION_FAILED", detail: "secret upstream text" }, "GENERATION_FAILED"],
  ];
  for (const [status, body, reason] of cases) {
    const { client } = harness(json(body, status));
    const result = await client.generate({ person, product });
    assert.deepEqual(result, { ok: false, reason });
    assert.doesNotMatch(JSON.stringify(result), /secret upstream text/);
  }
});

test("network failure and deadline expiry do not escape provider detail", async () => {
  const network = createGoogleFlowTryOnClient({
    config,
    fetch: async () => {
      throw new TypeError("connect ECONNREFUSED token=secret");
    },
    timeoutMs: 1_000,
  });
  assert.deepEqual(await network.generate({ person, product }), {
    ok: false,
    reason: "GENERATION_FAILED",
  });

  const timed = createGoogleFlowTryOnClient({
    config,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
    timeoutMs: 20,
  });
  assert.deepEqual(await timed.generate({ person, product }), {
    ok: false,
    reason: "TIMEOUT",
  });
});
