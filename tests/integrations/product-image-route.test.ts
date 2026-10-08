import assert from "node:assert/strict";
import test from "node:test";

import { PDP_IMAGE_MAX_BYTES } from "../../src/commerce/product-image-delivery.ts";
import { handleProductImageRequest } from "../../src/integrations/pancake/product-image-handler.ts";

const SRC = "https://content.pancake.vn/images/1/2/3/dress.png";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function request(src: string, extra = "w=1080"): Request {
  return new Request(`https://shop.test/api/product-image?src=${encodeURIComponent(src)}&${extra}`);
}

function counting(response: () => Response) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return response();
  };
  return { fn, calls };
}

test("route boundary returns bounded same-origin WebP for a trusted source", async () => {
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  const response = await handleProductImageRequest(request(SRC), { fetch: upstream.fn });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  const body = new Uint8Array(await response.arrayBuffer());
  assert.ok(body.byteLength > 0 && body.byteLength < PDP_IMAGE_MAX_BYTES);
  assert.deepEqual(upstream.calls, [SRC]);
});

test("equivalent source spellings never reach the upstream or the encoder", async () => {
  for (const variant of [`${SRC}#nonce-1`, `${SRC}#nonce-2`, `${SRC}?v=1`, `${SRC}?v=2`]) {
    const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
    const response = await handleProductImageRequest(request(variant), { fetch: upstream.fn });
    assert.equal(response.status, 400, variant);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(upstream.calls.length, 0, variant);
  }
});

test("upstream failure maps to 502, bad query shape to 400, undecodable image to 422", async () => {
  const missing = counting(() => new Response("nope", { status: 404 }));
  assert.equal((await handleProductImageRequest(request(SRC), { fetch: missing.fn })).status, 502);

  const garbage = counting(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
  assert.equal((await handleProductImageRequest(request(SRC), { fetch: garbage.fn })).status, 422);

  assert.equal((await handleProductImageRequest(request(SRC, "w=1081"))).status, 400);
  assert.equal((await handleProductImageRequest(request(SRC, "w=1080&x=1"))).status, 400);
});
