import type { Metadata } from "next";

type StaticPageMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
  pathname: string;
  searchParams: object;
  /**
   * A plain string inherits the root title template, which appends the brand name. `{ absolute }`
   * is for a title the owner approved whole -- the homepage's, which already names the brand and
   * would otherwise carry it twice.
   */
  title?: string | Readonly<{ absolute: string }>;
  description?: string;
}>;

/**
 * The static indexable pages the SEO/GEO audit names under W10, and only those.
 *
 * `/shop` and `/collections/<slug>` — with their pagination — belong to `buildCatalogListingMetadata`,
 * and product pages to `buildStorefrontProductMetadata`. Listing them here would make this a second
 * authority over canonicals those builders already own, which is how two answers to one question
 * start disagreeing.
 */
const SELF_CANONICAL_STATIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/collections",
  // F3a keeps New Arrivals as one editorial URL with no legitimate query-state variant.
  "/new-arrivals",
  // U33a evergreen pages. They are exactly the shape this builder was written for: one static path
  // each, no paginated form, and nothing a query string could legitimately vary.
  "/about",
  "/contact",
  // U33b policy pages, same shape.
  "/returns",
  "/shipping",
  // U33c size guide page.
  "/size-guide",
  // A7b policy hub, same shape: one static path, no paginated form, nothing a query could vary.
  "/policies",
]);

/**
 * Self-canonical for a static page, on the terms the existing search exposure contract already sets.
 *
 * Withheld in two cases, both deliberate:
 *
 * - **Indexing disabled.** A canonical nominates the URL a crawler should prefer, which says nothing
 *   useful about a page the same response tells it not to index. The rest of the storefront already
 *   withholds canonical under noindex, and ADR 0004 keeps the temporary production domain there.
 * - **Any query string.** `shouldNoIndexRequest` marks these paths noindex the moment a query
 *   appears, and `/shop` likewise withholds rather than canonicalising an arbitrary query URL to
 *   somewhere the visitor did not ask for. These pages have no paginated form to make an exception
 *   for, so the rule is simply: no query, or no canonical.
 *
 * The origin is the caller's — `readSearchExposure()` reads it from server configuration. This
 * builder has no other source for it, which is what keeps a request-controlled `Host` out of a
 * canonical URL.
 */
export function buildStaticPageMetadata({
  origin,
  indexingEnabled,
  pathname,
  searchParams,
  title,
  description,
}: StaticPageMetadataInput): Metadata {
  const metadata: Metadata = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };

  if (!indexingEnabled) return metadata;
  if (!SELF_CANONICAL_STATIC_PATHS.has(pathname)) return metadata;

  const hasQuery = Object.values(searchParams).some((value) => value !== undefined);
  if (hasQuery) return metadata;

  return {
    ...metadata,
    // The root is named as the bare origin rather than `origin + "/"`. They are the same URL, but
    // Next serialises the root canonical without the trailing slash, and a builder whose output
    // does not match what the page actually serves is a builder its own tests cannot describe.
    // `readStorefrontOrigin` already yields the origin in exactly this form.
    alternates: {
      canonical: pathname === "/" ? origin : new URL(pathname, origin).toString(),
    },
  };
}
