import assert from "node:assert/strict";
import test from "node:test";

import {
  TRY_ON_MODEL,
  buildPredictRequest,
  createVertexTryOnClient,
} from "../../src/integrations/vertex-try-on/client.ts";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../support/try-on-fixtures.ts";

const person = { bytes: JPEG_BYTES, mimeType: "image/jpeg" } as const;
const product = { bytes: PNG_BYTES, mimeType: "image/png" } as const;
const config = { projectId: "lana-design-prod", location: "asia-southeast1" };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Call = { url: string; init: RequestInit };

function harness(respond: () => Response | Promise<Response>, token: () => Promise<string> = async () => "test-token") {
  const calls: Call[] = [];
  const client = createVertexTryOnClient({
    config,
    getAccessToken: token,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond();
    },
    timeoutMs: 5_000,
  });
  return { client, calls };
}

const okBody = (image: Uint8Array = PNG_BYTES, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ predictions: [{ bytesBase64Encoded: b64(image), mimeType: "image/png", ...extra }] });
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

test("the request pins the model, region, one person image, one product image and every provider control", () => {
  const request = buildPredictRequest({ config, person, product });

  assert.equal(TRY_ON_MODEL, "virtual-try-on-001");
  assert.equal(
    request.url,
    "https://asia-southeast1-aiplatform.googleapis.com/v1/projects/lana-design-prod/locations/asia-southeast1/publishers/google/models/virtual-try-on-001:predict",
  );
  assert.deepEqual(request.body, {
    instances: [
      {
        personImage: { image: { bytesBase64Encoded: b64(JPEG_BYTES) } },
        productImages: [{ image: { bytesBase64Encoded: b64(PNG_BYTES) } }],
      },
    ],
    parameters: {
      sampleCount: 1,
      personGeneration: "allow-all",
      safetySetting: "block-low-and-above",
      addWatermark: true,
    },
  });
});

test("the request never carries storageUri, a prompt, or a second product image", () => {
  const serialized = JSON.stringify(buildPredictRequest({ config, person, product }).body);
  assert.doesNotMatch(serialized, /storageUri|gcsUri|prompt|seed/);
  const body = buildPredictRequest({ config, person, product }).body;
  assert.equal(body.instances.length, 1);
  assert.equal(body.instances[0]!.productImages.length, 1);
  assert.equal(body.parameters.sampleCount, 1);
});

test("generate posts once with a bearer token and returns the single validated image", async () => {
  const { client, calls } = harness(() => json(okBody()));
  const result = await client.generate({ person, product });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/png");
    assert.deepEqual([...result.image.bytes], [...PNG_BYTES]);
  }
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-token");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.redirect, "error");
});

test("a provider safety refusal fails closed after exactly one attempt (no weaker retry)", async () => {
  for (const respond of [
    () => json(JSON.stringify({ predictions: [{ raiFilteredReason: "Support codes: 58061214" }] })),
    () => json(JSON.stringify({ error: { code: 400, message: "Image was blocked by safety filters." } }), 400),
    () =>
      json(JSON.stringify({ error: { code: 400, message: "Responsible AI filtered the output." } }), 400),
  ]) {
    const { client, calls } = harness(respond);
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "SAFETY_BLOCKED" });
    assert.equal(calls.length, 1);
  }
});

test("a 400 that is a request-validation error is NOT a safety block (it is an integration fault)", async () => {
  for (const message of [
    "Invalid value at 'parameters.safetySetting' (type.googleapis.com/google.cloud.aiplatform.v1.Value): \"block_low_and_above\"",
    "Invalid personGeneration value. Supported policy values: dont-allow, allow-adult, allow-all.",
    "Request contains an invalid argument: unsupported filtered field.",
    "Unable to parse instances[0].personImage",
  ]) {
    const { client, calls } = harness(() => json(JSON.stringify({ error: { code: 400, message } }), 400));
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" }, message);
    assert.equal(calls.length, 1);
  }
});

