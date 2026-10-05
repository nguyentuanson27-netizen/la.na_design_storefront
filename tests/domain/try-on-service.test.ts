import assert from "node:assert/strict";
import test from "node:test";

import { resolveStorefrontProductMedia } from "../../src/commerce/product-media.ts";
import { createTryOnRateLimiter } from "../../src/commerce/try-on-rate-limit.ts";
import { createTryOnService, type TryOnServiceDependencies } from "../../src/commerce/try-on-service.ts";
import type { TryOnSignalInput } from "../../src/operations/try-on-observability.ts";
import { JPEG_BYTES, PNG_BYTES, tryOnForm } from "../support/try-on-fixtures.ts";

const CLIENT = "v1:" + "a".repeat(64);
const GUEST = { kind: "guest", key: CLIENT } as const;
/** Quotas wide enough that a test about something else never trips them. */
const OPEN = { guest: { perMinute: 100, perDay: 100 }, member: { perMinute: 100, perDay: 100 } } as const;
const FIRST_IMAGE = "https://content.pancake.vn/images/1/2/3/first.jpg";
const SECOND_IMAGE = "https://content.pancake.vn/images/1/2/3/second.png";
const CONFIG = { available: true, provider: "vertex", projectId: "lana-design-prod", location: "asia-southeast1" } as const;

function product(overrides: { categoryKeys?: string[]; primary?: string | null; variants?: string[][] } = {}) {
  return {
    slug: "vay-hoa",
    categoryKeys: overrides.categoryKeys ?? ["vayDam"],
    media: resolveStorefrontProductMedia({
      productName: "Váy hoa",
      primaryImageUrl: overrides.primary === undefined ? FIRST_IMAGE : overrides.primary,
      variantImageUrls: overrides.variants ?? [[SECOND_IMAGE]],
    }),
  };
}

type Probe = {
  loadProduct: string[];
  fetchProductImage: string[];
  generate: Array<{ person: Uint8Array; product: Uint8Array; projectId: string; location: string }>;
  signals: TryOnSignalInput[];
  readForm: number;
};

function build(overrides: Partial<TryOnServiceDependencies> = {}) {
  const probe: Probe = { loadProduct: [], fetchProductImage: [], generate: [], signals: [], readForm: 0 };
  const deps: TryOnServiceDependencies = {
    readConfig: () => CONFIG,
    limiter: createTryOnRateLimiter(),
    loadProduct: async (slug) => {
      probe.loadProduct.push(slug);
      return product();
    },
    fetchProductImage: async (url) => {
      probe.fetchProductImage.push(url);
      return { ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } };
    },
    generate: async ({ config, person, product: garment }) => {
      probe.generate.push({
        person: person.bytes,
        product: garment.bytes,
        projectId: config.projectId,
        location: config.location,
      });
      return { ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } };
    },
    emit: (signal) => probe.signals.push(signal),
    now: (() => {
      let t = 1_000;
      return () => (t += 50);
    })(),
    ...overrides,
  };
  const service = createTryOnService(deps);
  const run = (form: FormData | "TOO_LARGE" | "INVALID" = tryOnForm()) =>
    service.handle({
      identity: GUEST,
      readForm: async () => {
        probe.readForm += 1;
        return form;
      },
    });
  return { run, probe };
}

test("feature off: unavailable, and nothing downstream is touched", async () => {
  for (const reason of ["DISABLED", "NOT_CONFIGURED"] as const) {
    const { run, probe } = build({ readConfig: () => ({ available: false, reason }) });
    assert.deepEqual(await run(), { ok: false, reason: "UNAVAILABLE" });
    assert.equal(probe.readForm, 0);
    assert.equal(probe.loadProduct.length, 0);
    assert.equal(probe.generate.length, 0);
  }
});

test("a successful request makes exactly one provider call with the shopper photo and the trusted first image", async () => {
  const { run, probe } = build();
  const result = await run();

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.image.mimeType, "image/png");
  assert.deepEqual(probe.loadProduct, ["vay-hoa"]);
  assert.deepEqual(probe.fetchProductImage, [FIRST_IMAGE]);
  assert.equal(probe.generate.length, 1);
  assert.deepEqual([...probe.generate[0]!.person], [...JPEG_BYTES]);
  assert.deepEqual([...probe.generate[0]!.product], [...PNG_BYTES]);
  assert.equal(probe.generate[0]!.projectId, "lana-design-prod");
  assert.equal(probe.generate[0]!.location, "asia-southeast1");
});

