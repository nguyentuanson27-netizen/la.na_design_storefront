import { readFileSync } from "node:fs";

const isDevelopment = process.env.NODE_ENV === "development";

// The Meta pixel needs three holes in the policy: its loader script, the 1x1 beacons it writes as
// images, and the XHR it posts events with. They are opened only where a pixel is actually
// configured, so an environment without one keeps the closed policy rather than carrying an
// unused allowance for a third-party origin.
//
// Validated here, and identically to readMetaPixelConfig, so a malformed id fails the build. The
// layout reads the same value at request time and throws on the same input; without this check a
// bad id would build cleanly and then 500 every route, and nothing is prerendered that would have
// caught it earlier.
const configuredFacebookPixelId = process.env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID ?? "";
if (configuredFacebookPixelId.length > 0 && !/^[0-9]{15,16}$/.test(configuredFacebookPixelId)) {
  throw new Error(
    "NEXT_PUBLIC_FACEBOOK_PIXEL_ID must be the 15 or 16 digit pixel id from Events Manager",
  );
}
const hasFacebookPixel = configuredFacebookPixelId.length > 0;
const facebookScriptSrc = hasFacebookPixel ? " https://connect.facebook.net" : "";
const facebookImgSrc = hasFacebookPixel ? " https://www.facebook.com" : "";
const facebookConnectSrc = hasFacebookPixel
  ? " https://www.facebook.com https://connect.facebook.net"
  : "";

// ChatGPT Ads Measurement Pixel. Like Meta, this is a build input because the CSP is baked into
// the image. Pixel IDs are opaque account configuration, so validate only bounded token syntax
// documented by our integration rather than guessing a numeric width.
const configuredOpenAiAdsPixelId = process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID ?? "";
if (
  configuredOpenAiAdsPixelId.length > 0
  && !/^[A-Za-z0-9_-]{1,128}$/.test(configuredOpenAiAdsPixelId)
) {
  throw new Error(
    "NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID must be the bounded Pixel ID from Ads Manager",
  );
}
const hasOpenAiAdsPixel = configuredOpenAiAdsPixelId.length > 0;
const openAiAdsScriptSrc = hasOpenAiAdsPixel ? " https://bzrcdn.openai.com" : "";
const openAiAdsConnectSrc = hasOpenAiAdsPixel
  ? " https://bzr.openai.com https://bzrcdn.openai.com"
  : "";
const openAiAdsImgSrc = hasOpenAiAdsPixel ? " https://bzr.openai.com" : "";

// Zalo Ads Pixel. Same build-time contract as the two above, validated identically to
// readZaloAdsPixelConfig. Zalo publishes no id format, so only a bounded token is accepted.
//
// The official snippet (docs/integrations/zalo-ads-pixel.md) is one async tag loading
// https://s.zzcdn.me/ztr/ztracker.js. Zalo does not document where that tracker reports, so the
// origins below were read off the script itself (ztracker v1.2.0, 2026-10-03): every beacon --
// /tracklp page views and engagement, /ptrck/log conversions -- is a 1x1 image on
// log.adtimaserver.vn, and the account's conversion rules are fetched from the same origin
// (/ptrck/events). Its za.zdn.vn loader is dead code in the web build and stays closed.
const configuredZaloAdsPixelId = process.env.NEXT_PUBLIC_ZALO_ADS_PIXEL_ID ?? "";
if (
  configuredZaloAdsPixelId.length > 0
  && !/^[A-Za-z0-9_-]{1,128}$/.test(configuredZaloAdsPixelId)
) {
  throw new Error(
    "NEXT_PUBLIC_ZALO_ADS_PIXEL_ID must be the bounded Pixel ID from Zalo Ads (letters, digits, _ or -, at most 128)",
  );
}
const hasZaloAdsPixel = configuredZaloAdsPixelId.length > 0;
const zaloAdsScriptSrc = hasZaloAdsPixel ? " https://s.zzcdn.me" : "";
const zaloAdsImgSrc = hasZaloAdsPixel ? " https://log.adtimaserver.vn" : "";
const zaloAdsConnectSrc = hasZaloAdsPixel ? " https://log.adtimaserver.vn" : "";

