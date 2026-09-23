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

const contentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}${facebookScriptSrc};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data: https://content.pancake.vn${facebookImgSrc};
  media-src 'self' https://content.pancake.vn;
  font-src 'self';
  connect-src 'self'${isDevelopment ? " ws: wss:" : ""}${facebookConnectSrc};
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
`
  .replace(/\s{2,}/g, " ")
  .trim();

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
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "content.pancake.vn",
        port: "",
        pathname: "/*/*/*/*/*.jpg",
      },
      {
        protocol: "https",
        hostname: "content.pancake.vn",
        port: "",
        pathname: "/*/*/*/*/*.png",
      },
      {
        protocol: "https",
        hostname: "content.pancake.vn",
        port: "",
        pathname: "/*/*/*/*/*.webp",
      },
    ],
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
