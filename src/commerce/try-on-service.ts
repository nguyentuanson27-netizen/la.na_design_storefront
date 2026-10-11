import type { TryOnSignalInput } from "../operations/try-on-observability.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import type { TryOnOverflowGate } from "./try-on-overflow.ts";
import type { AvailableTryOnRuntimeConfig, TryOnRuntimeConfig } from "./try-on-provider.ts";
import { resolveTryOnEligibility } from "./try-on-eligibility.ts";
import type {
  TryOnAttemptDecision,
  TryOnGenerationSlot,
  TryOnIdentity,
  TryOnUploadSlot,
} from "./try-on-rate-limit.ts";
import { parseTryOnRequest } from "./try-on-request.ts";
import type { TryOnFailureReason, TryOnImageMimeType } from "./try-on-policy.ts";

/**
 * One virtual try-on generation, start to finish (spec §7).
 *
 * This is the only place that sequences the gates, and the order is the safety argument:
 *
 *   feature switch → per-identity attempt (guest or member quota) → upload slot → read body → validate request (likeness, age,
 *   photo) → release upload slot → re-resolve product from the server → eligibility → generation
 *   slot → trusted product image → configured provider (once, except the Flow model fallback owned by its worker) → validated result
 *
 * With a Vertex overflow behind Flow, the generation slot step also picks the provider: Flow's slot
 * when it is free and Flow is not marked down, otherwise an overflow slot, otherwise BUSY. The choice
 * is made before anything is sent and never revisited, so one request reaches one provider: a Flow
 * failure is never retried on Vertex (a Flow timeout may still finish and spend; a safety refusal
 * must stay final). What Flow does with the requests it gets feeds its health in the gate.
 *
 * Every step that can reject runs before the next costlier one, and nothing before the last step can
 * reach the provider. The service is I/O-free: product lookup, the image fetch, the provider call, the
 * limiter and telemetry are all injected, so the whole contract is pinned by tests with no network
 * and no database. It takes no commerce dependency at all — it cannot touch a cart, a variant or an
 * order — and it never throws: a failure is a `{ ok: false, reason }` the shopper can be told about.
 *
 * Nothing here writes an image anywhere. Buffers live in this call frame and are released with it.
 */

type Image = Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }>;


export type TryOnServiceDependencies = Readonly<{
  readConfig: () => TryOnRuntimeConfig;
  limiter: Readonly<{
    consumeAttempt: (identity: TryOnIdentity) => TryOnAttemptDecision;
    startUpload: () => TryOnUploadSlot;
    startGeneration: () => TryOnGenerationSlot;
  }>;
  /** The Vertex overflow's gate, used only when the config carries an overflow. */
  overflowGate?: TryOnOverflowGate;
  /** Re-resolves the product from the server's own data. `null` when the slug is not a live product. */
  loadProduct: (slug: string) => Promise<Readonly<{
    slug: string;
    categoryKeys: readonly string[];
    media: StorefrontProductMedia;
  }> | null>;
  fetchProductImage: (
    trustedUrl: string,
  ) => Promise<
    Readonly<{ ok: true; image: Image }> | Readonly<{ ok: false; reason: "UNTRUSTED_URL" | "TOO_LARGE" | "FETCH_FAILED" }>
  >;
  generate: (input: Readonly<{ config: AvailableTryOnRuntimeConfig; person: Image; product: Image }>) => Promise<
    | Readonly<{ ok: true; image: Image }>
    | Readonly<{ ok: false; reason: "SAFETY_BLOCKED" | "AUTH_FAILED" | "BUSY" | "TIMEOUT" | "GENERATION_FAILED" }>
  >;
  emit: (signal: TryOnSignalInput) => void;
  now?: () => number;
}>;

export type TryOnServiceResult =
  | Readonly<{ ok: true; image: Image }>
  | Readonly<{ ok: false; reason: TryOnFailureReason }>;

export type TryOnServiceInput = Readonly<{
  /** A signed-in member (account id) or a guest (pseudonymous client key, never a raw IP). */
  identity: TryOnIdentity;
  /** Reads the request body. Not called when the request is refused earlier. */
  readForm: () => Promise<FormData | "TOO_LARGE" | "INVALID">;
}>;

