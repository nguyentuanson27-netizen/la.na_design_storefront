import assert from "node:assert/strict";
import test from "node:test";
import { createPdpVideoPlaybackReporter, sendPdpVideoPlaybackEvent } from "../../src/components/headless/pdp-video-playback.ts";
import type { PdpVideoPlaybackEvent } from "../../src/commerce/pdp-video-playback.ts";
import { createPdpVideoCollector } from "../../src/operations/pdp-video-collector.ts";
import { summarizePdpVideoPlaybackLogs } from "../../src/operations/pdp-video-playback-summary.ts";

const ORIGIN = "https://www.lanadesign.vn";
function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/product-video/events`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
}
function fixture(overrides = {}) {
  const logs: string[] = [];
  const handler = createPdpVideoCollector({ enabled: () => true, origin: () => ORIGIN, now: () => 1000, write: (line: string) => { logs.push(line); }, ...overrides });
  return { logs, handler };
}

test("one attempt per explicit playback opening, one failure across repeated source/player callbacks", () => {
  const events: PdpVideoPlaybackEvent[] = [];
  const session = createPdpVideoPlaybackReporter((event) => { events.push(event); });
  session.play(); session.play(); session.error(2); session.error(4); session.play();
  assert.deepEqual(events, [{ kind: "attempt" }, { kind: "failure", reason: "network" }]);
  session.close(); session.error(3); session.play();
  assert.equal(events.length, 2);
  const reopened = createPdpVideoPlaybackReporter((event) => { events.push(event); });
  reopened.error(3); reopened.error(3); reopened.play();
  assert.deepEqual(events.slice(2), [{ kind: "attempt" }, { kind: "failure", reason: "decode" }]);
});

test("abort/close and telemetry failure cannot change the player or leak error details", () => {
  const events: PdpVideoPlaybackEvent[] = [];
  const session = createPdpVideoPlaybackReporter((event) => { events.push(event); throw new Error("private data"); });
  session.error(1);
  assert.deepEqual(events, []);
  assert.doesNotThrow(() => session.error(4));
  assert.deepEqual(events, [{ kind: "attempt" }, { kind: "failure", reason: "unsupported" }]);
  assert.doesNotThrow(() => session.close());
  const unknown: PdpVideoPlaybackEvent[] = [];
  createPdpVideoPlaybackReporter((event) => { unknown.push(event); }).error(undefined);
  assert.deepEqual(unknown, [{ kind: "attempt" }, { kind: "failure", reason: "unknown" }]);
});

test("browser transport is same-origin, has no cookies/referrer/source, and does not retry", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  await sendPdpVideoPlaybackEvent({ kind: "failure", reason: "decode" }, async (url, init) => {
    calls.push({ url: String(url), init });
    throw new Error("offline");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/product-video/events");
  assert.equal(calls[0]!.init?.credentials, "omit");
  assert.equal(calls[0]!.init?.referrerPolicy, "no-referrer");
  assert.equal(calls[0]!.init?.mode, "same-origin");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { kind: "failure", reason: "decode" });
});

test("collector emits only numeric deltas and allowlisted failure categories", async () => {
  const { handler, logs } = fixture();
  for (const payload of [{ kind: "attempt" }, { kind: "failure", reason: "network" }, { kind: "failure", reason: "decode" }, { kind: "failure", reason: "unsupported" }, { kind: "failure", reason: "unknown" }]) {
    const response = await handler(request(payload));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.deepEqual(JSON.parse(logs[0]!), { name: "pdp_video.playback", attempts: 1, failures: 0 });
  assert.deepEqual(JSON.parse(logs[1]!), { name: "pdp_video.playback", attempts: 0, failures: 1, reason: "network" });
});

test("collector refuses off flag, cross-origin, missing origin, forged Host, types and unknown fields", async () => {
  const { handler, logs } = fixture();
  for (const payload of [{ kind: "attempt", url: "https://content.pancake.vn/private.mp4" }, { kind: "failure", reason: "secret" }, { kind: "attempt", productSlug: "private" }, { kind: "failure" }, { kind: "attempt", reason: "unknown" }, [], null, "attempt"]) {
    await handler(request(payload));
  }
  await handler(request({ kind: "attempt" }, { origin: "https://evil.test", host: "evil.test" }));
  await handler(request({ kind: "attempt" }, { origin: "", host: "www.lanadesign.vn" }));
  await handler(request({ kind: "attempt" }, { "content-type": "text/plain" }));
  await fixture({ enabled: () => false, write: (line: string) => logs.push(line) }).handler(request({ kind: "attempt" }));
  assert.deepEqual(logs, []);
});

test("collector bounds actual streamed bytes and deadlines, ignores malformed JSON and logging outages", async () => {
  const { handler, logs } = fixture({ bodyTimeoutMs: 20 });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(129))); }, cancel() { cancelled = true; } });
  const streamed = new Request(`${ORIGIN}/api/product-video/events`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  assert.equal((await handler(streamed)).status, 204);
  assert.equal(cancelled, true);
  const stalled = new Request(`${ORIGIN}/api/product-video/events`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: new ReadableStream({}), duplex: "half" } as RequestInit);
  const keepAlive = setTimeout(() => undefined, 200);
  try { assert.equal((await handler(stalled)).status, 204); } finally { clearTimeout(keepAlive); }
  await handler(new Request(`${ORIGIN}/api/product-video/events`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" }));
  assert.deepEqual(logs, []);
  const unavailable = fixture({ write: () => { throw new Error("disk unavailable"); } });
  assert.equal((await unavailable.handler(request({ kind: "attempt" }))).status, 204);
});

test("collector caps process log volume and marks suppressed windows once, then recovers", async () => {
  let now = 1000;
  const { handler, logs } = fixture({ now: () => now, limit: 2 });
  await handler(request({ kind: "attempt" }));
  await handler(request({ kind: "failure", reason: "network" }));
  for (let i = 0; i < 10; i++) await handler(request({ kind: "attempt" }));
  assert.equal(logs.length, 3);
  assert.deepEqual(JSON.parse(logs[2]!), { name: "pdp_video.telemetry_suppressed" });
  now += 60000;
  await handler(request({ kind: "attempt" }));
  assert.equal(logs.length, 4);
  const summary = summarizePdpVideoPlaybackLogs(logs);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.suppressedWindows, 1);
  assert.equal(summary.status, "INCOMPLETE");
});

test("operator summary streams allowlisted counters, ignores poisoned/unrelated records and reports no data honestly", () => {
  const summary = summarizePdpVideoPlaybackLogs([
    JSON.stringify({ name: "pdp_video.playback", attempts: 1, failures: 0 }),
    JSON.stringify({ name: "pdp_video.playback", attempts: 1, failures: 0 }),
    JSON.stringify({ name: "pdp_video.playback", attempts: 0, failures: 1, reason: "decode" }),
    JSON.stringify({ name: "pdp_video.playback", attempts: 500, failures: 0, url: "secret" }),
    JSON.stringify({ name: "unrelated", attempts: 999 }), "broken json",
  ]);
  assert.deepEqual(summary, { attempts: 2, failures: 1, failureRate: 0.5, errors: { network: 0, decode: 1, unsupported: 0, unknown: 0 }, suppressedWindows: 0, status: "OBSERVED" });
  assert.equal(summarizePdpVideoPlaybackLogs([]).failureRate, null);
  assert.equal(summarizePdpVideoPlaybackLogs([]).status, "NO_DATA");
});
