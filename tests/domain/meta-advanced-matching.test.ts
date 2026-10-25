import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildMetaUserData, hashMetaIdentifier } from "../../src/integrations/meta/conversions-api.ts";

const PIXEL_ID = "123456789012345";
const VISITOR_ID = "a".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceWindow(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value });
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", previous);
  };
}

async function loadModule(t: test.TestContext) {
  const previousPixelId = process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
  process.env.LA_BUILD_FACEBOOK_PIXEL_ID = PIXEL_ID;
  t.after(() => {
    if (previousPixelId === undefined) delete process.env.LA_BUILD_FACEBOOK_PIXEL_ID;
    else process.env.LA_BUILD_FACEBOOK_PIXEL_ID = previousPixelId;
  });
  return import("../../src/components/analytics/meta-advanced-matching.ts");
}

test("browser advanced matching hashes exactly what the Conversions API hashes", async (t) => {
  const { buildMetaAdvancedMatching } = await loadModule(t);
  const input = { name: "  Nguyễn   Văn An ", phone: "+84 0912 345 678" };

  const browser = await buildMetaAdvancedMatching(input);
  const server = buildMetaUserData({
    phone: input.phone,
    fullName: input.name,
    clientIpAddress: null,
    clientUserAgent: null,
    fbp: null,
    fbc: null,
    externalId: null,
  });

  assert.deepEqual([browser.ph], server.ph);
  assert.deepEqual([browser.fn], server.fn);
  assert.deepEqual([browser.ln], server.ln);
  assert.equal(browser.ph, sha256("84912345678"));
  assert.equal(browser.fn, hashMetaIdentifier("An"));
});

test("a phone or name Meta could not match on is left out rather than hashed as noise", async (t) => {
  const { buildMetaAdvancedMatching } = await loadModule(t);
  assert.deepEqual(await buildMetaAdvancedMatching({ name: "1234", phone: "không có số" }), {});
});

test("the pixel gets hashed identifiers merged into what init already carried", async (t) => {
  const { applyMetaAdvancedMatching } = await loadModule(t);
  const calls: unknown[][] = [];
  const fbq = (...args: unknown[]) => void calls.push(args);
  const holder = { laMetaAdvancedMatching: true, fbq, laMetaPixelUserData: { external_id: VISITOR_ID } as Record<string, string> };
  t.after(replaceWindow(holder));

  await applyMetaAdvancedMatching({ name: "Trần Bình", phone: "0912345678" });

  assert.equal(calls.length, 1);
  const [method, pixelId, userData] = calls[0] as [string, string, Record<string, string>];
  assert.equal(method, "init");
  assert.equal(pixelId, PIXEL_ID);
  assert.deepEqual(userData, {
    external_id: VISITOR_ID,
    ph: sha256("84912345678"),
    fn: sha256("bình"),
    ln: sha256("trần"),
  });
  // Never the plain values.
  assert.ok(!JSON.stringify(calls).includes("0912345678"));
  assert.ok(!JSON.stringify(calls).includes("Bình"));
  // The base init data is never rewritten; every update starts from it.
  assert.deepEqual(holder.laMetaPixelUserData, { external_id: VISITOR_ID });
});

test("a later shopper never inherits an earlier shopper's identifiers", async (t) => {
  const { applyMetaAdvancedMatching } = await loadModule(t);
  const calls: unknown[][] = [];
  const holder = {
    laMetaAdvancedMatching: true,
    fbq: (...args: unknown[]) => void calls.push(args),
    laMetaPixelUserData: { external_id: VISITOR_ID } as Record<string, string>,
  };
  t.after(replaceWindow(holder));

  await applyMetaAdvancedMatching({ name: "Trần Bình", phone: "0912345678" });
  // Valid phone, but a name with no letters: only `ph` can be sent for this shopper.
  await applyMetaAdvancedMatching({ name: "1234", phone: "0987654321" });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]![2], { external_id: VISITOR_ID, ph: sha256("84987654321") });
});

