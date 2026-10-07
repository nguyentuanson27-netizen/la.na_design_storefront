import assert from "node:assert/strict";
import test from "node:test";

import { createCartSummaryStore } from "../../src/components/headless/cart-summary-store-core.ts";
import { EMPTY_CART_SUMMARY, type CartSummary } from "../../src/routes/cart-model.ts";

const summary = (count: number): CartSummary => ({ count, totalText: `${count * 100}` });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a server read lands when nothing else was published meanwhile", async () => {
  const read = deferred<CartSummary>();
  const store = createCartSummaryStore(() => read.promise);

  const pending = store.refresh();
  read.resolve(summary(2));
  await pending;

  assert.deepEqual(store.getSnapshot(), summary(2));
});

test("a newer local publish wins over an older in-flight server read", async () => {
  const read = deferred<CartSummary>();
  const store = createCartSummaryStore(() => read.promise);

  // The header read starts while the cart still holds item A...
  const pending = store.refresh();
  // ...the shopper empties the cart in the drawer, which publishes the empty summary...
  store.publish(EMPTY_CART_SUMMARY);
  // ...and only then does the older read return with the stale cart.
  read.resolve(summary(1));
  await pending;

  assert.equal(store.getSnapshot(), EMPTY_CART_SUMMARY);
});

test("a local publish of an unchanged value still invalidates an older read", async () => {
  const read = deferred<CartSummary>();
  const store = createCartSummaryStore(() => read.promise);
  store.publish(summary(1));

  const pending = store.refresh();
  store.publish(summary(1));
  read.resolve(summary(5));
  await pending;

  assert.deepEqual(store.getSnapshot(), summary(1));
});

test("an older read cannot overwrite a newer read", async () => {
  const first = deferred<CartSummary>();
  const second = deferred<CartSummary>();
  const reads = [first, second];
  const store = createCartSummaryStore(() => reads.shift()!.promise);

  const older = store.refresh();
  const newer = store.refresh();
  second.resolve(summary(3));
  await newer;
  first.resolve(summary(1));
  await older;

  assert.deepEqual(store.getSnapshot(), summary(3));
});

test("a failed read keeps the last summary and does not throw", async () => {
  const read = deferred<CartSummary>();
  const store = createCartSummaryStore(() => read.promise);
  store.publish(summary(2));

  const pending = store.refresh();
  read.reject(new Error("offline"));
  await pending;

  assert.deepEqual(store.getSnapshot(), summary(2));
});

test("subscribers are told only when the summary actually changes", () => {
  const store = createCartSummaryStore(async () => EMPTY_CART_SUMMARY);
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });

  store.publish(summary(1));
  store.publish(summary(1));
  store.publish(summary(2));
  unsubscribe();
  store.publish(summary(3));

  assert.equal(calls, 2);
});
