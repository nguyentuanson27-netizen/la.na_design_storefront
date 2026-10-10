import assert from "node:assert/strict";
import test from "node:test";

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
