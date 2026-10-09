import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { PDP_IMAGE_ENCODING_VERSION, PDP_IMAGE_MAX_BYTES } from "../../src/commerce/product-image-delivery.ts";
import { createDiskProductImageCache } from "../../src/integrations/pancake/product-image-cache.ts";
import {
  PRODUCT_IMAGE_IMMUTABLE_CACHE_CONTROL,
  PRODUCT_IMAGE_SHORT_CACHE_CONTROL,
  handleProductImageRequest,
} from "../../src/integrations/pancake/product-image-handler.ts";

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

const HASHED_SRC = "https://content.pancake.vn/1/2/3/4/8bf497694fac109aa56013bfc23dbf69198b269a.png";

function cachedRequest(src: string, extra: string, accept?: string): Request {
  return new Request(`https://shop.test/api/product-image?src=${encodeURIComponent(src)}&${extra}`, {
    headers: accept === undefined ? {} : { accept },
  });
}

test("a content-hashed source at the current version is immutable for a year; anything else keeps the short cache", async () => {
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  const current = await handleProductImageRequest(
    cachedRequest(HASHED_SRC, `w=828&v=${PDP_IMAGE_ENCODING_VERSION}`),
    { fetch: upstream.fn, cache: null },
  );
  assert.equal(current.headers.get("cache-control"), PRODUCT_IMAGE_IMMUTABLE_CACHE_CONTROL);
  assert.equal(current.headers.get("vary"), "Accept");
  await ok(current);

  // A page rendered before the version existed, or a source without a content hash.
  for (const [src, extra] of [
    [HASHED_SRC, "w=828"],
    [HASHED_SRC, "w=828&v=1"],
    [SRC, `w=828&v=${PDP_IMAGE_ENCODING_VERSION}`],
  ] as const) {
    const response = await handleProductImageRequest(cachedRequest(src, extra), { fetch: upstream.fn, cache: null });
    assert.equal(response.headers.get("cache-control"), PRODUCT_IMAGE_SHORT_CACHE_CONTROL, `${src} ${extra}`);
    await ok(response);
  }
});

test("the version is one short numeric token; anything else is a bad request", async () => {
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  for (const extra of ["w=828&v=abc", "w=828&v=1&v=2", "w=828&v=", "w=828&v=12345"]) {
    const response = await handleProductImageRequest(cachedRequest(HASHED_SRC, extra), { fetch: upstream.fn, cache: null });
    assert.equal(response.status, 400, extra);
  }
  assert.deepEqual(upstream.calls, []);
});

test("a browser that accepts AVIF gets AVIF; the rest get WebP", async () => {
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  const avif = await handleProductImageRequest(
    cachedRequest(HASHED_SRC, "w=828&v=2", "image/avif,image/webp,*/*;q=0.8"),
    { fetch: upstream.fn, cache: null },
  );
  assert.equal(avif.status, 200);
  assert.equal(avif.headers.get("content-type"), "image/avif");
  const avifBody = Buffer.from(await avif.arrayBuffer());
  assert.equal((await sharp(avifBody).metadata()).format, "heif");

  const webp = await handleProductImageRequest(
    cachedRequest(HASHED_SRC, "w=828&v=2", "image/webp,*/*;q=0.8"),
    { fetch: upstream.fn, cache: null },
  );
  assert.equal(webp.headers.get("content-type"), "image/webp");
  await ok(webp);
});