test("known provider refusal markers on a 400 are safety blocks", async () => {
  for (const message of [
    "Image was blocked by safety filters.",
    "Responsible AI filtered the output.",
    "Your current safety filter threshold filtered out 1 generated images. Support codes: 29310472",
  ]) {
    const { client } = harness(() => json(JSON.stringify({ error: { code: 400, message } }), 400));
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "SAFETY_BLOCKED" }, message);
  }
});

test("upstream failures map to safe reason classes and never echo the upstream body", async () => {
  const secret = "projects/lana-design-prod INTERNAL-DETAIL";
  const cases: Array<[() => Response, string]> = [
    [() => json(JSON.stringify({ error: { message: secret } }), 401), "AUTH_FAILED"],
    [() => json(JSON.stringify({ error: { message: secret } }), 403), "AUTH_FAILED"],
    [() => json(JSON.stringify({ error: { message: secret } }), 429), "BUSY"],
    [() => json(JSON.stringify({ error: { message: secret } }), 500), "GENERATION_FAILED"],
    [() => json(JSON.stringify({ error: { message: secret } }), 503), "GENERATION_FAILED"],
    [() => json(JSON.stringify({ error: { message: secret } }), 400), "GENERATION_FAILED"],
    [() => json("not json"), "GENERATION_FAILED"],
  ];
  for (const [respond, reason] of cases) {
    const { client, calls } = harness(respond);
    const result = await client.generate({ person, product });
    assert.deepEqual(result, { ok: false, reason });
    assert.doesNotMatch(JSON.stringify(result), /INTERNAL-DETAIL|lana-design-prod/);
    assert.equal(calls.length, 1);
  }
});

test("an access-token failure is AUTH_FAILED and the provider is never called", async () => {
  const { client, calls } = harness(
    () => json(okBody()),
    async () => {
      throw new Error("could not load credentials /secret/path.json");
    },
  );
  const result = await client.generate({ person, product });
  assert.deepEqual(result, { ok: false, reason: "AUTH_FAILED" });
  assert.equal(calls.length, 0);
});

test("a timeout is TIMEOUT", async () => {
  const client = createVertexTryOnClient({
    config,
    getAccessToken: async () => "t",
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
    timeoutMs: 20,
  });
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "TIMEOUT" });
});

test("a network error is GENERATION_FAILED", async () => {
  const client = createVertexTryOnClient({
    config,
    getAccessToken: async () => "t",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    timeoutMs: 1_000,
  });
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
});

test("untrusted provider output is validated: shape, count, encoding, signature and declared type", async () => {
  const bad: Array<() => Response> = [
    () => json(JSON.stringify({})),
    () => json(JSON.stringify({ predictions: [] })),
    () => json(JSON.stringify({ predictions: "x" })),
    () => json(JSON.stringify({ predictions: [{}] })),
    () => json(JSON.stringify({ predictions: [{ bytesBase64Encoded: 42, mimeType: "image/png" }] })),
    () => json(JSON.stringify({ predictions: [{ bytesBase64Encoded: "!!!not base64!!!", mimeType: "image/png" }] })),
    // One candidate is requested, so more than one is a contract violation.
    () =>
      json(
        JSON.stringify({
          predictions: [
            { bytesBase64Encoded: b64(PNG_BYTES), mimeType: "image/png" },
            { bytesBase64Encoded: b64(PNG_BYTES), mimeType: "image/png" },
          ],
        }),
      ),
    // Bytes that are not an allowed image, however they are labelled.
    () => json(okBody(WEBP_BYTES)),
    () => json(okBody(new TextEncoder().encode("<script>alert(1)</script>"))),
    // Declared type disagrees with the bytes.
    () => json(JSON.stringify({ predictions: [{ bytesBase64Encoded: b64(PNG_BYTES), mimeType: "image/jpeg" }] })),
    () => json(JSON.stringify({ predictions: [{ bytesBase64Encoded: b64(PNG_BYTES), mimeType: "text/html" }] })),
  ];
  for (const respond of bad) {
    const { client } = harness(respond);
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
  }
});

test("an absurdly large provider response is rejected rather than buffered", async () => {
  const huge = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  }), { status: 200 });
  const { client } = harness(() => huge);
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
});
