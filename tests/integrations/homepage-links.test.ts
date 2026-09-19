import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const APP_DIRECTORY = fileURLToPath(new URL("../../src/app/", import.meta.url));
const HOMEPAGE_SOURCE = new URL("../../src/app/page.tsx", import.meta.url);
const NEXT_CONFIG_SOURCE = new URL("../../next.config.mjs", import.meta.url);
const STOREFRONT_SOURCES = [
  {
    name: "homepage",
    url: HOMEPAGE_SOURCE,
  },
  {
    name: "sale",
    url: new URL("../../src/app/sale/page.tsx", import.meta.url),
  },
  {
    name: "collections",
    url: new URL("../../src/app/collections/page.tsx", import.meta.url),
  },
  {
    name: "header",
    url: new URL("../../src/components/brand/site-header.tsx", import.meta.url),
  },
  {
    name: "footer",
    url: new URL("../../src/components/brand/site-footer.tsx", import.meta.url),
  },
] as const;
const INTERNAL_PATH_LITERAL = /(["'`])(\/(?!\/)[^"'`\s]*)\1/g;
// `/about` is deliberately absent. U2 forbade it when no About page existed and the homepage had
// no approved reason to link one; master spec §23 now specifies the homepage brand story linking to
// `/about`, and U33a built and published that route. The rest stay forbidden: `/faq` and
// `/shipping-returns` are still unimplemented support routes, and `/size-guide` is reachable from
// a product, not from the homepage.
const UNAPPROVED_SUPPORT_PATHS = new Set([
  "/faq",
  "/shipping-returns",
  "/size-guide",
]);
const LOCKED_IMG_SRC =
  "img-src 'self' blob: data: https://content.pancake.vn${facebookImgSrc};";
// img-src now interpolates the Meta pixel's beacon origin, so pinning the directive alone would
// no longer pin the hosts it admits. The expression that supplies that origin is locked too, which
// keeps the guarantee intact: no image origin reaches the policy without editing a locked constant.
const LOCKED_FACEBOOK_IMG_SRC =
  'const facebookImgSrc = hasFacebookPixel ? " https://www.facebook.com" : "";';
const LOCKED_REMOTE_PATTERNS = `remotePatterns: [
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
    ],`;

type RouteExists = (pathname: string) => Promise<boolean>;

async function routeExists(pathname: string): Promise<boolean> {
  const segments = pathname.split("/").filter(Boolean);
  const normalizedSegments = segments.map((segment) =>
    segment.startsWith("${") && segment.endsWith("}") ? "[slug]" : segment,
  );

  const routeDirectory = normalizedSegments.length === 0
    ? APP_DIRECTORY
    : join(APP_DIRECTORY, ...normalizedSegments);

  try {
    await access(join(routeDirectory, "page.tsx"));
    return true;
  } catch {
    return false;
  }
}

function findU2ForbiddenHomepageLinks(source: string): string[] {
  const forbidden = new Set<string>();

  for (const match of source.matchAll(INTERNAL_PATH_LITERAL)) {
    const href = match[2];
    const url = new URL(href, "https://storefront.invalid");
    if (url.searchParams.has("category") || UNAPPROVED_SUPPORT_PATHS.has(url.pathname)) {
      forbidden.add(href);
    }
  }

  return [...forbidden].sort();
}

async function findMissingInternalLinks(
  source: string,
  exists: RouteExists = routeExists,
): Promise<string[]> {
  const hrefs = new Set<string>();

  for (const match of source.matchAll(INTERNAL_PATH_LITERAL)) {
    hrefs.add(match[2]);
  }

  const missing: string[] = [];
  for (const href of hrefs) {
    const rawPathname = new URL(href, "https://storefront.invalid").pathname;
    const pathname = decodeURIComponent(rawPathname);
    if (!(await exists(pathname))) {
      missing.push(href);
    }
  }

  return missing;
}

test("shared storefront literal internal links resolve to implemented App Router pages", async () => {
  const missingBySource: Record<string, string[]> = {};

  for (const source of STOREFRONT_SOURCES) {
    const content = await readFile(source.url, "utf8");
    const missing = await findMissingInternalLinks(content);

    if (missing.length > 0) {
      missingBySource[source.name] = missing;
    }
  }

  assert.deepEqual(missingBySource, {});
});

test("U2 homepage link guard rejects inert category queries and unapproved support routes", async () => {
  const homepage = await readFile(HOMEPAGE_SOURCE, "utf8");
  assert.deepEqual(findU2ForbiddenHomepageLinks(homepage), []);

  const counterexample = `
    const inert = "/shop?category=shirts";
    const unapproved = "/faq";
    const allowed = "/track-order";
  `;
  assert.deepEqual(findU2ForbiddenHomepageLinks(counterexample), ["/faq", "/shop?category=shirts"]);
});

test("U2 leaves the reviewed Pancake image host and CSP img-src boundary byte-for-byte locked", async () => {
  const nextConfig = await readFile(NEXT_CONFIG_SOURCE, "utf8");
  const imgSrc = nextConfig.match(/img-src [^;]+;/)?.[0] ?? null;
  const remotePatterns = nextConfig.match(/remotePatterns: \[\n[\s\S]*?\n    \],/)?.[0] ?? null;

  assert.equal(imgSrc, LOCKED_IMG_SRC);
  assert.equal(remotePatterns, LOCKED_REMOTE_PATTERNS);
  assert.ok(
    nextConfig.includes(LOCKED_FACEBOOK_IMG_SRC),
    "the Meta beacon origin admitted by img-src must stay byte-for-byte as reviewed",
  );
});

test("storefront link guard detects a missing internal destination without treating query state as a route", async () => {
  const source = `
    const valid = "/shop?q=shirt";
    const broken = "/products/missing-product";
  `;

  const missing = await findMissingInternalLinks(
    source,
    async (pathname) => pathname === "/shop",
  );

  assert.deepEqual(missing, ["/products/missing-product"]);
});
