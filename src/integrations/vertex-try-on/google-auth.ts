import { GoogleAuth } from "google-auth-library";

/**
 * Server-side Application Default Credentials for Vertex AI.
 *
 * `GoogleAuth` resolves the runtime identity (`GOOGLE_APPLICATION_CREDENTIALS` on the VPS, the
 * metadata server on Google Cloud) and caches and refreshes the short-lived OAuth token itself. The
 * token is returned to the one caller that puts it in an `Authorization` header; it is never
 * stored, logged, or sent anywhere else. This module must only be imported from server code.
 */

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * The auth library's HTTP transport has no timeout by default. The caller's deadline already frees
 * its generation slot on time; this makes the abandoned token request give up and close its socket
 * instead of lingering.
 */
const AUTH_TRANSPORT_TIMEOUT_MS = 15_000;

let auth: GoogleAuth | undefined;

export async function getGoogleAccessToken(): Promise<string> {
  auth ??= new GoogleAuth({
    scopes: [CLOUD_PLATFORM_SCOPE],
    clientOptions: { transporterOptions: { timeout: AUTH_TRANSPORT_TIMEOUT_MS } },
  });
  const token = await auth.getAccessToken();
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Google access token unavailable");
  }
  return token;
}
