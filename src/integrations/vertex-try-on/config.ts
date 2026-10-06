/**
 * Runtime availability for virtual try-on.
 *
 * Nano Banana Pro (gemini-3-pro-image) is available on Vertex AI in the global location only.
 * Configuration is server-only and fail-closed so provider misconfiguration hides try-on rather
 * than breaking the PDP.
 */
export const TRY_ON_LOCATION = "global";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
type TryOnEnvironment = Readonly<Record<string, string | undefined>>;

export type TryOnConfig =
  | Readonly<{ available: true; projectId: string; location: string }>
  | Readonly<{ available: false; reason: "DISABLED" | "NOT_CONFIGURED" }>;

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
