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

test("excess concurrent distinct requests are shed with 503 before fetch or Sharp", async () => {
  const release: Array<() => void> = [];
  let started = 0;
  const gated = async () => {
    started += 1;
    await new Promise<void>((resolve) => release.push(resolve));
    return new Response(TINY_PNG, { status: 200 });
  };
  const srcFor = (n: number) => `https://content.pancake.vn/images/1/2/3/img-${n}.png`;

  const admitted = [0, 1].map((n) =>
    handleProductImageRequest(request(srcFor(n)), { fetch: gated, maxConcurrent: 2 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 2);

  const shed = await handleProductImageRequest(request(srcFor(2)), { fetch: gated, maxConcurrent: 2 });
  assert.equal(shed.status, 503);
  assert.equal(shed.headers.get("cache-control"), "no-store");
  assert.ok(shed.headers.get("retry-after"));
  assert.equal(started, 2, "a shed request must not reach the upstream");

  release.forEach((r) => r());
  for (const response of await Promise.all(admitted)) assert.equal(response.status, 200);

  // Slots are returned: the same request is admitted again once the earlier ones settle.
  const later = counting(() => new Response(TINY_PNG, { status: 200 }));
  assert.equal(
    (await handleProductImageRequest(request(srcFor(2)), { fetch: later.fn, maxConcurrent: 2 })).status,
    200,
  );
});

test("identical concurrent requests share one fetch and do not consume extra slots", async () => {
  let started = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const gated = async () => {
    started += 1;
    await gate;
    return new Response(TINY_PNG, { status: 200 });
  };
  const responses = [1, 2, 3, 4, 5].map(() =>
    handleProductImageRequest(request(SRC), { fetch: gated, maxConcurrent: 1 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  open();
  for (const response of await Promise.all(responses)) assert.equal(response.status, 200);
  assert.equal(started, 1);
});
