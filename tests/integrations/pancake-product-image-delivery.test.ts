import assert from "node:assert/strict";
import test from "node:test";

import {
  PDP_IMAGE_MAX_BYTES,
  PDP_IMAGE_SOURCE_MAX_BYTES,
} from "../../src/commerce/product-image-delivery.ts";
import { fetchAndCompressPancakeProductImage } from "../../src/integrations/pancake/product-image-delivery.ts";

const URL_OK = "https://content.pancake.vn/images/1/2/3/dress.png";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlFJZsAAAAASUVORK5CYII=",
  "base64",
);

function fetcher(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

test("trusted Pancake PNG is returned as bounded WebP", async () => {
  const mocked = fetcher(
    new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } }),
  );
  const result = await fetchAndCompressPancakeProductImage(URL_OK, 1080, {
    fetch: mocked.fn,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/webp");
    assert.ok(result.image.bytes.byteLength > 0);
    assert.ok(result.image.bytes.byteLength < PDP_IMAGE_MAX_BYTES);
  }
  assert.equal(mocked.calls.length, 1);
  assert.equal(mocked.calls[0]!.init.redirect, "manual");
});

test("an untrusted source is refused before any fetch", async () => {
  const mocked = fetcher();
  const result = await fetchAndCompressPancakeProductImage(
    "https://evil.example/images/1/2/3/dress.jpg",
    1080,
    { fetch: mocked.fn },
  );
  assert.deepEqual(result, { ok: false, reason: "UNTRUSTED_URL" });
  assert.equal(mocked.calls.length, 0);
});

test("redirects must stay inside the reviewed Pancake media boundary", async () => {
  const mocked = fetcher(
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/a.jpg" },
    }),
  );
  const result = await fetchAndCompressPancakeProductImage(URL_OK, 1080, {
    fetch: mocked.fn,
  });
  assert.deepEqual(result, { ok: false, reason: "FETCH_FAILED" });
  assert.equal(mocked.calls.length, 1);
});

test("declared source bodies above the bounded input limit fail before buffering", async () => {
  const mocked = fetcher(
    new Response(TINY_PNG, {
      status: 200,
      headers: { "content-length": String(PDP_IMAGE_SOURCE_MAX_BYTES + 1) },
    }),
  );
  const result = await fetchAndCompressPancakeProductImage(URL_OK, 1080, {
    fetch: mocked.fn,
  });
  assert.deepEqual(result, { ok: false, reason: "TOO_LARGE" });
});
