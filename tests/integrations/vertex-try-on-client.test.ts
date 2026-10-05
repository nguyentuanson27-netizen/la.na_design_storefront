import assert from "node:assert/strict";
import test from "node:test";

import {
  TRY_ON_MODEL,
  TRY_ON_OUTPUT_IMAGE_SIZE,
  TRY_ON_PROMPT,
  buildGenerateContentRequest,
  createVertexTryOnClient,
} from "../../src/integrations/vertex-try-on/client.ts";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../support/try-on-fixtures.ts";

const person = { bytes: JPEG_BYTES, mimeType: "image/jpeg" } as const;
const product = { bytes: PNG_BYTES, mimeType: "image/png" } as const;
const config = { projectId: "lana-design-prod", location: "global" };
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

const okBody = (image: Uint8Array = PNG_BYTES, mimeType = "image/png") =>
  JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [
          { text: "Generated virtual try-on." },
          { inlineData: { data: b64(image), mimeType } },
        ],
      },
    }],
  });
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

test("request pins Nano Banana Pro, global generateContent, two references and quality controls", () => {
  const request = buildGenerateContentRequest({ config, person, product });

  assert.equal(TRY_ON_MODEL, "gemini-3-pro-image");
  assert.equal(TRY_ON_OUTPUT_IMAGE_SIZE, "2K");
  assert.equal(
    request.url,
    "https://aiplatform.googleapis.com/v1/projects/lana-design-prod/locations/global/publishers/google/models/gemini-3-pro-image:generateContent",
  );

  const parts = request.body.contents[0]!.parts;
  const inline = parts.filter((part) => "inlineData" in part);
  assert.equal(inline.length, 2);
  assert.deepEqual(inline[0], { inlineData: { mimeType: "image/jpeg", data: b64(JPEG_BYTES) } });
  assert.deepEqual(inline[1], { inlineData: { mimeType: "image/png", data: b64(PNG_BYTES) } });
  assert.match(TRY_ON_PROMPT, /preserving the shopper's recognizable identity/i);
  assert.match(TRY_ON_PROMPT, /preserve the garment's silhouette/i);

  assert.deepEqual(request.body.generationConfig, {
    candidateCount: 1,
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: {
      imageSize: "2K",
      imageOutputOptions: { mimeType: "image/png" },
      personGeneration: "allow_all",
    },
  });
  assert.deepEqual(
    request.body.safetySettings.map(({ category, threshold }) => [category, threshold]),
    [
      ["HARM_CATEGORY_DANGEROUS_CONTENT", "BLOCK_LOW_AND_ABOVE"],
      ["HARM_CATEGORY_HARASSMENT", "BLOCK_LOW_AND_ABOVE"],
      ["HARM_CATEGORY_HATE_SPEECH", "BLOCK_LOW_AND_ABOVE"],
      ["HARM_CATEGORY_SEXUALLY_EXPLICIT", "BLOCK_LOW_AND_ABOVE"],
    ],
  );
});

test("request has no persistence target, user prompt field, or third input image", () => {
  const request = buildGenerateContentRequest({ config, person, product });
  const serialized = JSON.stringify(request.body);
  assert.doesNotMatch(serialized, /storageUri|gcsUri|fileUri/);
  assert.equal(request.body.contents.length, 1);
  assert.equal(request.body.contents[0]!.parts.filter((part) => "inlineData" in part).length, 2);
  assert.equal(request.body.generationConfig.candidateCount, 1);
});

test("generate posts once with bearer auth and returns the single validated image", async () => {
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

test("provider safety signals fail closed after exactly one attempt", async () => {
  const bodies = [
    { promptFeedback: { blockReason: "IMAGE_SAFETY" } },
    { candidates: [{ finishReason: "SAFETY", safetyRatings: [{ blocked: true }] }] },
    { candidates: [{ finishReason: "IMAGE_SAFETY" }] },
  ];
  for (const body of bodies) {
    const { client, calls } = harness(() => json(JSON.stringify(body)));
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "SAFETY_BLOCKED" });
    assert.equal(calls.length, 1);
  }
});

test("safety 400s are safety blocks but validation 400s are integration failures", async () => {
  for (const message of [
    "Image was blocked by safety filters.",
    "Responsible AI filtered the output.",
    "This content contains words that violate Google's Responsible AI practices.",
  ]) {
    const { client } = harness(() => json(JSON.stringify({ error: { code: 400, message } }), 400));
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "SAFETY_BLOCKED" });
  }

  for (const message of [
    "Invalid value at 'generationConfig.imageConfig.personGeneration'",
    "Request contains an invalid argument: unsupported imageSize",
    "Unable to parse contents[0].parts[1].inlineData",
  ]) {
    const { client } = harness(() => json(JSON.stringify({ error: { code: 400, message } }), 400));
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
  }
});

