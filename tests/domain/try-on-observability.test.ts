import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTryOnSignal,
  emitTryOnSignal,
} from "../../src/operations/try-on-observability.ts";

test("signals carry only the allowlisted operational fields", () => {
  const signal = buildTryOnSignal({
    name: "try_on.generation_failed",
    reason: "SAFETY_BLOCKED",
    latencyMs: 1234.7,
    upstreamLatencyMs: 1000,
    productSlug: "vay-hoa-xanh",
    // Hostile extras a future caller might pass by mistake must not survive.
    ...({
      imageBase64: "AAAA",
      authorization: "Bearer secret",
      ip: "203.0.113.9",
      rawUpstreamBody: "{...}",
    } as object),
  });
  assert.deepEqual(signal, {
    name: "try_on.generation_failed",
    reason: "SAFETY_BLOCKED",
    latencyMs: 1235,
    upstreamLatencyMs: 1000,
    productSlug: "vay-hoa-xanh",
  });
});

test("an unknown reason, a malformed slug or a non-finite latency is dropped, not emitted", () => {
  const signal = buildTryOnSignal({
    name: "try_on.generation_failed",
    reason: "project lana-design-prod exploded" as never,
    latencyMs: Number.NaN,
    productSlug: "https://evil.example/?q=1",
  });
  assert.deepEqual(signal, { name: "try_on.generation_failed" });
});

test("emission is one JSON object per line on the injected writer", () => {
  const lines: string[] = [];
  emitTryOnSignal({ name: "try_on.rate_limited", reason: "RATE_LIMITED" }, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(lines[0]!), { name: "try_on.rate_limited", reason: "RATE_LIMITED" });
});

test("a failing writer never throws into the request", () => {
  assert.doesNotThrow(() =>
    emitTryOnSignal({ name: "try_on.generation_started" }, () => {
      throw new Error("stdout closed");
    }),
  );
});