test("a forged client product-image URL is ignored: only the server-resolved first image is fetched", async () => {
  const { run, probe } = build();
  await run(
    tryOnForm({
      extra: {
        productImageUrl: "https://evil.example/steal.jpg",
        imageUrl: SECOND_IMAGE,
        productImage: "http://169.254.169.254/",
      },
    }),
  );
  assert.deepEqual(probe.fetchProductImage, [FIRST_IMAGE]);
});

test("image 2 is never used when image 1 is unsupported", async () => {
  const { run, probe } = build({
    loadProduct: async () => product({ primary: "https://content.pancake.vn/images/1/2/3/first.webp" }),
  });
  assert.deepEqual(await run(), { ok: false, reason: "NOT_ELIGIBLE" });
  assert.equal(probe.fetchProductImage.length, 0);
  assert.equal(probe.generate.length, 0);
});

test("ineligible products never reach the product-image fetch or Vertex", async () => {
  for (const overrides of [
    { categoryKeys: ["phuKien"] },
    { categoryKeys: [] },
    { primary: null, variants: [] },
  ]) {
    const { run, probe } = build({ loadProduct: async () => product(overrides) });
    assert.deepEqual(await run(), { ok: false, reason: "NOT_ELIGIBLE" });
    assert.equal(probe.fetchProductImage.length, 0);
    assert.equal(probe.generate.length, 0);
  }
});

test("an unknown product is not eligible", async () => {
  const { run, probe } = build({ loadProduct: async () => null });
  assert.deepEqual(await run(), { ok: false, reason: "NOT_ELIGIBLE" });
  assert.equal(probe.generate.length, 0);
});

test("request gates reject before the product is even loaded, and never call Vertex", async () => {
  const cases: Array<[FormData | "TOO_LARGE" | "INVALID", string]> = [
    [tryOnForm({ likenessAcknowledged: null }), "LIKENESS_REQUIRED"],
    [tryOnForm({ likenessAcknowledged: "false" }), "LIKENESS_REQUIRED"],
    [tryOnForm({ ageState: null }), "AGE_STATE_INVALID"],
    [tryOnForm({ ageState: "kid" }), "AGE_STATE_INVALID"],
    [tryOnForm({ ageState: "below_digital_consent_age" }), "AGE_BLOCKED"],
    [tryOnForm({ photo: new File([new Uint8Array(4)], "x.webp", { type: "image/webp" }) }), "UNSUPPORTED_IMAGE"],
    ["TOO_LARGE", "IMAGE_TOO_LARGE"],
    ["INVALID", "INVALID_REQUEST"],
  ];
  for (const [form, reason] of cases) {
    const { run, probe } = build();
    assert.deepEqual(await run(form), { ok: false, reason }, reason);
    assert.equal(probe.loadProduct.length, 0, reason);
    assert.equal(probe.fetchProductImage.length, 0, reason);
    assert.equal(probe.generate.length, 0, reason);
  }
});

test("teen_eligible_with_guardian is allowed through to the provider", async () => {
  const { run, probe } = build();
  const result = await run(tryOnForm({ ageState: "teen_eligible_with_guardian" }));
  assert.equal(result.ok, true);
  assert.equal(probe.generate.length, 1);
});

test("a product image that cannot be fetched or is too large fails safely before the provider", async () => {
  for (const reason of ["TOO_LARGE", "FETCH_FAILED", "UNTRUSTED_URL"] as const) {
    const { run, probe } = build({ fetchProductImage: async () => ({ ok: false, reason }) });
    assert.deepEqual(await run(), { ok: false, reason: "PRODUCT_IMAGE_UNAVAILABLE" });
    assert.equal(probe.generate.length, 0);
  }
});

test("a provider safety block fails closed with one attempt and no retry", async () => {
  let calls = 0;
  const { run, probe } = build({
    generate: async () => {
      calls += 1;
      return { ok: false, reason: "SAFETY_BLOCKED" };
    },
  });
  assert.deepEqual(await run(), { ok: false, reason: "SAFETY_BLOCKED" });
  assert.equal(calls, 1);
  assert.deepEqual(
    probe.signals.map((signal) => signal.name),
    ["try_on.generation_started", "try_on.generation_failed", "try_on.safety_blocked"],
  );
});

