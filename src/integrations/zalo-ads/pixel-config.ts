/**
 * Zalo Ads Pixel configuration.
 *
 * The Pixel ID is public account configuration, not a secret, but it is frozen at image-build time
 * for the same reason the Meta and ChatGPT Ads ids are: next.config.mjs opens the CSP from the same
 * value, and Next bakes that policy into the build. A runtime-only id would otherwise render a
 * loader the policy then blocks.
 *
 * Contract source: Zalo Ads, "Thiết lập Zalo Ads Pixel" -> "Hướng dẫn lấy mã pixel"
 * (https://ads.zalo.me/business/huong-dan-thiet-lap-zalo-ads-pixel/, reviewed 2026-10-03). The
 * manual installation is exactly one tag pasted into <head>:
 *
 *   <script async="" src="https://s.zzcdn.me/ztr/ztracker.js?id=<PIXEL_ID>"></script>
 *
 * The guide documents no JavaScript API -- no page-view call, no event call, no event id --
 * conversions are defined in the Zalo Ads dashboard as button-id or URL-keyword rules. The guide's
 * example ids are 19 digits, but it publishes no format, so only a bounded safe token is accepted
 * rather than a guessed numeric width. A configured value that is malformed throws, because
 * tracking that silently does nothing is worse than a build that refuses to start.
 */

// next.config.mjs declares this in `env`, so Next replaces it with a literal at build time -- the
// same literal the Content-Security-Policy was assembled from.
const BUILD_TIME_PIXEL_ID = process.env.LA_BUILD_ZALO_ADS_PIXEL_ID;

// Kept identical to the check in next.config.mjs so the build and the request path agree.
const PIXEL_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The CSP fragment (img-src + connect-src without Zalo's reporting origin) the loader adds as a
// <meta> policy when the app navigates to a location the tracker must not observe. next.config.mjs
// derives it from the header policy, so the two cannot drift.
const BUILD_TIME_QUARANTINE_POLICY = process.env.LA_BUILD_ZALO_ADS_QUARANTINE_CSP;

/** The loader's origin, from the official snippet. next.config.mjs opens script-src to it. */
export const ZALO_ADS_PIXEL_SCRIPT_ORIGIN = "https://s.zzcdn.me";

export type ZaloAdsEnvironment = Readonly<Record<string, string | undefined>>;

export type ZaloAdsPixelConfig = Readonly<{
  pixelId: string;
}>;

/**
 * The build-time quarantine policy, or null when there is none -- in which case the loader must not
 * run, because it could not stop the tracker once the shopper reaches a sensitive URL.
 */
export function readZaloAdsQuarantinePolicy(
  value: string | undefined = BUILD_TIME_QUARANTINE_POLICY,
): string | null {
  if (value === undefined || value.length === 0) return null;
  return value;
}

/**
 * The live server environment with the pixel id forced to its build-time value -- including when
 * that is absent, so a runtime-only id turns the integration off rather than half on.
 */
function defaultEnvironment(): ZaloAdsEnvironment {
  return { ...process.env, NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: BUILD_TIME_PIXEL_ID };
}

export function readZaloAdsPixelConfig(
  env: ZaloAdsEnvironment = defaultEnvironment(),
): ZaloAdsPixelConfig | null {
  const value = env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID;
  if (value === undefined) return null;
  // Whitespace is a paste accident, not an id: silently trimming it hides a broken deploy config.
  if (value !== value.trim()) {
    throw new RangeError("NEXT_PUBLIC_ZALO_ADS_PIXEL_ID must not carry leading or trailing whitespace");
  }
  if (value.length === 0) return null;
  if (!PIXEL_ID.test(value)) {
    throw new RangeError(
      "NEXT_PUBLIC_ZALO_ADS_PIXEL_ID must be the bounded Pixel ID from Zalo Ads (letters, digits, _ or -, at most 128)",
    );
  }
  return Object.freeze({ pixelId: value });
}

/** The official snippet's `src`, with the configured id as its only parameter. */
export function buildZaloAdsPixelScriptSrc(config: ZaloAdsPixelConfig): string {
  return `${ZALO_ADS_PIXEL_SCRIPT_ORIGIN}/ztr/ztracker.js?id=${encodeURIComponent(config.pixelId)}`;
}