export function createTryOnService(deps: TryOnServiceDependencies) {
  const now = deps.now ?? Date.now;

  /**
   * Picks the provider and takes its slot, or emits BUSY and returns `null`. Flow first unless it is
   * marked down; the overflow only when Flow cannot take the request. Never both.
   */
  function acquireGeneration(
    config: AvailableTryOnRuntimeConfig,
    productSlug: string,
  ): Readonly<{ provider: AvailableTryOnRuntimeConfig; release: () => void }> | null {
    const overflow = config.provider === "flow" ? config.overflow : undefined;
    const gate = overflow === undefined ? undefined : deps.overflowGate;

    const primaryDown = gate?.primaryDown() ?? false;
    if (!primaryDown) {
      const slot = deps.limiter.startGeneration();
      if (slot.ok) return { provider: config, release: slot.release };
    }
    if (gate === undefined || overflow === undefined) {
      deps.emit({ name: "try_on.rate_limited", reason: "BUSY", productSlug });
      return null;
    }

    const slot = gate.startOverflow();
    if (!slot.ok) {
      deps.emit({ name: "try_on.rate_limited", reason: "BUSY", productSlug, cause: slot.cause });
      return null;
    }
    deps.emit({
      name: "try_on.overflow_routed",
      productSlug,
      provider: "vertex",
      cause: primaryDown ? "primary_down" : "primary_busy",
    });
    return { provider: overflow.vertex, release: slot.release };
  }

  function notePrimary(
    gate: TryOnOverflowGate | undefined,
    outcome: Parameters<TryOnOverflowGate["notePrimaryOutcome"]>[0],
  ) {
    const down = gate?.notePrimaryOutcome(outcome);
    if (down) deps.emit({ name: "try_on.primary_marked_down", provider: "flow", cause: down.cause });
  }

  async function handle({ identity, readForm }: TryOnServiceInput): Promise<TryOnServiceResult> {
    const startedAt = now();
    let productSlug: string | undefined;
    let releaseSlot: (() => void) | undefined;
    // Set when the request went to Flow with an overflow behind it, so its outcome is reported.
    let reportPrimary: TryOnOverflowGate | undefined;

    const fail = (reason: TryOnFailureReason): TryOnServiceResult => {
      deps.emit({ name: "try_on.generation_failed", reason, latencyMs: now() - startedAt, productSlug });
      return { ok: false, reason };
    };

    try {
      const config = deps.readConfig();
      if (!config.available) return { ok: false, reason: "UNAVAILABLE" };

      const attempt = deps.limiter.consumeAttempt(identity);
      if (!attempt.ok) {
        deps.emit({ name: "try_on.rate_limited", reason: attempt.reason });
        return { ok: false, reason: attempt.reason };
      }

      // The upload slot spans receiving and validating the body and nothing after it: that is the
      // phase whose memory and CPU an untrusted upload costs, and holding it through the slower
      // product lookup and provider call would let those starve new uploads.
      const upload = deps.limiter.startUpload();
      if (!upload.ok) {
        deps.emit({ name: "try_on.rate_limited", reason: "BUSY" });
        return { ok: false, reason: "BUSY" };
      }
      let request: Awaited<ReturnType<typeof parseTryOnRequest>>;
      try {
        const form = await readForm();
        if (form === "TOO_LARGE") return fail("IMAGE_TOO_LARGE");
        if (form === "INVALID") return fail("INVALID_REQUEST");
        request = await parseTryOnRequest(form);
      } finally {
        upload.release();
      }
      if (!request.ok) return fail(request.reason);

      const product = await deps.loadProduct(request.value.productSlug);
      if (product === null) return fail("NOT_ELIGIBLE");
      // From here the slug is the server's own, so it is safe to put in telemetry.
      productSlug = product.slug;

      const eligibility = resolveTryOnEligibility({
        categoryKeys: product.categoryKeys,
        media: product.media,
      });
      if (!eligibility.eligible) return fail("NOT_ELIGIBLE");

      const route = acquireGeneration(config, productSlug);
      if (route === null) return { ok: false, reason: "BUSY" };
      releaseSlot = route.release;
      const provider = route.provider;
      const primaryGate =
        provider.provider === "flow" && config.provider === "flow" && config.overflow !== undefined
          ? deps.overflowGate
          : undefined;

      // The exact first trusted image, resolved above from the server's own media authority.
      const garment = await deps.fetchProductImage(eligibility.productImage.url);
      if (!garment.ok) return fail("PRODUCT_IMAGE_UNAVAILABLE");

      deps.emit({ name: "try_on.generation_started", productSlug, provider: provider.provider });
      const upstreamStartedAt = now();
      // From here a throw is the provider's failure, which Flow's health has to hear about.
      reportPrimary = primaryGate;
      const generated = await deps.generate({
        config: provider,
        person: request.value.photo,
        product: garment.image,
      });
      const upstreamLatencyMs = now() - upstreamStartedAt;
      notePrimary(reportPrimary, generated.ok ? { ok: true } : { ok: false, reason: generated.reason });
      reportPrimary = undefined;

      if (!generated.ok) {
        deps.emit({
          name: "try_on.generation_failed",
          reason: generated.reason,
          latencyMs: now() - startedAt,
          upstreamLatencyMs,
          productSlug,
          provider: provider.provider,
        });
        if (generated.reason === "SAFETY_BLOCKED") {
          deps.emit({ name: "try_on.safety_blocked", reason: "SAFETY_BLOCKED", productSlug });
        }
        return { ok: false, reason: generated.reason };
      }

      deps.emit({
        name: "try_on.generation_succeeded",
        latencyMs: now() - startedAt,
        upstreamLatencyMs,
        productSlug,
        provider: provider.provider,
      });
      return { ok: true, image: generated.image };
    } catch {
      // Includes a failing product lookup and a provider adapter that threw. The shopper gets a
      // class, never the error: an exception message could carry upstream detail.
      notePrimary(reportPrimary, { ok: false, reason: "GENERATION_FAILED" });
      return releaseSlot === undefined ? fail("UNAVAILABLE") : fail("GENERATION_FAILED");
    } finally {
      releaseSlot?.();
    }
  }

  return { handle };
}
