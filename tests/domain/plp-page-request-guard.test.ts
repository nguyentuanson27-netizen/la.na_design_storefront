import assert from "node:assert/strict";
import test from "node:test";

import {
  createPageRequestGuard,
  settleIfCurrent,
} from "../../src/components/headless/plp-page-request-guard.ts";

/** A request the test resolves or rejects by hand, so ordering is the test's to choose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const listA = ["a1", "a2"];
const listB = ["b1", "b2"];

test("an answer for the list still on screen is applied", async () => {
  const guard = createPageRequestGuard(listA);
  const request = deferred<string>();
  const settled = settleIfCurrent(guard, () => request.promise);

  request.resolve("page-2-of-A");
  assert.deepEqual(await settled, { stale: false, value: "page-2-of-A" });
});

test("an answer that arrives after the filter changed is dropped", async () => {
  const guard = createPageRequestGuard(listA);
  const requestA = deferred<string>();
  const settledA = settleIfCurrent(guard, () => requestA.promise);

  // Request A is pending; the shopper switches to B, which resets the grid.
  guard.setList(listB);
  requestA.resolve("page-2-of-A");

  assert.deepEqual(await settledA, { stale: true });
});

test("a failure for a list the shopper has left is swallowed, a current one is rethrown", async () => {
  const guard = createPageRequestGuard(listA);

  const stale = deferred<string>();
  const settledStale = settleIfCurrent(guard, () => stale.promise);
  guard.setList(listB);
  stale.reject(new Error("timeout for A"));
  assert.deepEqual(await settledStale, { stale: true });

  const current = deferred<string>();
  const settledCurrent = settleIfCurrent(guard, () => current.promise);
  current.reject(new Error("timeout for B"));
  await assert.rejects(settledCurrent, /timeout for B/);
});

test("the new list's own request is applied even when the old one answers after it", async () => {
  const guard = createPageRequestGuard(listA);
  const requestA = deferred<string>();
  const settledA = settleIfCurrent(guard, () => requestA.promise);

  guard.setList(listB);
  const requestB = deferred<string>();
  const settledB = settleIfCurrent(guard, () => requestB.promise);

  // B answers first, then the late A.
  requestB.resolve("page-2-of-B");
  requestA.resolve("page-2-of-A");

  assert.deepEqual(await settledB, { stale: false, value: "page-2-of-B" });
  assert.deepEqual(await settledA, { stale: true });
});

test("returning to an earlier list does not revive a request begun for the same list before", async () => {
  // A -> B -> A again with a fresh product array: the old A request must stay dropped, or its
  // page 2 would be appended after the rebuilt page 1 of the same filter.
  const guard = createPageRequestGuard(listA);
  const requestA = deferred<string>();
  const settledA = settleIfCurrent(guard, () => requestA.promise);

  guard.setList(listB);
  guard.setList(["a1", "a2"]);
  requestA.resolve("page-2-of-old-A");

  assert.deepEqual(await settledA, { stale: true });
});
