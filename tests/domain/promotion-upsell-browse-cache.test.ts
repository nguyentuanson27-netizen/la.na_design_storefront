import assert from "node:assert/strict";
import test from "node:test";
import { createUpsellBrowseCache } from "../../src/commerce/promotion-upsell-browse-cache.ts";

test("entries expire after the TTL and are recomputed", async () => {
  let t = 1_000; let loads = 0;
  const cache = createUpsellBrowseCache<string>({ ttlMs: 60_000, now: () => t });
  const load = async () => ({ value: `v${++loads}`, store: true });
  assert.deepEqual(await cache.resolve("k", load), { value: "v1", cached: false, failed: false });
  t += 59_999;
  assert.deepEqual(await cache.resolve("k", load), { value: "v1", cached: true, failed: false });
  t += 2;
  assert.deepEqual(await cache.resolve("k", load), { value: "v2", cached: false, failed: false });
});

test("store:false and null results are never kept", async () => {
  const cache = createUpsellBrowseCache<string>();
  await cache.resolve("partial", async () => ({ value: "short list", store: false }));
  await cache.resolve("empty", async () => ({ value: null, store: true }));
  assert.equal(cache.size, 0);
});

test("identical in-flight loads are joined", async () => {
  const cache = createUpsellBrowseCache<string>();
  let loads = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const load = async () => { loads++; await gate; return { value: "once", store: true }; };
  const calls = [cache.resolve("k", load), cache.resolve("k", load), cache.resolve("k", load)];
  release();
  assert.deepEqual((await Promise.all(calls)).map((r) => r.value), ["once", "once", "once"]);
  assert.equal(loads, 1);
});

test("every caller sharing a failed load sees the failure flag", async () => {
  const cache = createUpsellBrowseCache<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const load = async () => { await gate; return { value: null, store: false, failed: true }; };
  const calls = [cache.resolve("k", load), cache.resolve("k", load)];
  release();
  assert.deepEqual((await Promise.all(calls)).map((r) => r.failed), [true, true]);
});

test("a failed load is not cached and the next call retries", async () => {
  const cache = createUpsellBrowseCache<string>();
  await assert.rejects(cache.resolve("k", async () => { throw new Error("boom"); }));
  assert.deepEqual(await cache.resolve("k", async () => ({ value: "ok", store: true })), { value: "ok", cached: false, failed: false });
});

test("the cache is bounded and evicts the oldest entry", () => {
  const cache = createUpsellBrowseCache<string>({ maxEntries: 2 });
  cache.set("a", "1"); cache.set("b", "2"); cache.set("c", "3");
  assert.equal(cache.size, 2);
});

test("invalid sizes are rejected", () => {
  assert.throws(() => createUpsellBrowseCache({ ttlMs: 0 }), TypeError);
  assert.throws(() => createUpsellBrowseCache({ maxEntries: 1.5 }), TypeError);
});