test("the checkout waits for the pixel update, but never longer than the bound", async (t) => {
  const { applyMetaAdvancedMatchingWithin } = await loadModule(t);
  const calls: unknown[][] = [];
  t.after(replaceWindow({ laMetaAdvancedMatching: true, fbq: (...args: unknown[]) => void calls.push(args) }));

  // Fast path: the update has reached the pixel by the time the wait resolves.
  await applyMetaAdvancedMatchingWithin({ name: "Trần Bình", phone: "0912345678" });
  assert.equal(calls.length, 1);

  // Slow path: a hash that never finishes cannot hold the order past the bound.
  const subtle = globalThis.crypto.subtle;
  const original = Object.getOwnPropertyDescriptor(subtle, "digest");
  Object.defineProperty(subtle, "digest", { configurable: true, value: () => new Promise(() => {}) });
  t.after(() => {
    if (original) Object.defineProperty(subtle, "digest", original);
    else Reflect.deleteProperty(subtle, "digest");
  });
  const startedAt = Date.now();
  await applyMetaAdvancedMatchingWithin({ name: "Trần Bình", phone: "0912345678" }, 50);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(calls.length, 1);
});

test("an attempt that ran out of time never reaches the pixel after a newer one", async (t) => {
  const { applyMetaAdvancedMatchingWithin } = await loadModule(t);
  const calls: unknown[][] = [];
  t.after(replaceWindow({ laMetaAdvancedMatching: true, fbq: (...args: unknown[]) => void calls.push(args) }));

  // Attempt A's three digests hang until released; every later digest is immediate.
  const subtle = globalThis.crypto.subtle;
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(subtle), "digest")!;
  const realDigest = (original.value as SubtleCrypto["digest"]).bind(subtle);
  const releases: Array<() => void> = [];
  let digestCalls = 0;
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      digestCalls += 1;
      if (digestCalls > 3) return realDigest(algorithm, data);
      return new Promise<ArrayBuffer>((resolve) => {
        releases.push(() => void realDigest(algorithm, data).then(resolve));
      });
    },
  });
  t.after(() => Reflect.deleteProperty(subtle, "digest"));

  // A starts and times out; B then completes quickly; only after that A's hashes arrive.
  await applyMetaAdvancedMatchingWithin({ name: "Nguyễn An", phone: "0911111111" }, 20);
  await applyMetaAdvancedMatchingWithin({ name: "Trần Bình", phone: "0987654321" }, 500);
  for (const release of releases) release();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal((calls[0]![2] as Record<string, string>).ph, sha256("84987654321"));
});

test("a missing pixel or nothing matchable is a silent no-op", async (t) => {
  const { applyMetaAdvancedMatching } = await loadModule(t);

  t.after(replaceWindow({ laMetaAdvancedMatching: true }));
  await applyMetaAdvancedMatching({ name: "Trần Bình", phone: "0912345678" });

  const calls: unknown[][] = [];
  t.after(replaceWindow({ laMetaAdvancedMatching: true, fbq: (...args: unknown[]) => void calls.push(args) }));
  await applyMetaAdvancedMatching({ name: "", phone: "" });
  assert.equal(calls.length, 0);
});

test("switched off, nothing reaches the pixel and the checkout does not wait", async (t) => {
  const { applyMetaAdvancedMatching, applyMetaAdvancedMatchingWithin } = await loadModule(t);
  const calls: unknown[][] = [];
  // No `laMetaAdvancedMatching` flag: what the snippet renders while the switch is off.
  t.after(replaceWindow({ fbq: (...args: unknown[]) => void calls.push(args) }));

  await applyMetaAdvancedMatching({ name: "Trần Bình", phone: "0912345678" });
  await applyMetaAdvancedMatchingWithin({ name: "Trần Bình", phone: "0912345678" });
  assert.equal(calls.length, 0);
});

test("the advanced matching switch is on only for exactly true", async () => {
  const { readMetaAdvancedMatchingEnabled } = await import("../../src/integrations/meta/advanced-matching-config.ts");
  assert.equal(readMetaAdvancedMatchingEnabled({}), false);
  assert.equal(readMetaAdvancedMatchingEnabled({ LA_META_ADVANCED_MATCHING_ENABLED: "" }), false);
  assert.equal(readMetaAdvancedMatchingEnabled({ LA_META_ADVANCED_MATCHING_ENABLED: "1" }), false);
  assert.equal(readMetaAdvancedMatchingEnabled({ LA_META_ADVANCED_MATCHING_ENABLED: "TRUE" }), false);
  assert.equal(readMetaAdvancedMatchingEnabled({ LA_META_ADVANCED_MATCHING_ENABLED: "true" }), true);
});