test("upstream failure classes pass through as safe reasons and the service never throws", async () => {
  for (const reason of ["AUTH_FAILED", "BUSY", "TIMEOUT", "GENERATION_FAILED"] as const) {
    const { run } = build({ generate: async () => ({ ok: false, reason }) });
    assert.deepEqual(await run(), { ok: false, reason });
  }
  const throwing = build({
    generate: async () => {
      throw new Error("boom: secret upstream detail");
    },
  });
  assert.deepEqual(await throwing.run(), { ok: false, reason: "GENERATION_FAILED" });
});

test("a failing product lookup is UNAVAILABLE, not a thrown error", async () => {
  const { run } = build({
    loadProduct: async () => {
      throw new Error("database down");
    },
  });
  assert.deepEqual(await run(), { ok: false, reason: "UNAVAILABLE" });
});

test("the guest quota rejects before the body is read: one a minute, then wait", async () => {
  const limiter = createTryOnRateLimiter();
  const { run, probe } = build({ limiter });
  assert.equal((await run()).ok, true);
  assert.deepEqual(await run(), { ok: false, reason: "RATE_LIMITED" });
  assert.equal(probe.readForm, 1);
  assert.equal(probe.generate.length, 1);
  assert.equal(probe.signals.at(-1)?.name, "try_on.rate_limited");
  assert.equal(probe.signals.at(-1)?.reason, "RATE_LIMITED");
});

test("a guest out of attempts is told to log in, and nothing downstream runs", async () => {
  const limiter = createTryOnRateLimiter({ guest: { perMinute: 100, perDay: 1 }, member: OPEN.member });
  const { run, probe } = build({ limiter });
  assert.equal((await run()).ok, true);
  assert.deepEqual(await run(), { ok: false, reason: "LOGIN_REQUIRED" });
  assert.equal(probe.readForm, 1);
  assert.equal(probe.loadProduct.length, 1);
  assert.equal(probe.generate.length, 1);
  assert.equal(probe.signals.at(-1)?.name, "try_on.rate_limited");
  assert.equal(probe.signals.at(-1)?.reason, "LOGIN_REQUIRED");
});

test("a member is limited per minute and per day, never asked to log in", async () => {
  const limiter = createTryOnRateLimiter({ guest: OPEN.guest, member: { perMinute: 100, perDay: 1 } });
  const probe = { readForm: 0 };
  const service = createTryOnService({
    readConfig: () => CONFIG,
    limiter,
    loadProduct: async () => product(),
    fetchProductImage: async () => ({ ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }),
    generate: async () => ({ ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }),
    emit: () => undefined,
  });
  const input = {
    identity: { kind: "member", key: "member:user-1" } as const,
    readForm: async () => {
      probe.readForm += 1;
      return tryOnForm();
    },
  };
  assert.equal((await service.handle(input)).ok, true);
  assert.deepEqual(await service.handle(input), { ok: false, reason: "DAILY_LIMIT_REACHED" });
  assert.equal(probe.readForm, 1);
});

test("the global in-flight cap answers BUSY, and the slot is released after success and failure", async () => {
  const limiter = createTryOnRateLimiter({ maxConcurrent: 1, ...OPEN });
  const held = limiter.startGeneration();
  assert.equal(held.ok, true);

  const busy = build({ limiter });
  assert.deepEqual(await busy.run(), { ok: false, reason: "BUSY" });
  assert.equal(busy.probe.generate.length, 0);

  if (held.ok) held.release();
  assert.equal((await busy.run()).ok, true);
  const afterSuccess = limiter.startGeneration();
  assert.equal(afterSuccess.ok, true);
  if (afterSuccess.ok) afterSuccess.release();

  const failing = build({
    limiter,
    generate: async () => {
      throw new Error("boom");
    },
  });
  await failing.run();
  const afterFailure = limiter.startGeneration();
  assert.equal(afterFailure.ok, true);
});

