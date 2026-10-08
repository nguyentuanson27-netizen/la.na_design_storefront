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

async function ok(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  await response.arrayBuffer(); // consuming the body is what returns its admission slot
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

  const corruptJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALgAJHb/2Q==",
    "base64",
  );
  const corrupt = counting(() => new Response(corruptJpeg, { status: 200 }));
  assert.equal((await handleProductImageRequest(request(SRC), { fetch: corrupt.fn })).status, 422);

  assert.equal((await handleProductImageRequest(request(SRC, "w=1081"))).status, 400);
  assert.equal((await handleProductImageRequest(request(SRC, "w=1080&x=1"))).status, 400);
});

test("a full gallery burst queues behind the concurrency cap instead of being shed", async () => {
  let running = 0;
  let peak = 0;
  let started = 0;
  const upstream = async () => {
    started += 1;
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    return new Response(TINY_PNG, { status: 200 });
  };
  // 12 distinct gallery images plus the mobile/lightbox widths of a few of them.
  const burst = Array.from({ length: 20 }, (_, n) =>
    handleProductImageRequest(
      request(`https://content.pancake.vn/images/1/2/3/gallery-${n}.png`, n % 2 === 0 ? "w=828" : "w=1200"),
      { fetch: upstream },
    ),
  );
  for (const response of await Promise.all(burst)) await ok(response);
  assert.equal(started, 20);
  assert.ok(peak <= 4, `at most 4 may run at once, saw ${peak}`);
});

test("only an overflowing queue is shed with 503, before fetch or Sharp", async () => {
  const release: Array<() => void> = [];
  let started = 0;
  const gated = async () => {
    started += 1;
    await new Promise<void>((resolve) => release.push(resolve));
    return new Response(TINY_PNG, { status: 200 });
  };
  const srcFor = (n: number) => `https://content.pancake.vn/images/1/2/3/q-${n}.png`;
  const limits = { fetch: gated, maxConcurrent: 2, maxQueued: 2 };

  // 2 run, 2 wait in the queue.
  const admitted = [0, 1, 2, 3].map((n) => handleProductImageRequest(request(srcFor(n)), limits));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 2, "queued requests must not reach the upstream yet");

  const shed = await handleProductImageRequest(request(srcFor(4)), limits);
  assert.equal(shed.status, 503);
  assert.equal(shed.headers.get("cache-control"), "no-store");
  assert.ok(shed.headers.get("retry-after"));
  assert.equal(started, 2, "a shed request must not reach the upstream");

  // Draining lets the queued requests run in turn.
  while (admitted.length > 0 && started < 4) {
    release.splice(0).forEach((r) => r());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release.splice(0).forEach((r) => r());
  for (const response of await Promise.all(admitted)) await ok(response);
  assert.equal(started, 4);

  // Slots are returned: a new request is admitted once the earlier ones settle.
  const later = counting(() => new Response(TINY_PNG, { status: 200 }));
  await ok(await handleProductImageRequest(request(srcFor(5)), { ...limits, fetch: later.fn }));
});

test("duplicate followers of one in-flight key are bounded and the excess is shed", async () => {
  let started = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const gated = async () => {
    started += 1;
    await gate;
    return new Response(TINY_PNG, { status: 200 });
  };
  const limits = { fetch: gated, maxFollowers: 3 };
  const src = "https://content.pancake.vn/images/1/2/3/follow.png";

  const admitted = Array.from({ length: 4 }, () => handleProductImageRequest(request(src), limits));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const excess = await Promise.all(
    Array.from({ length: 5 }, () => handleProductImageRequest(request(src), limits)),
  );
  for (const response of excess) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  open();
  for (const response of await Promise.all(admitted)) await ok(response);
  assert.equal(started, 1, "followers share the leader's single upstream fetch");
});

