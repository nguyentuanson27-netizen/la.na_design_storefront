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

describe("pricing generation flight", () => {
  it("serves 100 simultaneous requests from one read", async () => {
    let reads = 0;
    const gate = deferred<PricingGeneration>();
    const read = createPricingGenerationReader(() => {
      reads += 1;
      return gate.promise;
    });
    const requests = Array.from({ length: 100 }, () => read(at(1_000)));
    gate.resolve({ key: "r1:bnone", nextBoundaryAt: null });
    const results = await Promise.all(requests);
    assert.equal(reads, 1);
    assert.ok(results.every((result) => result.key === "r1:bnone"));
  });

  it("never reuses a finished read: the next request reads again", async () => {
    let reads = 0;
    const read = createPricingGenerationReader(async () => {
      reads += 1;
      return { key: `r${reads}:bnone`, nextBoundaryAt: null };
    });
    assert.equal((await read(at(1))).key, "r1:bnone");
    assert.equal((await read(at(2))).key, "r2:bnone");
  });

  it("reads for itself when its instant is at or past the boundary the shared read found", async () => {
    let reads = 0;
    const gate = deferred<PricingGeneration>();
    const read = createPricingGenerationReader(() => {
      reads += 1;
      return reads === 1 ? gate.promise : Promise.resolve({ key: "r1:b-later", nextBoundaryAt: null });
    });
    const first = read(at(1_000));
    const late = read(at(5_000));
    gate.resolve({ key: "r1:b5000", nextBoundaryAt: at(5_000) });
    assert.equal((await first).key, "r1:b5000");
    assert.equal((await late).key, "r1:b-later");
    assert.equal(reads, 2);
  });

  it("shares a failure and recovers on the next request", async () => {
    let reads = 0;
    const gate = deferred<PricingGeneration>();
    const read = createPricingGenerationReader(() => {
      reads += 1;
      return reads === 1 ? gate.promise : Promise.resolve({ key: "ok", nextBoundaryAt: null });
    });
    const a = read(at(1));
    gate.reject(new Error("db down"));
    await assert.rejects(a, /db down/);
    assert.equal((await read(at(2))).key, "ok");
  });
});
