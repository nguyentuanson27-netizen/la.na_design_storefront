/**
 * Zalo Ads Pixel configuration.
 *
 * The Pixel ID is public account configuration, not a secret, but it is frozen at image-build time
 * for the same reason the Meta and ChatGPT Ads ids are: next.config.mjs opens the CSP from the same
 * value, and Next bakes that policy into the build. A runtime-only id would otherwise render a
 * loader the policy then blocks.
 *
 * Zalo's setup guide (https://ads.zalo.me/business/huong-dan-thiet-lap-zalo-ads-pixel/) hands the
 * id out inside a copy-paste snippet and does not publish a format for it, so only a bounded safe
 * token is accepted here rather than a guessed numeric width. A configured value that is malformed
 * throws, because tracking that silently does nothing is worse than a build that refuses to start.
 */

// next.config.mjs declares this in `env`, so Next replaces it with a literal at build time -- the
// same literal the Content-Security-Policy was assembled from.
const BUILD_TIME_PIXEL_ID = process.env.LA_BUILD_ZALO_ADS_PIXEL_ID;

// Kept identical to the check in next.config.mjs so the build and the request path agree.
const PIXEL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ZaloAdsEnvironment = Readonly<Record<string, string | undefined>>;

export type ZaloAdsPixelConfig = Readonly<{
  pixelId: string;
}>;

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
