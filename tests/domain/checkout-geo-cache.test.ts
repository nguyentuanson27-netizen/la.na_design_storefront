import assert from "node:assert/strict";
import test from "node:test";

import { createCheckoutGeoCache } from "../../src/commerce/checkout-geo-cache.ts";
import { createCheckoutGeoPublicActions } from "../../src/commerce/checkout-geo-public-actions.ts";
import type { CheckoutCommune, CheckoutProvince } from "../../src/commerce/checkout-geo.ts";

const initialProvinces: CheckoutProvince[] = [{ id: "84_VN101", name: "Hà Nội" }];
const wards = (provinceId: string): CheckoutCommune[] => [
  { id: provinceId + "01", name: "Phường 1", provinceId },
];

test("checkout geo cache reuses validated province lists until the hard TTL, then refetches", async () => {
  let now = 10_000;
  let reads = 0;
  const cache = createCheckoutGeoCache({
    now: () => now,
    ttlMs: 1_000,
    loadProvinces: async () => [{ id: "84_VN101", name: "Hà Nội " + ++reads }],
    loadCommunes: async () => [],
  });
  const first = await cache.provinces();
  assert.equal(first[0]?.name, "Hà Nội 1");
  first[0]!.name = "client mutation";
  assert.equal((await cache.provinces())[0]?.name, "Hà Nội 1", "cache cannot be poisoned by callers");
  assert.equal(reads, 1);
  now += 999;
  assert.equal((await cache.provinces())[0]?.name, "Hà Nội 1");
  now++;
  assert.equal((await cache.provinces())[0]?.name, "Hà Nội 2", "no stale result at TTL boundary");
  now--;
  assert.equal((await cache.provinces())[0]?.name, "Hà Nội 3", "a backwards clock expires entries");
});

test("commune results are isolated per province, bounded by LRU and do not leak mutable rows", async () => {
  const reads: string[] = [];
  const cache = createCheckoutGeoCache({
    maxCommuneEntries: 2,
    loadProvinces: async () => initialProvinces,
    loadCommunes: async (provinceId) => {
      reads.push(String(provinceId));
      return wards(String(provinceId));
    },
  });
  const first = await cache.communes("84_VN101");
  first[0]!.name = "corrupted";
  assert.equal((await cache.communes("84_VN101"))[0]?.name, "Phường 1");
  await cache.communes("84_VN701");
  await cache.communes("84_VN101"); // mark 101 as recently used
  await cache.communes("84_VN201"); // evicts 701
  await cache.communes("84_VN101"); // still cached
  await cache.communes("84_VN701"); // must reload
  assert.deepEqual(reads, ["84_VN101", "84_VN701", "84_VN201", "84_VN701"]);
});

test("concurrent misses for one province share one Pancake request and return independent copies", async () => {
  let release!: (options: CheckoutCommune[]) => void;
  const held = new Promise<CheckoutCommune[]>((resolve) => { release = resolve; });
  let reads = 0;
  const cache = createCheckoutGeoCache({
    loadProvinces: async () => initialProvinces,
    loadCommunes: () => { reads++; return held; },
  });
  const one = cache.communes("84_VN101");
  const two = cache.communes("84_VN101");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  release(wards("84_VN101"));
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a, b);
  assert.notStrictEqual(a, b);
  a[0]!.name = "changed";
  assert.equal(b[0]?.name, "Phường 1");
});

test("failed and empty reads are not cached and an expired entry is never served as authority", async () => {
  let now = 10_000;
  let calls = 0;
  const cache = createCheckoutGeoCache({
    now: () => now,
    ttlMs: 200,
    loadProvinces: async () => {
      calls++;
      if (calls === 1 || calls === 4) throw new Error("Pancake unavailable");
      if (calls === 2) return [];
      return [{ id: "84_VN101", name: "Hà Nội" }];
    },
    loadCommunes: async () => [],
  });
  await assert.rejects(cache.provinces(), /Pancake unavailable/);
  assert.deepEqual(await cache.provinces(), [], "empty geo data is not negatively cached");
  assert.deepEqual(await cache.provinces(), initialProvinces);
  assert.equal(calls, 3);
  now += 200;
  await assert.rejects(cache.provinces(), /Pancake unavailable/, "expired entries fail closed");
  assert.deepEqual(await cache.provinces(), initialProvinces);
  assert.equal(calls, 5);
});

test("distinct cache misses are bounded; the same key can still join a pending lookup", async () => {
  let release!: (options: CheckoutCommune[]) => void;
  const held = new Promise<CheckoutCommune[]>((resolve) => { release = resolve; });
  let calls = 0;
  const cache = createCheckoutGeoCache({
    maxConcurrentMisses: 1,
    loadProvinces: async () => initialProvinces,
    loadCommunes: async (provinceId) => {
      calls++;
      return provinceId === "84_VN101" ? held : wards(String(provinceId));
    },
  });
  const pending = cache.communes("84_VN101");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(cache.communes("84_VN701"), /capacity/i);
  const shared = cache.communes("84_VN101");
  assert.equal(calls, 1);
  release(wards("84_VN101"));
  assert.deepEqual(await pending, wards("84_VN101"));
  assert.deepEqual(await shared, wards("84_VN101"));
  assert.deepEqual(await cache.communes("84_VN701"), wards("84_VN701"));
  assert.equal(calls, 2);
});

test("invalid province IDs bypass the cache and remain rejected by upstream validation", async () => {
  let calls = 0;
  const cache = createCheckoutGeoCache({
    loadProvinces: async () => initialProvinces,
    loadCommunes: async (id) => {
      calls++;
      if (typeof id !== "string" || id.trim() !== id || id.length > 64 || id.length === 0) {
        throw new Error("INVALID_GEO_QUERY");
      }
      return wards(id);
    },
  });
  for (const id of [null, 42, "", " ", "x".repeat(65)]) {
    await assert.rejects(cache.communes(id), /INVALID_GEO_QUERY/);
    await assert.rejects(cache.communes(id), /INVALID_GEO_QUERY/);
  }
  assert.equal(calls, 10, "invalid keys are never inserted into or served from the cache");
});

test("checkout geo public actions still rate-limit every call, even on warm cache hits", async () => {
  let grants = 0, fetches = 0;
  const cache = createCheckoutGeoCache({
    loadProvinces: async () => {
      fetches++;
      return initialProvinces;
    },
    loadCommunes: async (id) => wards(String(id)),
  });
  const actions = createCheckoutGeoPublicActions({
    allowRead: async () => ++grants <= 2,
    loadProvinces: cache.provinces,
    loadCommunes: cache.communes,
  });
  assert.deepEqual(await actions.provinces(), { ok: true, options: initialProvinces });
  assert.deepEqual(await actions.provinces(), { ok: true, options: initialProvinces });
  assert.deepEqual(await actions.provinces(), { ok: false, reason: "GEO_UNAVAILABLE" });
  assert.equal(grants, 3);
  assert.equal(fetches, 1);
});

test("geo cache rejects invalid TTL, size, and concurrency budgets", () => {
  const defaults = {
    loadProvinces: async () => initialProvinces,
    loadCommunes: async () => [] as CheckoutCommune[],
  };
  assert.throws(() => createCheckoutGeoCache({ ...defaults, ttlMs: 0 }), RangeError);
  assert.throws(() => createCheckoutGeoCache({ ...defaults, maxCommuneEntries: 0 }), RangeError);
  assert.throws(() => createCheckoutGeoCache({ ...defaults, maxConcurrentMisses: 0 }), RangeError);
  assert.throws(() => createCheckoutGeoCache({ ...defaults, ttlMs: 1.5 }), RangeError);
});
