import assert from "node:assert/strict";
import test from "node:test";
import { createUpsellReadGate } from "../../src/commerce/checkout-upsell-read-gate.ts";

test("two simultaneous optional requests exhaust the gate until one completes", async () => {
  const gate = createUpsellReadGate(2);
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstHold = new Promise<void>((resolve) => { finishFirst = resolve; });
  const secondHold = new Promise<void>((resolve) => { finishSecond = resolve; });
  const runRequest = async (hold: Promise<void>) => {
    const release = gate.tryAcquire();
    if (!release) return "busy";
    try {
      await hold;
      return "ok";
    } finally {
      release();
    }
  };
  const first = runRequest(firstHold);
  const second = runRequest(secondHold);
  assert.equal(await runRequest(Promise.resolve()), "busy");
  finishFirst();
  assert.equal(await first, "ok");
  assert.equal(await runRequest(Promise.resolve()), "ok");
  finishSecond();
  assert.equal(await second, "ok");
});

test("releasing a slot twice cannot admit more than the configured concurrency", () => {
  const gate = createUpsellReadGate(2);
  const first = gate.tryAcquire();
  assert.ok(first);
  first();
  first();
  const second = gate.tryAcquire();
  const third = gate.tryAcquire();
  assert.ok(second);
  assert.ok(third);
  assert.equal(gate.tryAcquire(), null);
  second();
  third();
});

test("invalid limits are rejected before accepting reads", () => {
  assert.throws(() => createUpsellReadGate(0), TypeError);
  assert.throws(() => createUpsellReadGate(1.5), TypeError);
});
