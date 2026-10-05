/**
 * Runtime availability of virtual try-on (spec §4 "Runtime availability", §19 feature switch).
 *
 * Server-only and fail-closed: this never throws, because the PDP calls it on every render and a
 * misconfigured provider must hide the feature, not break the page. It reads no secret — the
 * credential itself is resolved by Google Application Default Credentials at call time, and this
 * only checks that one has been pointed at.
 *
 * Environment (server-only; none of these is `NEXT_PUBLIC_`):
 * - `LA_TRY_ON_ENABLED`        kill switch; only the exact value `true` enables the feature
 * - `LA_TRY_ON_GCP_PROJECT_ID` Google Cloud project that owns the Vertex AI quota
 * - `LA_TRY_ON_GCP_LOCATION`   optional, defaults to `asia-southeast1`
 * - `GOOGLE_APPLICATION_CREDENTIALS` standard ADC path to the runtime service-account credential
 */

export const DEFAULT_TRY_ON_LOCATION = "asia-southeast1";

/** Google Cloud project ids: 6-30 chars, lowercase letters, digits and hyphens, letter first. */
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** `asia-southeast1`, `us-central1`. Both values become part of a hostname, so keep them tight. */
const LOCATION_PATTERN = /^[a-z]+(?:-[a-z]+[0-9]+)?$/;

type TryOnEnvironment = Readonly<Record<string, string | undefined>>;

export type TryOnConfig =
  | Readonly<{ available: true; projectId: string; location: string }>
  | Readonly<{ available: false; reason: "DISABLED" | "NOT_CONFIGURED" }>;

export function readTryOnConfig(env: TryOnEnvironment = process.env): TryOnConfig {
  if (env.LA_TRY_ON_ENABLED !== "true") return { available: false, reason: "DISABLED" };

  const projectId = env.LA_TRY_ON_GCP_PROJECT_ID;
  const location = env.LA_TRY_ON_GCP_LOCATION ?? DEFAULT_TRY_ON_LOCATION;
  const credentials = env.GOOGLE_APPLICATION_CREDENTIALS;

  if (
    projectId === undefined ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    !LOCATION_PATTERN.test(location) ||
    credentials === undefined ||
    credentials.trim().length === 0
  ) {
    return { available: false, reason: "NOT_CONFIGURED" };
  }

  return { available: true, projectId, location };
}