test("the global pending budget sheds requests across keys once it is spent", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const gated = async () => {
    await gate;
    return new Response(TINY_PNG, { status: 200 });
  };
  const limits = { fetch: gated, maxPending: 3 };
  const srcFor = (n: number) => `https://content.pancake.vn/images/1/2/3/pend-${n}.png`;

  const admitted = [0, 1, 2].map((n) => handleProductImageRequest(request(srcFor(n)), limits));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await handleProductImageRequest(request(srcFor(3)), limits)).status, 503);
  assert.equal((await handleProductImageRequest(request(srcFor(0)), limits)).status, 503);

  open();
  for (const response of await Promise.all(admitted)) await ok(response);
  // Budget is returned once the requests settle.
  await ok(await handleProductImageRequest(request(srcFor(3)), { ...limits, fetch: async () => new Response(TINY_PNG) }));
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
  for (const response of await Promise.all(responses)) await ok(response);
  assert.equal(started, 1);
});

test("an admitted response holds its slot until its body is consumed, so a second wave cannot bypass the budget", async () => {
  const upstream = async () => new Response(TINY_PNG, { status: 200 });
  const limits = { fetch: upstream, maxPending: 2, idleMs: 5_000 };
  const srcFor = (n: number) => `https://content.pancake.vn/images/1/2/3/slow-${n}.png`;

  // First wave completes its transcode but its clients are slow: bodies stay unread.
  const wave = await Promise.all([0, 1].map((n) => handleProductImageRequest(request(srcFor(n)), limits)));
  for (const response of wave) assert.equal(response.status, 200);

  const second = await handleProductImageRequest(request(srcFor(2)), limits);
  assert.equal(second.status, 503, "slots are still held by the unread first-wave bodies");

  await wave[0]!.arrayBuffer();
  await ok(await handleProductImageRequest(request(srcFor(2)), limits));
  await wave[1]!.body!.cancel(); // a client that goes away also returns its slot
  await ok(await handleProductImageRequest(request(srcFor(3)), limits));
});

test("a client that never reads is cut off after the idle timeout and its slot returns", async () => {
  const upstream = async () => new Response(TINY_PNG, { status: 200 });
  const limits = { fetch: upstream, maxPending: 1, idleMs: 30 };
  const stalled = await handleProductImageRequest(request(SRC), limits);
  assert.equal(stalled.status, 200);
  assert.equal((await handleProductImageRequest(request(SRC), limits)).status, 503);

  await new Promise((resolve) => setTimeout(resolve, 80));
  await ok(await handleProductImageRequest(request(SRC), limits));
  await assert.rejects(() => stalled.arrayBuffer());
});

test("a slow but progressing transfer outlives the idle threshold and completes; a stalled one is cut off", async () => {
  const upstream = async () => new Response(TINY_PNG, { status: 200 });
  const limits = { fetch: upstream, maxPending: 1, idleMs: 120, chunkBytes: 16 };

  const slow = await handleProductImageRequest(request(SRC), limits);
  assert.equal(slow.status, 200);
  const declared = Number(slow.headers.get("content-length"));
  const reader = slow.body!.getReader();
  let received = 0;
  let chunks = 0;
  const started = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks += 1;
    await new Promise((resolve) => setTimeout(resolve, 70)); // every gap is under idleMs
  }
  assert.ok(chunks >= 3, "the body must span several chunks for this to prove anything");
  assert.ok(Date.now() - started > 120, "the whole transfer must outlast the idle threshold");
  assert.equal(received, declared, "a progressing client gets the complete body");

  // A client that takes one chunk and then stalls is cut off, and its slot returns.
  const stalled = await handleProductImageRequest(request(SRC), limits);
  const stalledReader = stalled.body!.getReader();
  await stalledReader.read();
  assert.equal((await handleProductImageRequest(request(SRC), limits)).status, 503);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await assert.rejects(() => stalledReader.read());
  await ok(await handleProductImageRequest(request(SRC), limits));
});

test("the total transfer ceiling cuts off a client that trickles forever", async () => {
  const upstream = async () => new Response(TINY_PNG, { status: 200 });
  const limits = { fetch: upstream, maxPending: 1, idleMs: 1_000, maxTransferMs: 100, chunkBytes: 16 };
  const response = await handleProductImageRequest(request(SRC), limits);
  const reader = response.body!.getReader();
  await assert.rejects(async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
  await ok(await handleProductImageRequest(request(SRC), limits));
});
