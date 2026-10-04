import assert from "node:assert/strict";
import test from "node:test";

import { TRY_ON_MAX_REQUEST_BYTES, handleTryOnPost } from "../../src/commerce/try-on-endpoint.ts";
import type { TryOnServiceInput, TryOnServiceResult } from "../../src/commerce/try-on-service.ts";
import { JPEG_BYTES, PNG_BYTES, tryOnForm } from "../support/try-on-fixtures.ts";

const HOST = "shop.example.test";

function post(form: FormData, headers: Record<string, string> = {}) {
  return new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: { origin: `https://${HOST}`, host: HOST, ...headers },
    body: form,
  });
}

function endpoint(result: TryOnServiceResult = { ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }) {
  const calls: TryOnServiceInput[] = [];
  const forms: Array<FormData | string> = [];
  const deps = {
    service: {
      handle: async (input: TryOnServiceInput) => {
        calls.push(input);
        forms.push(await input.readForm());
        return result;
      },
    },
    resolveClientKey: (): string | null => "v1:" + "a".repeat(64),
  };
  return { deps, calls, forms };
}

test("a success returns the image as JSON with no-store caching", async () => {
  const { deps, calls } = endpoint();
  const response = await handleTryOnPost(post(tryOnForm()), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    mimeType: "image/png",
    imageBase64: Buffer.from(PNG_BYTES).toString("base64"),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.clientKey, "v1:" + "a".repeat(64));
});

test("the service sees the parsed multipart form, including the photo bytes", async () => {
  const { deps, forms } = endpoint();
  await handleTryOnPost(post(tryOnForm()), deps);
  const form = forms[0] as FormData;
  assert.equal(form.get("ageState"), "adult");
  const photo = form.get("photo") as File;
  assert.deepEqual([...new Uint8Array(await photo.arrayBuffer())], [...JPEG_BYTES]);
});

test("every failure reason maps to a status and a body that is only the reason", async () => {
  const expected: Record<string, number> = {
    UNAVAILABLE: 503,
    INVALID_REQUEST: 400,
    LIKENESS_REQUIRED: 400,
    AGE_STATE_INVALID: 400,
    AGE_BLOCKED: 403,
    UNSUPPORTED_IMAGE: 415,
    IMAGE_TOO_LARGE: 413,
    NOT_ELIGIBLE: 404,
    PRODUCT_IMAGE_UNAVAILABLE: 502,
    RATE_LIMITED: 429,
    BUSY: 503,
    SAFETY_BLOCKED: 422,
    AUTH_FAILED: 503,
    TIMEOUT: 504,
    GENERATION_FAILED: 502,
  };
  for (const [reason, status] of Object.entries(expected)) {
    const { deps } = endpoint({ ok: false, reason: reason as never });
    const response = await handleTryOnPost(post(tryOnForm()), deps);
    assert.equal(response.status, status, reason);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false, reason });
  }
});

test("a cross-site or originless request is refused before the service runs (CSRF)", async () => {
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: `http://${HOST}:8080` },
  ]) {
    const { deps, calls } = endpoint();
    const response = await handleTryOnPost(post(tryOnForm(), headers), deps);
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  }
  const { deps, calls } = endpoint();
  const request = new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: { host: HOST },
    body: tryOnForm(),
  });
  assert.equal((await handleTryOnPost(request, deps)).status, 403);
  assert.equal(calls.length, 0);
});

test("behind a proxy that rewrites Host, the original host in X-Forwarded-Host is honoured", async () => {
  const { deps, calls } = endpoint();
  const request = new Request("https://app.internal/api/try-on", {
    method: "POST",
    headers: { origin: `https://${HOST}`, host: "app.internal:3000", "x-forwarded-host": HOST },
    body: tryOnForm(),
  });
  assert.equal((await handleTryOnPost(request, deps)).status, 200);
  assert.equal(calls.length, 1);

  const mismatch = new Request("https://app.internal/api/try-on", {
    method: "POST",
    headers: { origin: "https://evil.example", host: "app.internal:3000", "x-forwarded-host": HOST },
    body: tryOnForm(),
  });
  assert.equal((await handleTryOnPost(mismatch, deps)).status, 403);
});

test("a non-multipart request is refused", async () => {
  const { deps, calls } = endpoint();
  const request = new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: { origin: `https://${HOST}`, host: HOST, "content-type": "application/json" },
    body: "{}",
  });
  const response = await handleTryOnPost(request, deps);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("an oversized declared Content-Length is refused with 413 before anything is read", async () => {
  const { deps, calls } = endpoint();
  const response = await handleTryOnPost(
    post(tryOnForm(), { "content-length": String(TRY_ON_MAX_REQUEST_BYTES + 1) }),
    deps,
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, reason: "IMAGE_TOO_LARGE" });
  assert.equal(calls.length, 0);
});

test("a body that streams past the cap without a Content-Length is cut off, not buffered", async () => {
  const { deps, forms } = endpoint({ ok: false, reason: "IMAGE_TOO_LARGE" });
  const boundary = "----cap";
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > TRY_ON_MAX_REQUEST_BYTES + 4 * chunk.byteLength) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: { origin: `https://${HOST}`, host: HOST, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: "half",
  } as RequestInit);
  await handleTryOnPost(request, deps);
  assert.deepEqual(forms, ["TOO_LARGE"]);
  assert.ok(sent <= TRY_ON_MAX_REQUEST_BYTES + 2 * chunk.byteLength, `read ${sent} bytes`);
});

test("a body that stalls is cut off by the read timeout instead of holding an upload slot", async () => {
  const { deps, forms } = endpoint({ ok: false, reason: "INVALID_REQUEST" });
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(16));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: { origin: `https://${HOST}`, host: HOST, "content-type": "multipart/form-data; boundary=slow" },
    body: stalled,
    duplex: "half",
  } as RequestInit);
  const started = Date.now();
  await handleTryOnPost(request, { ...deps, bodyReadTimeoutMs: 50 });
  assert.deepEqual(forms, ["INVALID"]);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 5_000);
});

test("a malformed multipart body reaches the service as INVALID", async () => {
  const { deps, forms } = endpoint({ ok: false, reason: "INVALID_REQUEST" });
  const request = new Request(`https://${HOST}/api/try-on`, {
    method: "POST",
    headers: {
      origin: `https://${HOST}`,
      host: HOST,
      "content-type": "multipart/form-data; boundary=xyz",
    },
    body: "this is not multipart",
  });
  await handleTryOnPost(request, deps);
  assert.deepEqual(forms, ["INVALID"]);
});

test("an unresolvable client identity fails closed", async () => {
  const { deps, calls } = endpoint();
  const response = await handleTryOnPost(post(tryOnForm()), { ...deps, resolveClientKey: () => null });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, reason: "UNAVAILABLE" });
  assert.equal(calls.length, 0);
});

test("a service that throws still answers a safe 5xx, never the error", async () => {
  const response = await handleTryOnPost(post(tryOnForm()), {
    service: {
      handle: async () => {
        throw new Error("internal secret");
      },
    },
    resolveClientKey: () => "v1:" + "a".repeat(64),
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret/);
});