test("a support code in bounded error details is a safety block", async () => {
  const { client } = harness(() =>
    json(JSON.stringify({
      error: {
        code: 400,
        message: "Image generation failed.",
        details: [{ detail: "filtered. Support codes: 58061214" }],
      },
    }), 400),
  );
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "SAFETY_BLOCKED" });
});

test("upstream failures map to safe reason classes and never echo provider detail", async () => {
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

test("access-token failure is AUTH_FAILED and provider is never called", async () => {
  const { client, calls } = harness(
    () => json(okBody()),
    async () => { throw new Error("could not load credentials /secret/path.json"); },
  );
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "AUTH_FAILED" });
  assert.equal(calls.length, 0);
});

test("provider timeout is TIMEOUT", async () => {
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

test("stalled token acquisition shares the deadline and never reaches Vertex", async () => {
  const calls: unknown[] = [];
  const client = createVertexTryOnClient({
    config,
    getAccessToken: () => new Promise<string>(() => undefined),
    fetch: async (url) => {
      calls.push(url);
      return json(okBody());
    },
    timeoutMs: 30,
  });
  const started = Date.now();
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "TIMEOUT" });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(calls.length, 0);
});

test("deadline is one budget across token acquisition and generation", async () => {
  const client = createVertexTryOnClient({
    config,
    getAccessToken: () => new Promise<string>((resolve) => setTimeout(() => resolve("t"), 120)),
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
    timeoutMs: 200,
  });
  const started = Date.now();
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "TIMEOUT" });
  assert.ok(Date.now() - started < 290, "provider deadline was reset after auth");
});

test("late token failure after deadline is not an unhandled rejection", async () => {
  let rejectLater!: (reason: Error) => void;
  const client = createVertexTryOnClient({
    config,
    getAccessToken: () => new Promise<string>((_resolve, reject) => { rejectLater = reject; }),
    fetch: async () => json(okBody()),
    timeoutMs: 20,
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "TIMEOUT" });
    rejectLater(new Error("late auth failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("network error is GENERATION_FAILED", async () => {
  const client = createVertexTryOnClient({
    config,
    getAccessToken: async () => "t",
    fetch: async () => { throw new TypeError("fetch failed"); },
    timeoutMs: 1_000,
  });
  assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
});

test("untrusted output validates candidate count, image count, encoding, signature and MIME", async () => {
  const candidate = (parts: unknown[]) => ({
    candidates: [{ finishReason: "STOP", content: { role: "model", parts } }],
  });
  const imagePart = (bytes: Uint8Array, mimeType = "image/png") => ({
    inlineData: { data: b64(bytes), mimeType },
  });

  const bad: Array<() => Response> = [
    () => json(JSON.stringify({})),
    () => json(JSON.stringify({ candidates: [] })),
    () => json(JSON.stringify({ candidates: "x" })),
    () => json(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] })),
    () => json(JSON.stringify(candidate([{ inlineData: { data: 42, mimeType: "image/png" } }]))),
    () => json(JSON.stringify(candidate([{ inlineData: { data: "!!!not base64!!!", mimeType: "image/png" } }]))),
    () => json(JSON.stringify({ candidates: [
      { finishReason: "STOP", content: { parts: [imagePart(PNG_BYTES)] } },
      { finishReason: "STOP", content: { parts: [imagePart(PNG_BYTES)] } },
    ] })),
    () => json(JSON.stringify(candidate([imagePart(PNG_BYTES), imagePart(PNG_BYTES)]))),
    () => json(JSON.stringify(candidate([imagePart(WEBP_BYTES)]))),
    () => json(JSON.stringify(candidate([imagePart(new TextEncoder().encode("<script>alert(1)</script>"))]))),
    () => json(JSON.stringify(candidate([imagePart(PNG_BYTES, "image/jpeg")]))),
    () => json(JSON.stringify(candidate([imagePart(PNG_BYTES, "text/html")]))),
  ];
  for (const respond of bad) {
    const { client } = harness(respond);
    assert.deepEqual(await client.generate({ person, product }), { ok: false, reason: "GENERATION_FAILED" });
  }
});

test("text and thought parts are ignored when exactly one validated image is present", async () => {
  const body = JSON.stringify({
    candidates: [{
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [
          { thought: true, text: "internal reasoning placeholder" },
          { text: "Here is the result." },
          { inlineData: { data: b64(PNG_BYTES), mimeType: "image/png" } },
        ],
      },
    }],
  });
  const { client } = harness(() => json(body));
  assert.equal((await client.generate({ person, product })).ok, true);
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