// Pancake's website Chat Plugin (src/components/brand/pancake-chat.tsx), origins read off its
// installation script and a browser run of it: the script and its sounds from chat-plugin.pancake.vn,
// its API and websocket on pages.fm, avatars on content.pancake.vn (already allowed for catalog
// media), and the Roboto face it imports from Google Fonts. The widget only loads on the permanent
// production host, but Next bakes this policy into the build, so the allowance is unconditional.

// Google Tag Manager (GTM)
// An empty build arg is "unset", not a value: the Dockerfile always defines the public variable
// (default ""), so `??` alone would let it mask the server-side fallback. Both sources are trimmed,
// and two different non-empty ids are a deployment mistake that must fail the build.
const publicGtmContainerId = (process.env.NEXT_PUBLIC_GTM_CONTAINER_ID ?? "").trim();
const serverGtmContainerId = (process.env.LA_GTM_CONTAINER_ID ?? "").trim();
if (
  publicGtmContainerId.length > 0 &&
  serverGtmContainerId.length > 0 &&
  publicGtmContainerId !== serverGtmContainerId
) {
  throw new Error(
    "NEXT_PUBLIC_GTM_CONTAINER_ID and LA_GTM_CONTAINER_ID are both set and differ; configure one container id",
  );
}
const configuredGtmContainerId = publicGtmContainerId || serverGtmContainerId;
if (
  configuredGtmContainerId.length > 0 &&
  !/^GTM-[A-Z0-9]{4,10}$/.test(configuredGtmContainerId)
) {
  throw new Error(
    "NEXT_PUBLIC_GTM_CONTAINER_ID must be the GTM-XXXXXXX container id from Tag Manager",
  );
}
// The CSP opens Google origins only for the container recorded as reviewed (marketing spec §5.1–5.2),
// the same record the runtime loader obeys. `LA_TRACKING_MODE` is runtime-only, so it can narrow the
// loader further but cannot widen this policy.
const reviewedGtmVersion = JSON.parse(
  readFileSync(new URL("./src/tracking/reviewed-gtm-version.json", import.meta.url), "utf8"),
);
const hasGtm =
  configuredGtmContainerId.length > 0 &&
  reviewedGtmVersion.containerId === configuredGtmContainerId &&
  typeof reviewedGtmVersion.versionId === "string" &&
  reviewedGtmVersion.versionId.length > 0 &&
  typeof reviewedGtmVersion.exportPath === "string" &&
  reviewedGtmVersion.exportPath.length > 0 &&
  /^[0-9a-f]{64}$/.test(reviewedGtmVersion.exportSha256 ?? "") &&
  reviewedGtmVersion.approvedDestinations !== null &&
  typeof reviewedGtmVersion.approvedDestinations === "object";
// TikTok's origin is opened only when the reviewed record approves a TikTok pixel. The reviewed
// Custom HTML (TikTok Base) inserts `https://analytics.tiktok.com/i18n/pixel/events.js`, which needs
// `script-src`; `connect-src` alone does not let the browser load it. Further origins that script
// talks to are NOT added on a guess: they have to be observed in a real browser run (see the release
// gates in the pull request) and added here by name, never by wildcard.
const hasTikTok =
  hasGtm &&
  Array.isArray(reviewedGtmVersion.approvedDestinations.tiktokPixelIds) &&
  reviewedGtmVersion.approvedDestinations.tiktokPixelIds.length > 0;
const tiktokOrigin = hasTikTok ? " https://analytics.tiktok.com" : "";
const gtmScriptSrc = hasGtm ? ` https://www.googletagmanager.com${tiktokOrigin}` : "";
const gtmImgSrc = hasGtm ? " https://www.googletagmanager.com https://www.google-analytics.com" : "";
const gtmConnectSrc = hasGtm
  ? ` https://www.googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://stats.g.doubleclick.net https://region1.google-analytics.com${tiktokOrigin}`
  : "";
const gtmFrameSrc = hasGtm ? " https://www.googletagmanager.com" : "";

const pancakeChatScriptSrc = " https://chat-plugin.pancake.vn";
const pancakeChatStyleSrc = " https://fonts.googleapis.com";
const pancakeChatFontSrc = " https://fonts.gstatic.com";
const pancakeChatMediaSrc = " https://chat-plugin.pancake.vn";
const pancakeChatConnectSrc = " https://pages.fm wss://pages.fm";

