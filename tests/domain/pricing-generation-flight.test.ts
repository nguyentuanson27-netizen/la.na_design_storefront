import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPricingGenerationReader,
  type PricingGeneration,
} from "../../src/commerce/pricing-generation-flight.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const at = (ms: number) => new Date(ms);
const generation = (key: string): PricingGeneration => ({ key, nextBoundaryAt: null });

describe("pricing generation flight", () => {
  it("serves 100 requests that arrive while a read runs with exactly one more read", async () => {
    const gates = [deferred<PricingGeneration>(), deferred<PricingGeneration>()];
    let reads = 0;
    const read = createPricingGenerationReader(() => gates[reads++]!.promise);

    const leader = read(at(1_000));
    const late = Array.from({ length: 100 }, (_, index) => read(at(1_000 + index)));
    assert.equal(reads, 1, "a late request does not start a read while one runs");

    gates[0]!.resolve(generation("r1"));
    assert.equal((await leader).key, "r1");
    await Promise.resolve();
    assert.equal(reads, 2, "the whole batch shares the one read that starts after the first ends");
    gates[1]!.resolve(generation("r2"));
    const results = await Promise.all(late);
    assert.ok(results.every((result) => result.key === "r2"));
    assert.equal(reads, 2);
  });

  it("never gives a request a generation read before it arrived", async () => {
    // r1 read begins, a promotion publish commits r2, then a new request arrives and r1's read settles.
    const first = deferred<PricingGeneration>();
    let reads = 0;
    const read = createPricingGenerationReader(() => {
      reads += 1;
      return reads === 1 ? first.promise : Promise.resolve(generation("r2"));
    });
    const before = read(at(1_000));
    const after = read(at(2_000));
    first.resolve(generation("r1"));
    assert.equal((await before).key, "r1");
    assert.equal((await after).key, "r2");
  });

  it("reads the batch at the latest instant among its waiters", async () => {
    const first = deferred<PricingGeneration>();
    const instants: number[] = [];
    const read = createPricingGenerationReader((now) => {
      instants.push(now.getTime());
      return instants.length === 1 ? first.promise : Promise.resolve(generation("r1"));
    });
    const leader = read(at(1_000));
    const a = read(at(3_000));
    const b = read(at(2_000));
    first.resolve(generation("r1"));
    await Promise.all([leader, a, b]);
    assert.deepEqual(instants, [1_000, 3_000]);
  });

  it("never reuses a finished read: the next request reads again", async () => {
    let reads = 0;
    const read = createPricingGenerationReader(async () => generation(`r${++reads}`));
    assert.equal((await read(at(1))).key, "r1");
    assert.equal((await read(at(2))).key, "r2");
  });

  it("shares a failed batch read among its waiters and recovers on the next request", async () => {
    const first = deferred<PricingGeneration>();
    const second = deferred<PricingGeneration>();
    let reads = 0;
    const read = createPricingGenerationReader(() => {
      reads += 1;
      if (reads === 1) return first.promise;
      if (reads === 2) return second.promise;
      return Promise.resolve(generation("ok"));
    });
    const leader = read(at(1));
    const late = [read(at(2)), read(at(3))];
    first.reject(new Error("leader down"));
    await assert.rejects(leader, /leader down/);
    await Promise.resolve();
    second.reject(new Error("batch down"));
    for (const waiter of late) await assert.rejects(waiter, /batch down/);
    assert.equal((await read(at(4))).key, "ok");
    assert.equal(reads, 3);
  });
});
