/**
 * The virtual try-on policy constants shared by the browser and the server.
 *
 * Nothing here is a secret or a decision the client may override: the server re-checks every one of
 * these before it contacts Vertex AI (`try-on-request.ts`). The client imports them only so its
 * copy and its convenience validation cannot drift from the enforcement.
 *
 * Spec: `docs/specs/storefront-virtual-try-on.md` §6, §9, §10.
 */

/** Vertex AI accepts at most 7 MB per image. The shopper upload and the product image share it. */
export const TRY_ON_MAX_IMAGE_BYTES = 7 * 1024 * 1024;

export const TRY_ON_ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export type TryOnImageMimeType = (typeof TRY_ON_ALLOWED_IMAGE_MIME_TYPES)[number];

/** The likeness-rights representation the shopper confirms before every generation (spec §6). */
export const TRY_ON_LIKENESS_ACKNOWLEDGEMENT =
  "Tôi xác nhận đây là ảnh của tôi hoặc tôi có sự đồng ý rõ ràng và các quyền cần thiết để sử dụng hình ảnh của người trong ảnh cho tính năng thử đồ này.";

/**
 * The one age state a request carries (spec §10). Self-attestation only: no geolocation, document
 * or identity verification.
 */
export const TRY_ON_AGE_ADULT = "adult";
export const TRY_ON_AGE_TEEN_WITH_GUARDIAN = "teen_eligible_with_guardian";
export const TRY_ON_AGE_BELOW_CONSENT_AGE = "below_digital_consent_age";

export const TRY_ON_AGE_STATES = [
  TRY_ON_AGE_ADULT,
  TRY_ON_AGE_TEEN_WITH_GUARDIAN,
  TRY_ON_AGE_BELOW_CONSENT_AGE,
] as const;
export type TryOnAgeState = (typeof TRY_ON_AGE_STATES)[number];

/** The age states that may reach the provider. `below_digital_consent_age` never does. */
export const TRY_ON_ALLOWED_AGE_STATES: readonly TryOnAgeState[] = [
  TRY_ON_AGE_ADULT,
  TRY_ON_AGE_TEEN_WITH_GUARDIAN,
];

export function parseTryOnAgeState(value: unknown): TryOnAgeState | null {
  return TRY_ON_AGE_STATES.find((state) => state === value) ?? null;
}

/**
 * Every reason the try-on endpoint can answer with. The browser maps these to Vietnamese copy; the
 * server logs the same class and nothing more specific.
 */
/**
 * The per-identity attempt allowances (owner decision of 2026-10-04, spec §21). They live here so the
 * limiter that enforces them and the copy that tells a shopper about them cannot drift apart.
 */
export const TRY_ON_GUEST_QUOTA = Object.freeze({ perMinute: 1, perDay: 5 });
export const TRY_ON_MEMBER_QUOTA = Object.freeze({ perMinute: 2, perDay: 10 });

export const TRY_ON_FAILURE_REASONS = [
  "UNAVAILABLE",
  "INVALID_REQUEST",
  "LIKENESS_REQUIRED",
  "AGE_STATE_INVALID",
  "AGE_BLOCKED",
  "UNSUPPORTED_IMAGE",
  "IMAGE_TOO_LARGE",
  "NOT_ELIGIBLE",
  "PRODUCT_IMAGE_UNAVAILABLE",
  "RATE_LIMITED",
  "BUSY",
  "SAFETY_BLOCKED",
  "AUTH_FAILED",
  "TIMEOUT",
  "GENERATION_FAILED",
  /** A guest has used its allowance; signing in continues it. */
  "LOGIN_REQUIRED",
  /** A signed-in member has used today's allowance. */
  "DAILY_LIMIT_REACHED",
] as const;
export type TryOnFailureReason = (typeof TRY_ON_FAILURE_REASONS)[number];
