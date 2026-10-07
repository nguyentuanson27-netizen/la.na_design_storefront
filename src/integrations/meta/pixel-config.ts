/**
 * Meta pixel and Conversions API configuration.
 *
 * Both halves are optional and independent: with no pixel id the storefront ships no tracking at
 * all, and the browser pixel can run without the server-side Conversions API. A configured value
 * that is malformed throws rather than being ignored, because tracking that silently does nothing
 * is worse than a deployment that refuses to start.
 *
 * The pixel id is deliberately a NEXT_PUBLIC_ value. next.config.mjs assembles the
 * Content-Security-Policy from it, and Next bakes that policy into the build, so a pixel id
 * supplied only at runtime would render a script the policy then blocks — tracking that looks
 * installed and silently reports nothing. Reading the build-time inlined constant makes the two
 * agree by construction: set at build, both on; absent at build, both off.
 */

// next.config.mjs declares this in `env`, so Next replaces it with a literal at build time — the
// same literal the Content-Security-Policy was assembled from. Reading the raw
// NEXT_PUBLIC_FACEBOOK_PIXEL_ID here instead would fall through to the live runtime environment
// whenever it was absent at build, which is exactly the mismatch this exists to prevent.
const BUILD_TIME_PIXEL_ID = process.env.LA_BUILD_FACEBOOK_PIXEL_ID;

const PIXEL_ID = /^[0-9]{15,16}$/;
const GRAPH_API_VERSION = /^v[0-9]{1,3}\.[0-9]{1,3}$/;
const TEST_EVENT_CODE = /^TEST[0-9]{1,20}$/;

// Pinned so a Graph API release cannot change the payload contract underneath a running deploy.
// Override with FACEBOOK_GRAPH_API_VERSION and confirm against Events Manager before moving it.
// Meta's official Node Business SDK 26.0.2 pins v26.0 (verified 2026-10-07).
export const DEFAULT_GRAPH_API_VERSION = "v26.0";

export type MetaEnvironment = Readonly<Record<string, string | undefined>>;

export type MetaPixelConfig = Readonly<{
  pixelId: string;
}>;

export type MetaConversionsConfig = Readonly<{
  pixelId: string;
  accessToken: string;
  graphApiVersion: string;
  testEventCode: string | null;
}>;

function readOptionalValue(env: MetaEnvironment, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  if (value !== value.trim()) {
    throw new RangeError(`${name} must not carry leading or trailing whitespace`);
  }
  if (value.length === 0) return null;
  return value;
}

/**
 * The live server environment with the pixel id forced to its build-time value — including when
 * that is absent, so a runtime-only id turns tracking off rather than half on.
 */
function defaultEnvironment(): MetaEnvironment {
  return { ...process.env, NEXT_PUBLIC_FACEBOOK_PIXEL_ID: BUILD_TIME_PIXEL_ID };
}

export function readMetaPixelConfig(
  env: MetaEnvironment = defaultEnvironment(),
): MetaPixelConfig | null {
  const pixelId = readOptionalValue(env, "NEXT_PUBLIC_FACEBOOK_PIXEL_ID");
  if (pixelId === null) return null;
  if (!PIXEL_ID.test(pixelId)) {
    throw new RangeError("NEXT_PUBLIC_FACEBOOK_PIXEL_ID must be the 15 or 16 digit pixel id from Events Manager");
  }
  return Object.freeze({ pixelId });
}

/**
 * The Conversions API needs the browser pixel's id too — both halves report to the same pixel, and
 * that shared id is what lets Meta deduplicate a server event against its browser twin.
 */
export function readMetaConversionsConfig(
  env: MetaEnvironment = defaultEnvironment(),
): MetaConversionsConfig | null {
  const pixel = readMetaPixelConfig(env);
  const accessToken = readOptionalValue(env, "FACEBOOK_CAPI_ACCESS_TOKEN");
  if (pixel === null || accessToken === null) return null;

  const graphApiVersion = readOptionalValue(env, "FACEBOOK_GRAPH_API_VERSION") ?? DEFAULT_GRAPH_API_VERSION;
  if (!GRAPH_API_VERSION.test(graphApiVersion)) {
    throw new RangeError("FACEBOOK_GRAPH_API_VERSION must look like v26.0");
  }

  const testEventCode = readOptionalValue(env, "FACEBOOK_CAPI_TEST_EVENT_CODE");
  if (testEventCode !== null && !TEST_EVENT_CODE.test(testEventCode)) {
    throw new RangeError("FACEBOOK_CAPI_TEST_EVENT_CODE must look like TEST12345");
  }

  return Object.freeze({
    pixelId: pixel.pixelId,
    accessToken,
    graphApiVersion,
    testEventCode,
  });
}
