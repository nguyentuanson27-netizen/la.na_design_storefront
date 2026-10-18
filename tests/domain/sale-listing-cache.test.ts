import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSaleListingCache } from "../../src/commerce/sale-listing-cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function clock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function counter<T>(values: readonly T[]) {
  let calls = 0;
  return {
    load: async () => values[Math.min(calls++, values.length - 1)] as T,
    calls: () => calls,
  };
}

describe("Sale listing cache", () => {
  it("serves a fresh entry without reading again", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    const reads = counter(["first", "second"]);

    assert.deepEqual(await cache.read("k", reads.load), { value: "first", cached: false });
    time.advance(29);
    assert.deepEqual(await cache.read("k", reads.load), { value: "first", cached: true });
    assert.equal(reads.calls(), 1);
  });

  it("serves a stale entry while one background read replaces it", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    const background = deferred<string>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve("first") : background.promise;
    };

    await cache.read("k", load);
    time.advance(30);
    assert.deepEqual(await cache.read("k", load), { value: "first", cached: true });
    assert.deepEqual(await cache.read("k", load), { value: "first", cached: true });
    assert.equal(calls, 2, "two stale hits start one background read");
    background.resolve("second");
    await settle();
    assert.deepEqual(await cache.read("k", load), { value: "second", cached: true });
  });

  it("never serves an entry at or past its maximum age", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    const reads = counter(["first", "second"]);

    await cache.read("k", reads.load);
    time.advance(60);
    assert.deepEqual(await cache.read("k", reads.load), { value: "second", cached: false });
  });

  it("expires an entry when the clock steps backwards", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    const reads = counter(["first", "second"]);

    await cache.read("k", reads.load);
    time.advance(-1);
    assert.deepEqual(await cache.read("k", reads.load), { value: "second", cached: false });
  });

  it("ages an entry from when its read began", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    const pending = deferred<string>();

    const first = cache.read("k", () => pending.promise);
    time.advance(50);
    pending.resolve("slow");
    await first;
    time.advance(10);
    const reads = counter(["next"]);
    assert.deepEqual(await cache.read("k", reads.load), { value: "next", cached: false });
  });

  it("shares one read between concurrent misses on a key", async () => {
    const cache = createSaleListingCache<string>();
    const pending = deferred<string>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };

    const a = cache.read("k", load);
    const b = cache.read("k", load);
    pending.resolve("shared");
    assert.deepEqual(await Promise.all([a, b]), [
      { value: "shared", cached: false },
      { value: "shared", cached: false },
    ]);
    assert.equal(calls, 1);
  });

  it("keeps keys apart", async () => {
    const cache = createSaleListingCache<string>();
    assert.equal((await cache.read("a", async () => "A")).value, "A");
    assert.equal((await cache.read("b", async () => "B")).value, "B");
    assert.deepEqual(await cache.read("a", async () => "other"), { value: "A", cached: true });
  });

  it("caches no failed read and hands the failure to every waiting caller", async () => {
    const cache = createSaleListingCache<string>();
    const pending = deferred<string>();
    const load = () => pending.promise;

    const a = cache.read("k", load);
    const b = cache.read("k", load);
    pending.reject(new Error("query failed"));
    await assert.rejects(a, /query failed/);
    await assert.rejects(b, /query failed/);
    assert.deepEqual(await cache.read("k", async () => "recovered"), {
      value: "recovered",
      cached: false,
    });
  });

  it("keeps the stale entry when its background read fails, until the maximum age", async () => {
    const time = clock();
    const errors: unknown[] = [];
    const cache = createSaleListingCache<string>({
      now: time.now,
      freshMs: 30,
      maxAgeMs: 60,
      onBackgroundError: (error) => errors.push(error),
    });

    await cache.read("k", async () => "first");
    time.advance(40);
    const failing = async (): Promise<string> => {
      throw new Error("background failed");
    };
    assert.deepEqual(await cache.read("k", failing), { value: "first", cached: true });
    await settle();
    assert.equal(errors.length, 1);
    assert.deepEqual(await cache.read("k", failing), { value: "first", cached: true });
    time.advance(20);
    await assert.rejects(cache.read("k", failing), /background failed/);
  });

  it("waits out the retry delay before a stale hit starts another background read", async () => {
    const time = clock();
    const errors: unknown[] = [];
    const cache = createSaleListingCache<string>({
      now: time.now,
      freshMs: 30,
      maxAgeMs: 100,
      backgroundRetryMs: 10,
      onBackgroundError: (error) => errors.push(error),
    });
    await cache.read("k", async () => "first");
    time.advance(30);

    let calls = 0;
    const failing = async (): Promise<string> => {
      calls += 1;
      throw new Error("database struggling");
    };
    assert.deepEqual(await cache.read("k", failing), { value: "first", cached: true });
    await settle();
    assert.equal(calls, 1);

    time.advance(9);
    assert.deepEqual(await cache.read("k", failing), { value: "first", cached: true });
    await settle();
    assert.equal(calls, 1, "stale hits inside the retry delay start no read");

    time.advance(1);
    assert.deepEqual(await cache.read("k", failing), { value: "first", cached: true });
    await settle();
    assert.equal(calls, 2, "the first stale hit after the delay retries");
    assert.equal(errors.length, 2);

    // A successful retry clears the delay along with the stale entry.
    time.advance(10);
    await cache.read("k", async () => "second");
    await settle();
    assert.deepEqual(await cache.read("k", failing), { value: "second", cached: true });
  });

  it("the retry delay holds back only background reads, never a refresh or an expired read", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({
      now: time.now,
      freshMs: 30,
      maxAgeMs: 60,
      backgroundRetryMs: 1_000,
      onBackgroundError: () => undefined,
    });
    await cache.read("k", async () => "first");
    time.advance(30);
    await cache.read("k", async () => {
      throw new Error("background failed");
    });
    await settle();

    assert.equal(await cache.refresh("k", async () => "refreshed"), "refreshed");
    time.advance(60);
    assert.deepEqual(await cache.read("k", async () => "expired read"), {
      value: "expired read",
      cached: false,
    });
  });

  it("refresh drops the entry and waits on a new read", async () => {
    const cache = createSaleListingCache<string>();
    await cache.read("k", async () => "outdated");
    assert.equal(await cache.refresh("k", async () => "current"), "current");
    assert.deepEqual(await cache.read("k", async () => "unused"), { value: "current", cached: true });
  });

  it("refresh starts a new read instead of joining a background read already in flight", async () => {
    const time = clock();
    const cache = createSaleListingCache<string>({ now: time.now, freshMs: 30, maxAgeMs: 60 });
    await cache.read("k", async () => "cached");
    time.advance(30);

    // The background read began before the caller learned the cached page was outdated.
    const background = deferred<string>();
    assert.deepEqual(await cache.read("k", () => background.promise), { value: "cached", cached: true });

    let forcedCalls = 0;
    const forced = cache.refresh("k", async () => {
      forcedCalls += 1;
      return "current";
    });
    assert.equal(await forced, "current");
    assert.equal(forcedCalls, 1);

    // The superseded background read settles late and must not overwrite the forced result.
    background.resolve("outdated");
    await settle();
    assert.deepEqual(await cache.read("k", async () => "unused"), { value: "current", cached: true });
  });

  it("shares one read between concurrent refreshes of a key", async () => {
    const cache = createSaleListingCache<string>();
    await cache.read("k", async () => "cached");
    const pending = deferred<string>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };

    const a = cache.refresh("k", load);
    const b = cache.refresh("k", load);
    pending.resolve("current");
    assert.deepEqual(await Promise.all([a, b]), ["current", "current"]);
    assert.equal(calls, 1);
  });

  it("a read that throws before it awaits does not wedge its key", async () => {
    const cache = createSaleListingCache<string>();
    const throwsNow = (): Promise<string> => {
      throw new Error("threw synchronously");
    };
    await assert.rejects(cache.read("k", throwsNow), /threw synchronously/);
    assert.deepEqual(await cache.read("k", async () => "recovered"), { value: "recovered", cached: false });
  });

  it("evicts the least recently used entry past the entry limit", async () => {
    const cache = createSaleListingCache<string>({ maxEntries: 2 });
    await cache.read("a", async () => "A");
    await cache.read("b", async () => "B");
    await cache.read("a", async () => "unused");
    await cache.read("c", async () => "C");

    assert.deepEqual(await cache.read("a", async () => "unused"), { value: "A", cached: true });
    assert.deepEqual(await cache.read("b", async () => "B again"), { value: "B again", cached: false });
  });

  it("rejects bounds that cannot hold an entry", () => {
    assert.throws(() => createSaleListingCache({ freshMs: 0 }), RangeError);
    assert.throws(() => createSaleListingCache({ maxAgeMs: 1.5 }), RangeError);
    assert.throws(() => createSaleListingCache({ maxEntries: -1 }), RangeError);
    assert.throws(() => createSaleListingCache({ freshMs: 61, maxAgeMs: 60 }), RangeError);
    assert.throws(() => createSaleListingCache({ backgroundRetryMs: 0 }), RangeError);
  });
});
