import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import { fetchTryOnGarmentImage } from "../../src/integrations/vertex-try-on/product-image.ts";
import { TRY_ON_MAX_IMAGE_BYTES } from "../../src/commerce/try-on-policy.ts";
import { JPEG_BYTES, WEBP_BYTES } from "../support/try-on-fixtures.ts";
import type { CachedProductImage, ProductImageCache } from "../../src/integrations/pancake/product-image-cache.ts";

const PANCAKE_URL = "https://content.pancake.vn/images/1/2/3/8bf4e269a8bf4e269a8bf4e269a8bf4e269a.jpg";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
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

function memoryCache(): ProductImageCache & { store: Map<string, CachedProductImage> } {
  const store = new Map<string, CachedProductImage>();
  return {
    store,
    read: async (key: string) => store.get(key) ?? null,
    write: async (key: string, image: CachedProductImage) => {
      store.set(key, image);
    },
  };
}

test("returns cached WebP image immediately on cache hit without network fetch", async () => {
  const cache = memoryCache();
  const cachedBytes = new Uint8Array(WEBP_BYTES);
  // Key format: 2|webp|1080|<url>
  cache.store.set(`2|webp|1080|${PANCAKE_URL}`, {
    bytes: cachedBytes,
    mimeType: "image/webp",
  });

  const { fn, calls } = fetcher();
  const result = await fetchTryOnGarmentImage(PANCAKE_URL, { fetch: fn, cache });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/webp");
    assert.deepEqual(result.image.bytes, cachedBytes);
  }
  assert.equal(calls.length, 0, "No network call should be made on cache hit");
});

test("fetches product image directly when not cached and within size limit", async () => {
  const cache = memoryCache();
  const { fn, calls } = fetcher(new Response(JPEG_BYTES, { status: 200 }));

  const result = await fetchTryOnGarmentImage(PANCAKE_URL, { fetch: fn, cache });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/jpeg");
    assert.deepEqual([...result.image.bytes], [...JPEG_BYTES]);
  }
  assert.equal(calls.length, 1);
});

test("compresses oversized Pancake image to WebP and populates cache", async () => {
  const cache = memoryCache();
  // 1. Direct fetch returns Content-Length > 7 MB (or 13.5 MB)
  // 2. Fallback fetchAndCompressPancakeProductImage fetches raw source and compresses
  const oversizedLength = 13_533_815;
  const { fn, calls } = fetcher(
    new Response(null, {
      status: 200,
      headers: { "content-length": String(oversizedLength) },
    }),
    new Response(TINY_PNG, {
      status: 200,
      headers: { "content-length": String(TINY_PNG.length) },
    }),
  );

  const result = await fetchTryOnGarmentImage(PANCAKE_URL, { fetch: fn, cache });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.mimeType, "image/webp");
    assert.ok(result.image.bytes.byteLength > 0);
    assert.ok(result.image.bytes.byteLength < TRY_ON_MAX_IMAGE_BYTES);
  }

  assert.equal(calls.length, 2, "one bounded direct fetch, then one source fetch for compression");

  // Verify it was written to cache
  const cached = await cache.read(`2|webp|1080|${PANCAKE_URL}`, "image/webp");
  assert.ok(cached !== null);
  assert.equal(cached?.mimeType, "image/webp");
});

test("a real high-resolution source over 7 MB is decoded, resized to 1080 px WebP and fits the limit", async () => {
  // A 12 MP portrait camera JPEG. Random noise barely compresses, so at quality 90 it is ~10 MB --
  // over 7 MB like a raw camera upload, under the 32 MB source cap, and with no personal data.
  const width = 3000;
  const height = 4000;
  const source = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
  assert.ok(source.byteLength > TRY_ON_MAX_IMAGE_BYTES, `fixture is ${source.byteLength} bytes`);
  assert.ok(source.byteLength < 32_000_000, "fixture stays under the 32 MB source cap");

  const cache = memoryCache();
  // No Content-Length on either response: the 7 MB bound must trip on the streamed bytes themselves.
  const { fn, calls } = fetcher(new Response(source, { status: 200 }), new Response(source, { status: 200 }));

  const result = await fetchTryOnGarmentImage(PANCAKE_URL, { fetch: fn, cache });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  if (!result.ok) return;
  assert.equal(result.image.mimeType, "image/webp");
  assert.ok(result.image.bytes.byteLength < TRY_ON_MAX_IMAGE_BYTES);
  const metadata = await sharp(result.image.bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok(metadata.width! <= 1080, `width ${metadata.width}`);
  assert.equal(metadata.height, Math.round((metadata.width! * height) / width));
  assert.ok((await cache.read(`2|webp|1080|${PANCAKE_URL}`, "image/webp")) !== null);
});

test("untrusted product image URL is rejected before any network call", async () => {
  const cache = memoryCache();
  const { fn, calls } = fetcher();

  const result = await fetchTryOnGarmentImage("https://evil.example/photo.jpg", { fetch: fn, cache });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "UNTRUSTED_URL");
  }
  assert.equal(calls.length, 0);
});

test("a source that is not content-addressed never reads or writes the cache", async () => {
  const mutable = "https://content.pancake.vn/images/1/2/3/dress.jpg";
  const cache = memoryCache();
  cache.store.set(`2|webp|1080|${mutable}`, { bytes: new Uint8Array(WEBP_BYTES), mimeType: "image/webp" });
  const { fn, calls } = fetcher(new Response(JPEG_BYTES, { status: 200 }));

  const result = await fetchTryOnGarmentImage(mutable, { fetch: fn, cache });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.image.mimeType, "image/jpeg");
  assert.equal(calls.length, 1);
});