const pancakeImageHostnames = [
  "content.pancake.vn",
  "statics.pancake.vn",
  "cdn.pancake.vn",
];
const pancakeImageExtensions = ["jpg", "jpeg", "png", "webp"];
const pancakeImagePathnames = pancakeImageExtensions.flatMap((extension) => [
  `/*/*/*/*/*.${extension}`,
  `/web-media-*/*/*/*/*/*.${extension}`,
  `/web-media-*/*/*/*/*/*/*.${extension}`,
]);
const pancakeImageRemotePatterns = pancakeImageHostnames.flatMap((hostname) =>
  pancakeImagePathnames.map((pathname) => ({
    protocol: "https",
    hostname,
    port: "",
    pathname,
  })),
);

const contentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}${pancakeChatScriptSrc}${facebookScriptSrc}${openAiAdsScriptSrc}${zaloAdsScriptSrc}${gtmScriptSrc};
  style-src 'self' 'unsafe-inline'${pancakeChatStyleSrc};
  img-src 'self' blob: data: https://content.pancake.vn https://statics.pancake.vn https://cdn.pancake.vn${facebookImgSrc}${openAiAdsImgSrc}${zaloAdsImgSrc}${gtmImgSrc};
  media-src 'self' https://content.pancake.vn${pancakeChatMediaSrc};
  font-src 'self'${pancakeChatFontSrc};
  connect-src 'self'${isDevelopment ? " ws: wss:" : ""}${pancakeChatConnectSrc}${facebookConnectSrc}${openAiAdsConnectSrc}${zaloAdsConnectSrc}${gtmConnectSrc};
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-src 'self'${gtmFrameSrc};
  frame-ancestors 'none';
  upgrade-insecure-requests;
`
  .replace(/\s{2,}/g, " ")
  .trim();

// The Zalo tracker reports the live URL with every beacon, so once loaded it must stop reporting if
// the app navigates to a URL carrying shopper input (src/integrations/zalo-ads/url-safety.ts). A
// third-party script cannot be unloaded, but a page can add a stricter CSP: the loader inserts this
// <meta> policy -- the header's img-src and connect-src minus the Zalo reporting origin -- and the
// browser blocks every Zalo beacon for the rest of that document. Derived from the header so the two
// cannot drift.
const zaloAdsQuarantinePolicy = hasZaloAdsPixel
  ? contentSecurityPolicy
    .split("; ")
    .filter((directive) => /^(img-src|connect-src) /.test(directive))
    .map((directive) => directive.replaceAll(" https://log.adtimaserver.vn", ""))
    .join("; ")
  : "";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Next 16 dev allows exactly one dev server per build directory, and enforces it with a lock file
  // under that directory. The browser suite spawns a dev server per spec file against this one
  // project, so without a per-spec directory they contend for a single lock -- and a server that
  // has to be SIGKILLed leaves the lock behind, which makes the *next* spec's server refuse to
  // start at all. Defaults to `.next`, so a build with this unset is exactly what it was.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Frozen into the bundle at build time, from the same value that assembled the policy above.
  // NEXT_PUBLIC_ alone is not enough: Next only inlines those keys when they exist at build, so an
  // id supplied only at runtime would still reach the server component and render a loader script
  // the baked policy then blocks. Declaring it here inlines it either way, including as "".
  env: {
    LA_BUILD_FACEBOOK_PIXEL_ID: configuredFacebookPixelId,
    LA_BUILD_OPENAI_ADS_PIXEL_ID: configuredOpenAiAdsPixelId,
    LA_BUILD_ZALO_ADS_PIXEL_ID: configuredZaloAdsPixelId,
    LA_BUILD_ZALO_ADS_QUARANTINE_CSP: zaloAdsQuarantinePolicy,
  },
  images: {
    // AVIF first: about a fifth smaller than WebP for the same photograph, which is most of what a
    // phone on 4G spends loading a listing. Browsers that do not advertise AVIF keep WebP. The
    // first request for each size encodes more slowly; the optimizer caches the result.
    formats: ["image/avif", "image/webp"],
    remotePatterns: pancakeImageRemotePatterns,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
