import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CATALOG_SYNC_INTERVAL_SECONDS,
  evaluateCatalogSyncHeartbeat,
  parseCatalogSyncIntervalSeconds,
  runCatalogSyncLoop,
} from "../../src/operations/catalog-sync-loop.ts";

test("the sync interval defaults to five minutes and refuses values that would hammer or stall", () => {
  assert.equal(parseCatalogSyncIntervalSeconds(undefined), DEFAULT_CATALOG_SYNC_INTERVAL_SECONDS);
  assert.equal(parseCatalogSyncIntervalSeconds(""), 300);
  assert.equal(parseCatalogSyncIntervalSeconds("60"), 60);
  assert.equal(parseCatalogSyncIntervalSeconds(" 900 "), 900);
  for (const raw of ["0", "59", "86401", "-5", "1.5", "5m", "abc"]) {
    assert.throws(() => parseCatalogSyncIntervalSeconds(raw), RangeError, raw);
  }
});

test("the loop syncs immediately, then once per interval, until stopped", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let calls = 0;
  const result = await runCatalogSyncLoop({
    sync: async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      return { products: 2, variations: 5 };
    },
    intervalMs: 300_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
    log: () => undefined,
  });
  assert.deepEqual(result, { runs: 3, failures: 0 });
  assert.deepEqual(sleeps, [300_000, 300_000]);
});

test("a failed sync is retried next interval and never logs the error it carried", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  let calls = 0;
  const result = await runCatalogSyncLoop({
    sync: async () => {
      calls += 1;
      if (calls === 1) throw new Error("api_key=SECRET payload");
      controller.abort();
      return { products: 1, variations: 1 };
    },
    intervalMs: 1,
    sleep: async () => undefined,
    signal: controller.signal,
    log: (line) => lines.push(line),
    now: () => new Date("2026-09-27T00:00:00.000Z"),
  });
  assert.deepEqual(result, { runs: 2, failures: 1 });
  assert.equal(lines.some((line) => line.includes("SECRET")), false);
  assert.match(lines[0]!, /catalog sync failed/);
  assert.match(lines[1]!, /catalog sync ok: 1 products, 1 variations/);
});

test("a stop during the wait ends the loop without another sync", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runCatalogSyncLoop({
    sync: async () => {
      calls += 1;
      return { products: 0, variations: 0 };
    },
    intervalMs: 300_000,
    sleep: async () => controller.abort(),
    signal: controller.signal,
    log: () => undefined,
  });
  assert.deepEqual(result, { runs: 1, failures: 0 });
  assert.equal(calls, 1);
});

test("the heartbeat is written only after a successful sync, and a failed write is not a failed sync", async () => {
  const controller = new AbortController();
  const beats: string[] = [];
  let calls = 0;
  const result = await runCatalogSyncLoop({
    sync: async () => {
      calls += 1;
      if (calls === 1) throw new Error("pancake down");
      if (calls === 3) controller.abort();
      return { products: 1, variations: 1 };
    },
    intervalMs: 1,
    sleep: async () => undefined,
    signal: controller.signal,
    log: () => undefined,
    onSuccess: (at) => {
      beats.push(at.toISOString());
      if (beats.length === 1) throw new Error("disk full");
    },
    now: () => new Date("2026-09-27T01:00:00.000Z"),
  });
  assert.deepEqual(result, { runs: 3, failures: 1 });
  assert.deepEqual(beats, ["2026-09-27T01:00:00.000Z", "2026-09-27T01:00:00.000Z"]);
});

test("health needs a recent success: never, unreadable and stale heartbeats are all unhealthy", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
  assert.deepEqual(evaluateCatalogSyncHeartbeat({ heartbeat: null, now, intervalSeconds: 300 }), {
    healthy: false,
    reason: "NEVER_SUCCEEDED",
    ageSeconds: null,
  });
  assert.deepEqual(evaluateCatalogSyncHeartbeat({ heartbeat: "garbage", now, intervalSeconds: 300 }), {
    healthy: false,
    reason: "HEARTBEAT_UNREADABLE",
    ageSeconds: null,
  });
  // One missed run is tolerated: 2 intervals + 120s.
  assert.equal(evaluateCatalogSyncHeartbeat({ heartbeat: ago(720), now, intervalSeconds: 300 }).healthy, true);
  assert.deepEqual(evaluateCatalogSyncHeartbeat({ heartbeat: ago(721), now, intervalSeconds: 300 }), {
    healthy: false,
    reason: "STALE",
    ageSeconds: 721,
  });
  assert.equal(evaluateCatalogSyncHeartbeat({ heartbeat: `${ago(5)}\n`, now, intervalSeconds: 60 }).healthy, true);
});
