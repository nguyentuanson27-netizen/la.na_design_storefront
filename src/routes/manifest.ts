/**
 * Where every storefront route lives, and where its metadata is declared.
 *
 * This is the declaration the verifiers check against; it is not derived from disk, because a
 * manifest derived from disk could never notice a page that went missing. The pairing is enforced
 * in both directions by `tests/domain/route-manifest.test.ts`.
 *
 * Admin (`/admin/**`) is not a storefront route and is deliberately absent: it does not change per
 * brand, so it is outside the redraw and outside the boundary contract (spec 04 §8).
 */

/**
 * Where the metadata for a route is declared. The three are mutually exclusive by construction, not
 * by convention: Next fails the build if one route segment exports both `metadata` and
 * `generateMetadata`.
 *
 * - `page`   — `page.tsx` exports `generateMetadata`.
 * - `static` — `page.tsx` exports a `metadata` const.
 * - `layout` — the sibling `layout.tsx` exports `generateMetadata`; `page.tsx` exports neither.
 */
export type MetadataMode = "page" | "static" | "layout";

export type StorefrontRouteEntry = Readonly<{
  /** Source path of the page module, relative to the repo root. */
  path: string;
  /**
   * Whether the route is required to render through `createStorefrontRoute`.
   *
   * Asserted against the repository since T32B: `route-manifest.test.ts` fails a declared route
   * that does not go through the factory, and `route-boundary.test.ts` runs the live boundary scan
   * over `src/app`. It was the target contract while the slices landed; it now describes the tree.
   */
  shell: boolean;
  metadata: MetadataMode;
  /** Only for `layout` mode: the module that actually exports `generateMetadata`. */
  metadataFile?: string;
}>;

export const STOREFRONT_ROUTES: readonly StorefrontRouteEntry[] = [
  { path: "src/app/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/shop/page.tsx", shell: true, metadata: "page" },
  {
    // PDP keeps metadata in the layout because it needs the product before it can build a title.
    // Not normalized to `page` for the sake of uniformity -- spec 04 §8 pins this deliberately.
    path: "src/app/shop/[slug]/page.tsx",
    shell: true,
    metadata: "layout",
    metadataFile: "src/app/shop/[slug]/layout.tsx",
  },
  { path: "src/app/collections/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/collections/[slug]/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/cach-tan/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/tet/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/cuoi/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/4-ta/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/ao-dai/6-ta/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/set-do/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/set-do/set-vay/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/set-do/set-quan-ao/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/vay-dam/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/phu-kien/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/sale/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/cart/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/checkout/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/checkout/success/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/about/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/contact/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/shipping/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/returns/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/size-guide/page.tsx", shell: true, metadata: "page" },
  { path: "src/app/track-order/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/search/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/account/page.tsx", shell: true, metadata: "static" },
  { path: "src/app/new-arrivals/page.tsx", shell: true, metadata: "static" },
];

/**
 * The URL a page module serves, by App Router convention.
 *
 * Route groups `(name)` and parallel/intercepting segments contribute no URL segment. None exist in
 * this tree today; they are handled rather than assumed absent, because a future route that used one
 * would otherwise get a silently wrong URL instead of an error.
 */
export function routeUrlFromPath(pagePath: string): string {
  // The leading slash is optional on purpose: the root route is `src/app/page.tsx`, which has no
  // segment before `page.tsx`, and requiring the slash left it deriving "/page.tsx".
  const withoutPrefix = pagePath.replace(/^src\/app\//, "").replace(/\/?page\.tsx$/, "");

  const segments = withoutPrefix
    .split("/")
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Every URL the manifest declares. */
export function storefrontRouteUrls(): readonly string[] {
  return STOREFRONT_ROUTES.map((route) => routeUrlFromPath(route.path));
}

/**
 * Whether a site-relative href addresses a declared route.
 *
 * A dynamic segment matches any single non-empty segment, so `/shop/ao-thun` matches
 * `/shop/[slug]`. Catch-all segments are not used in this tree and are not guessed at.
 */
export function matchesStorefrontRoute(href: string): boolean {
  const target = href.split(/[?#]/)[0] ?? href;
  const targetSegments = target.split("/").filter((segment) => segment.length > 0);

  return storefrontRouteUrls().some((url) => {
    const routeSegments = url.split("/").filter((segment) => segment.length > 0);
    if (routeSegments.length !== targetSegments.length) return false;
    return routeSegments.every((segment, index) => {
      if (/^\[.*\]$/.test(segment)) return (targetSegments[index] ?? "").length > 0;
      return segment === targetSegments[index];
    });
  });
}