test("signals are non-sensitive: no image bytes, no client key, and the slug is the resolved one", async () => {
  const { run, probe } = build();
  await run();
  const serialized = JSON.stringify(probe.signals);
  assert.doesNotMatch(serialized, /base64|bytes|v1:[0-9a-f]{64}|evil|bearer/i);
  assert.deepEqual(
    probe.signals.map((signal) => signal.name),
    ["try_on.generation_started", "try_on.generation_succeeded"],
  );
  const succeeded = probe.signals[1]!;
  assert.equal(succeeded.productSlug, "vay-hoa");
  assert.equal(typeof succeeded.latencyMs, "number");
  assert.equal(typeof succeeded.upstreamLatencyMs, "number");
});

test("an upload slot is taken before the body is read: saturated, the body is never read", async () => {
  const limiter = createTryOnRateLimiter({ maxConcurrentUploads: 1, ...OPEN });
  const held = limiter.startUpload();
  assert.equal(held.ok, true);

  const { run, probe } = build({ limiter });
  assert.deepEqual(await run(), { ok: false, reason: "BUSY" });
  assert.equal(probe.readForm, 0);
  assert.equal(probe.loadProduct.length, 0);
  assert.equal(probe.signals.at(-1)?.name, "try_on.rate_limited");
  assert.equal(probe.signals.at(-1)?.reason, "BUSY");

  if (held.ok) held.release();
  assert.equal((await run()).ok, true);
});

test("the upload slot is held for the whole body read, so concurrent uploads are bounded", async () => {
  const limiter = createTryOnRateLimiter({ maxConcurrentUploads: 1, ...OPEN });
  const service = createTryOnService({
    readConfig: () => CONFIG,
    limiter,
    loadProduct: async () => product(),
    fetchProductImage: async () => ({ ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }),
    generate: async () => ({ ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }),
    emit: () => undefined,
  });

  let openBody!: () => void;
  const bodyGate = new Promise<void>((resolve) => {
    openBody = resolve;
  });
  // A slow upload: the body arrives only when the gate opens.
  const slowUpload = service.handle({
    identity: GUEST,
    readForm: async () => {
      await bodyGate;
      return tryOnForm();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  let secondRead = 0;
  const refused = await service.handle({
    identity: { kind: "guest", key: "v1:" + "b".repeat(64) },
    readForm: async () => {
      secondRead += 1;
      return tryOnForm();
    },
  });
  assert.deepEqual(refused, { ok: false, reason: "BUSY" });
  assert.equal(secondRead, 0);

  openBody();
  assert.equal((await slowUpload).ok, true);
  // Finished, so the slot is free again.
  const after = await service.handle({
    identity: { kind: "guest", key: "v1:" + "c".repeat(64) },
    readForm: async () => tryOnForm(),
  });
  assert.equal(after.ok, true);
});

test("the upload slot is released after a failed read and before the product lookup and provider call", async () => {
  const limiter = createTryOnRateLimiter({ maxConcurrentUploads: 1, ...OPEN });

  const broken = createTryOnService({
    readConfig: () => CONFIG,
    limiter,
    loadProduct: async () => product(),
    fetchProductImage: async () => ({ ok: false, reason: "FETCH_FAILED" }),
    generate: async () => ({ ok: false, reason: "GENERATION_FAILED" }),
    emit: () => undefined,
  });
  const failed = await broken.handle({
    identity: GUEST,
    readForm: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(failed.ok, false);
  const afterFailure = limiter.startUpload();
  assert.equal(afterFailure.ok, true);
  if (afterFailure.ok) afterFailure.release();

  // Slow downstream work (product lookup, Vertex) must not keep an upload slot occupied.
  let uploadFreeDuringGenerate: boolean | undefined;
  const service = createTryOnService({
    readConfig: () => CONFIG,
    limiter,
    loadProduct: async () => product(),
    fetchProductImage: async () => ({ ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } }),
    generate: async () => {
      const slot = limiter.startUpload();
      uploadFreeDuringGenerate = slot.ok;
      if (slot.ok) slot.release();
      return { ok: true, image: { bytes: PNG_BYTES, mimeType: "image/png" } };
    },
    emit: () => undefined,
  });
  assert.equal((await service.handle({ identity: GUEST, readForm: async () => tryOnForm() })).ok, true);
  assert.equal(uploadFreeDuringGenerate, true);
});
