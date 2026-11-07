/**
 * Runtime availability for virtual try-on.
 *
 * Nano Banana 2.1 (gemini-nano-banana-2.1) is available on Vertex AI in the global location only.
 * Configuration is server-only and fail-closed so provider misconfiguration hides try-on rather
 * than breaking the PDP.
 */
export const TRY_ON_LOCATION = "global";
/** The model used unless the server operator overrides it with LA_TRY_ON_VERTEX_MODEL. */
export const TRY_ON_DEFAULT_MODEL = "gemini-nano-banana-2.1";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** A publisher model id is one path segment: lowercase letters, digits, dots and hyphens. */
const MODEL_PATTERN = /^[a-z][a-z0-9.-]{2,63}$/;
type TryOnEnvironment = Readonly<Record<string, string | undefined>>;

export type TryOnConfig =
  | Readonly<{ available: true; projectId: string; location: string }>
  | Readonly<{ available: false; reason: "DISABLED" | "NOT_CONFIGURED" }>;

/**
 * The Vertex model id: the default when `LA_TRY_ON_VERTEX_MODEL` is unset or empty, the override when
 * it is a well-formed id, and null otherwise. The id is spliced into the request URL path, so
 * anything that is not a plain model id is rejected rather than escaped.
 */
export function readTryOnModel(env: TryOnEnvironment = process.env): string | null {
  const model = env.LA_TRY_ON_VERTEX_MODEL;
  if (model === undefined || model === "") return TRY_ON_DEFAULT_MODEL;
  return MODEL_PATTERN.test(model) ? model : null;
}

export function readTryOnConfig(env: TryOnEnvironment = process.env): TryOnConfig {
  if (env.LA_TRY_ON_ENABLED !== "true") return { available: false, reason: "DISABLED" };

  const projectId = env.LA_TRY_ON_GCP_PROJECT_ID;
  const credentials = env.GOOGLE_APPLICATION_CREDENTIALS;
  const legacyLocation = env.LA_TRY_ON_GCP_LOCATION;

  if (
    projectId === undefined ||
    !PROJECT_ID_PATTERN.test(projectId) ||
    credentials === undefined ||
    credentials.trim().length === 0
  ) {
    return { available: false, reason: "NOT_CONFIGURED" };
  }

  // A malformed model override must not reach the request URL.
  if (readTryOnModel(env) === null) return { available: false, reason: "NOT_CONFIGURED" };

  // The previous model accepted regional locations. Fail closed if an old deployment still pins one.
  if (
    legacyLocation !== undefined &&
    legacyLocation.trim().length > 0 &&
    legacyLocation !== TRY_ON_LOCATION
  ) {
    return { available: false, reason: "NOT_CONFIGURED" };
  }

  return { available: true, projectId, location: TRY_ON_LOCATION };
}
