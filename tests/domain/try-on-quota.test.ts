import assert from "node:assert/strict";
import test from "node:test";

import { createTryOnQuotaLoader } from "../../src/components/headless/try-on-quota.ts";

const guestQuota = (remaining: number) => ({ ok: true, audience: "guest", limit: 5, remaining });

/** A request the test settles by hand, so the order of answers is the test's to decide. */
function deferredRequests() {
  const pending: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void; signal: AbortSignal }> = [];
  const request = (signal: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    });
  return { request, pending };
}

test("an answer is known only when it is a well-formed quota", async () => {
  const loader = createTryOnQuotaLoader(async () => guestQuota(3));
  assert.deepEqual(await loader.load(), {
    kind: "known",
    quota: { audience: "guest", limit: 5, remaining: 3 },
  });
});

test("a failed request, or an unusable answer, is unknown rather than the last number", async () => {
  const failing = createTryOnQuotaLoader(async () => {
    throw new TypeError("offline");
  });
  assert.deepEqual(await failing.load(), { kind: "unknown" });

  for (const payload of [null, { ok: false }, { ok: true, audience: "guest", limit: 5 }]) {
    const loader = createTryOnQuotaLoader(async () => payload);
    assert.deepEqual(await loader.load(), { kind: "unknown" }, JSON.stringify(payload));
  }
});

test("an older answer that arrives after a newer one cannot overwrite it", async () => {
  const { request, pending } = deferredRequests();
  const loader = createTryOnQuotaLoader(request);

  const first = loader.load();
  const second = loader.load();
  assert.equal(pending.length, 2);
  // The first request was aborted when the second began.
  assert.equal(pending[0]!.signal.aborted, true);
  assert.equal(pending[1]!.signal.aborted, false);

  // The fresher answer lands first, then the stale one resolves late with an older number.
  pending[1]!.resolve(guestQuota(2));
  pending[0]!.resolve(guestQuota(4));

  assert.deepEqual(await second, { kind: "known", quota: { audience: "guest", limit: 5, remaining: 2 } });
  assert.deepEqual(await first, { kind: "superseded" });
});

test("a superseded request that fails is ignored too, not reported as unknown", async () => {
  const { request, pending } = deferredRequests();
  const loader = createTryOnQuotaLoader(request);

  const first = loader.load();
  const second = loader.load();
  pending[0]!.reject(new DOMException("aborted", "AbortError"));
  pending[1]!.resolve(guestQuota(1));

  assert.deepEqual(await first, { kind: "superseded" });
  assert.equal((await second).kind, "known");
});

test("cancelling drops an answer that lands afterwards (the dialog was closed meanwhile)", async () => {
  const { request, pending } = deferredRequests();
  const loader = createTryOnQuotaLoader(request);

  const answer = loader.load();
  loader.cancel();
  assert.equal(pending[0]!.signal.aborted, true);
  pending[0]!.resolve(guestQuota(5));

  assert.deepEqual(await answer, { kind: "superseded" });
});

test("a refresh after a cancel starts clean and is applied", async () => {
  const { request, pending } = deferredRequests();
  const loader = createTryOnQuotaLoader(request);

  const stale = loader.load();
  loader.cancel();
  const fresh = loader.load();
  pending[1]!.resolve(guestQuota(5));
  pending[0]!.resolve(guestQuota(1));

  assert.deepEqual(await fresh, { kind: "known", quota: { audience: "guest", limit: 5, remaining: 5 } });
  assert.deepEqual(await stale, { kind: "superseded" });
});