test("the disk cache answers a repeat request without Pancake or Sharp, per width and format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-image-cache-"));
  try {
    const cache = createDiskProductImageCache({ directory, maxBytes: 10 * 1024 * 1024 });
    const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
    const fetchOnce = (extra: string, accept?: string) =>
      handleProductImageRequest(cachedRequest(HASHED_SRC, extra, accept), { fetch: upstream.fn, cache });

    const first = await fetchOnce("w=828&v=2");
    assert.equal(first.headers.get("x-product-image-cache"), "miss");
    const firstBody = new Uint8Array(await first.arrayBuffer());
    // The write is not awaited by the response; give it a turn to land.
    await waitFor(async () => (await readdir(directory)).some((name) => name.endsWith(".webp")));

    const second = await fetchOnce("w=828&v=2");
    assert.equal(second.headers.get("x-product-image-cache"), "hit");
    assert.equal(second.headers.get("content-type"), "image/webp");
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), firstBody);
    assert.equal(upstream.calls.length, 1);

    // Another format or width is its own entry.
    const avif = await fetchOnce("w=828&v=2", "image/avif");
    assert.equal(avif.headers.get("x-product-image-cache"), "miss");
    await ok(avif);
    assert.equal(upstream.calls.length, 2);

    // A source without a content hash is never kept on disk.
    const unhashed = counting(() => new Response(TINY_PNG, { status: 200 }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handleProductImageRequest(cachedRequest(SRC, "w=828&v=2"), { fetch: unhashed.fn, cache });
      assert.equal(response.headers.get("x-product-image-cache"), null);
      await ok(response);
    }
    assert.equal(unhashed.calls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the disk cache stays inside its budget by dropping the least recently used entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-image-cache-"));
  try {
    const cache = createDiskProductImageCache({ directory, maxBytes: 2_500 });
    const image = (fill: number) => ({ bytes: new Uint8Array(1_000).fill(fill), mimeType: "image/webp" as const });
    await cache.write("a", image(1));
    await cache.write("b", image(2));
    // Using `a` makes `b` the least recently used.
    const past = new Date(Date.now() - 60_000);
    for (const name of await readdir(directory)) await utimes(join(directory, name), past, past);
    assert.ok(await cache.read("a", "image/webp"));
    await cache.write("c", image(3));

    assert.ok(await cache.read("a", "image/webp"), "the recently read entry survives");
    assert.equal(await cache.read("b", "image/webp"), null, "the least recently used entry is gone");
    assert.ok(await cache.read("c", "image/webp"), "the new entry is kept");
    assert.equal(await cache.read("a", "image/avif"), null, "formats are separate entries");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unusable cache directory degrades to the uncached endpoint instead of failing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-image-cache-"));
  try {
    // A file where the directory should be: every mkdir, read and write fails.
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "not a directory");
    const cache = createDiskProductImageCache({ directory: join(blocked, "cache"), maxBytes: 1_000_000 });
    const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await handleProductImageRequest(cachedRequest(HASHED_SRC, "w=828&v=2"), { fetch: upstream.fn, cache });
        assert.equal(response.status, 200);
        await ok(response);
      }
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(upstream.calls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never held");
}

const HASHED_SRC_B = "https://content.pancake.vn/1/2/3/4/c3499c2729730a7f807efb8676a92dcb6f8a3f8f.png";

test("the pending slot is reserved before the cache read: concurrent misses cannot overrun the cap", async () => {
  let reads = 0;
  let openBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    openBarrier = resolve;
  });
  const cache = {
    read: async () => {
      reads += 1;
      await barrier;
      return null;
    },
    write: async () => {},
  };
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  const options = { fetch: upstream.fn, cache, maxPending: 1 };

  const first = handleProductImageRequest(cachedRequest(HASHED_SRC, "w=828&v=2"), options);
  // The first request is suspended inside the cache read, holding the only slot.
  const second = await handleProductImageRequest(cachedRequest(HASHED_SRC_B, "w=828&v=2"), options);
  assert.equal(second.status, 503);
  assert.equal(second.headers.get("cache-control"), "no-store");
  assert.equal(reads, 1, "a shed request never reaches the cache");

  openBarrier();
  await ok(await first);
  assert.deepEqual(upstream.calls, [HASHED_SRC]);

  // Its slot came back once the body was consumed.
  await ok(await handleProductImageRequest(cachedRequest(HASHED_SRC_B, "w=828&v=2"), options));
});

test("hits, cache errors and upstream failures each return their pending slot exactly once", async () => {
  const upstream = counting(() => new Response(TINY_PNG, { status: 200 }));
  const image = { bytes: new Uint8Array(await sharp(TINY_PNG).webp().toBuffer()), mimeType: "image/webp" as const };
  const hitting = { read: async () => image, write: async () => {} };
  const throwing = {
    read: async () => {
      throw new Error("disk gone");
    },
    write: async () => {},
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hit = await handleProductImageRequest(cachedRequest(HASHED_SRC, "w=828&v=2"), {
      fetch: upstream.fn,
      cache: hitting,
      maxPending: 1,
    });
    assert.equal(hit.headers.get("x-product-image-cache"), "hit");
    await ok(hit);

    const throwingRead = await handleProductImageRequest(cachedRequest(HASHED_SRC, "w=828&v=2"), {
      fetch: upstream.fn,
      cache: throwing,
      maxPending: 1,
    });
    assert.equal(throwingRead.headers.get("x-product-image-cache"), "miss");
    await ok(throwingRead);

    const failed = await handleProductImageRequest(cachedRequest(HASHED_SRC_B, "w=828&v=2"), {
      fetch: async () => new Response(null, { status: 500 }),
      cache: null,
      maxPending: 1,
    });
    assert.equal(failed.status, 502);
  }
  assert.equal(upstream.calls.length, 3, "only the throwing cache fell through to Pancake");
});
