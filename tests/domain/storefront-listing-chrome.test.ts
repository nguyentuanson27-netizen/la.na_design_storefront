import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseStorefrontListingPage } from "../../src/commerce/storefront-discovery.ts";
import { buildCatalogListingMetadata } from "../../src/seo/catalog-listing-metadata.ts";
import { shouldNoIndexRequest } from "../../src/seo/search-exposure.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * One exported component's source, from its declaration to the next one. Matching to the first
 * `\n}` instead would stop inside the JSX, which is how an assertion about a component's markup
 * quietly starts reading none of it.
 */
function componentSource(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/**
 * The storefront's listing surfaces draw one set of chrome.
 *
 * Before this, the category PLP had a serif H1 under a breadcrumb while `/new-arrivals`, `/sale`,
 * `/shop` and `/collections` each opened with a 9rem bold sans heading and their own container,
 * empty state and pager. Master spec §9 asks for an elegant serif display; §25 describes one PLP.
 * What these tests pin is that the five routes go through `listing-chrome` rather than restating
 * it, because a copy is what drifts.
 */

const LISTING_PAGES = [
  "src/routes/category.tsx",
  "src/app/new-arrivals/page.tsx",
  "src/app/sale/page.tsx",
  "src/app/shop/page.tsx",
  "src/app/collections/page.tsx",
  "src/app/collections/[slug]/page.tsx",
] as const;

test("every listing surface takes its shell, breadcrumb and heading from the shared chrome", () => {
  for (const modulePath of LISTING_PAGES) {
    const source = read(modulePath);
    assert.match(
      source,
      /from "@\/components\/brand\/listing-chrome"/,
      `${modulePath} must use the shared listing chrome`,
    );
    for (const primitive of ["ListingShell", "ListingBreadcrumbs", "ListingHeader"]) {
      // The opening tag, not the import: importing a primitive and then hand-rolling the markup
      // beside it is exactly the drift these tests exist to catch.
      assert.ok(
        source.includes(`<${primitive}`),
        `${modulePath} must render ${primitive} rather than its own copy`,
      );
    }
  }
});

test("no listing surface keeps the oversized sans heading the shared header replaced", () => {
  for (const modulePath of LISTING_PAGES) {
    const source = read(modulePath);
    // The old pattern, exactly: a clamp()-sized bold/semibold display h1 in the page itself.
    assert.doesNotMatch(
      source,
      /<h1[^>]*clamp\(/,
      `${modulePath} must not size its own h1; the shared header owns the display type`,
    );
    assert.doesNotMatch(
      source,
      /<h1[^>]*font-semibold/,
      `${modulePath} must not ship a bold sans h1`,
    );
  }
});

test("the shared header is a normal-weight serif h1 under an eyebrow", () => {
  const chrome = read("src/components/brand/listing-chrome.tsx");
  const header = componentSource(chrome, "ListingHeader");
  assert.match(header, /className="eyebrow/, "the eyebrow sits above the heading");
  assert.match(header, /<h1[\s\S]*?font-serif/, "master spec §9: elegant serif display type");
  assert.match(header, /<h1[\s\S]*?font-normal/, "normal weight, not the old bold sans shout");
});

test("the shared product grid is 4 across on desktop and 2 on mobile", () => {
  const chrome = read("src/components/brand/listing-chrome.tsx");
  const grid = componentSource(chrome, "ListingProductGrid");
  // Master spec §18.
  assert.match(grid, /grid-cols-2/, "2 columns on mobile");
  assert.match(grid, /lg:grid-cols-4/, "4 products per row on desktop");
});

test("the shared chrome stays presentation: no query parsing or href building in it", () => {
  const chrome = read("src/components/brand/listing-chrome.tsx");
  for (const leak of [
    "buildCategoryDiscoveryHref",
    "categoryKey",
    "searchParams",
    "useRouter",
    "@/commerce/",
  ]) {
    assert.ok(
      !chrome.includes(leak),
      `listing-chrome must not reach for ${leak}: each route keeps its own query semantics`,
    );
  }
});

/**
 * Filled links state their label colour in unlayered CSS, not in a `text-*` utility.
 *
 * `globals.css` declares `a { color: inherit }` outside any layer, and Tailwind's utilities live in
 * `@layer utilities`, so the unlayered rule wins however specific the utility looks. A pill that
 * fills with ink on hover or when selected therefore rendered its label in that same ink -- 1:1
 * contrast, an invisible label -- which is what `.checkout-cta` already existed to avoid.
 */
test("filled listing links carry their label colour outside the utility layer", () => {
  const css = read("src/app/globals.css");

  assert.match(
    css,
    /\.listing-cta \{\s*color: var\(--paper\);\s*\}/,
    "the empty state's recovery button needs its label colour stated unlayered",
  );
  assert.match(
    css,
    /\.listing-pill:hover,\s*\.listing-pill\[aria-current="true"\] \{\s*color: var\(--paper\);\s*\}/,
    "a pill that fills on hover or when selected needs the same",
  );

  // The utility form is what silently stops working, so no listing may reach for it on a link.
  for (const modulePath of [
    "src/components/brand/listing-chrome.tsx",
    "src/routes/category.tsx",
    "src/app/collections/[slug]/page.tsx",
  ]) {
    const source = read(modulePath);
    assert.ok(
      !/(hover:)?text-\[#FAF7F2\]/.test(source),
      `${modulePath} must not colour a filled link with a text-* utility; use listing-cta/listing-pill`,
    );
  }
});

/**
 * Master spec §10: "`/new-arrivals`: keep; shows newest products automatically."
 *
 * The route used to seal an empty view model and render an editorial page, on the reasoning that a
 * listing there would be a second authority over `/shop`. These pin that it now reads products,
 * that it reads them from the recency authority rather than a hand-merchandised list, and that it
 * does not reach for a `new` status the catalog does not have.
 */
test("new-arrivals loads the newest products rather than sealing an empty view model", () => {
  const route = read("src/routes/new-arrivals.ts");

  assert.match(
    route,
    /listConfiguredNewestProductPage/,
    "the route must read the catalog's recency ordering",
  );
  assert.ok(
    !/NewArrivalsViewModel = Readonly<Record<string, never>>/.test(route),
    "the view model must carry products",
  );
  assert.match(route, /buildProductListTracking/, "a product listing reports its impressions");
  assert.match(
    route,
    /refreshAfterMs: catalogPage\.refreshAfterMs/,
    "promotion-priced cards need the promotion refresh window, not a flat cadence",
  );

  // Nothing invents marketing status or a merchandised order here.
  for (const invented of ["isNew", "featured", "handpicked", "curatedOrder"]) {
    assert.ok(!route.includes(invented), `new-arrivals must not invent ${invented}`);
  }
});

test("new-arrivals renders a real grid, a count and an empty state", () => {
  const page = read("src/app/new-arrivals/page.tsx");
  assert.match(page, /<ListingProductGrid/, "products render in the shared grid");
  assert.match(page, /<ProductCard/, "the grid holds product cards");
  assert.match(page, /<ListingEmptyState/, "an empty catalog still renders an honest page");
  assert.match(page, /<ListingPagination/, "§25: crawlable paging, not scroll-only discovery");
});

test("new-arrivals rejects a page parameter the catalog cannot answer", () => {
  assert.equal(parseStorefrontListingPage({}), 1, "no page parameter means the first page");
  assert.equal(parseStorefrontListingPage({ page: "3" }), 3);

  for (const bad of ["0", "-1", "1.5", "abc", " "]) {
    assert.throws(
      () => parseStorefrontListingPage({ page: bad }),
      RangeError,
      `page=${bad} must be rejected the same way every other listing rejects it`,
    );
  }
  assert.throws(() => parseStorefrontListingPage({ page: ["1", "2"] }), RangeError);
});

/**
 * A paginated listing's page 2 is a URL a crawler should reach.
 *
 * `/new-arrivals` used to be a static editorial page, so its metadata came from the static
 * authority -- which withholds a canonical and marks the request noindex the moment any query
 * appears. That is right for a page with no paginated form and wrong for this one now, and §25
 * says discovery must not depend solely on client-side scrolling. This pins that it moved to the
 * same authority `/shop`, `/sale` and a collection's page already use.
 */
test("new-arrivals pagination is canonical and indexable, like every other paged listing", () => {
  const ORIGIN = "https://shop.example.com";
  const canonicalOf = (searchParams: object) =>
    buildCatalogListingMetadata({
      origin: ORIGIN,
      indexingEnabled: true,
      pathname: "/new-arrivals",
      searchParams,
      title: "Hàng mới",
    }).alternates?.canonical ?? null;

  assert.equal(String(canonicalOf({})), `${ORIGIN}/new-arrivals`);
  assert.equal(String(canonicalOf({ page: "2" })), `${ORIGIN}/new-arrivals?page=2`);
  // Arbitrary query state is still not a URL worth nominating.
  assert.equal(canonicalOf({ utm_source: "test" }), null);

  assert.equal(
    shouldNoIndexRequest({ indexingEnabled: true, pathname: "/new-arrivals", search: "?page=2" }),
    false,
    "page 2 must be crawlable",
  );
  assert.equal(
    shouldNoIndexRequest({ indexingEnabled: true, pathname: "/new-arrivals", search: "?page=1" }),
    true,
    "page 1 duplicates the bare path, so it stays noindex like the other listings",
  );
  assert.equal(
    shouldNoIndexRequest({
      indexingEnabled: true,
      pathname: "/new-arrivals",
      search: "?utm_source=test",
    }),
    true,
  );

  // The metadata builder and the route agree about which authority owns this path.
  const metadata = read("src/routes/metadata/new-arrivals.ts");
  assert.match(metadata, /buildCatalogListingMetadata/);
  assert.ok(
    !metadata.includes("buildStaticPageMetadata"),
    "two canonical authorities over one path is how they start disagreeing",
  );
});

/**
 * `/sale` changed how it looks and nothing about what it selects. The business rule -- only
 * products with a real active promotion -- lives in the loader, and this is what notices if a
 * presentation change ever starts widening it.
 */
test("sale still selects only actively discounted products, through the same loader", () => {
  const route = read("src/routes/sale.ts");
  assert.match(route, /listConfiguredSalePage/, "the sale read is the sale authority");
  assert.match(
    route,
    /readConfiguredNextSaleBoundary/,
    "promotion freshness must survive the re-skin",
  );
  assert.match(
    route,
    /resolveStorefrontPromotionRefresh/,
    "the refresh window is derived from the next campaign boundary",
  );
  assert.match(route, /buildProductListTracking/, "sale tracking must survive the re-skin");

  const page = read("src/app/sale/page.tsx");
  assert.ok(
    !page.includes("listConfigured"),
    "the page is markup: it must not acquire a second product read",
  );
});

/** `/collections` is an index, not a PLP: §10 keeps it aggregate and forbids invented children. */
test("collections stays an aggregate index with an honest empty state", () => {
  const page = read("src/app/collections/page.tsx");
  assert.match(page, /<ListingEmptyState/, "no collections is an empty state, not a placeholder");
  assert.match(page, /data\.collections\.length > 0/, "the list is whatever the loader published");

  for (const leak of ["<ListingProductGrid", "<ProductCard", "<ListingPagination"]) {
    assert.ok(
      !page.includes(leak),
      `/collections must not grow a product listing: found ${leak}`,
    );
  }

  const route = read("src/routes/collections.ts");
  assert.match(route, /listPublished/, "only published collections are listed");
  assert.ok(
    !/placeholder|sample|demo|fake/i.test(page),
    "no placeholder collection may be rendered",
  );
});

/** The collection detail keeps its editorial half and its featured ordering. */
test("a collection page keeps its editorial content and featured ordering", () => {
  const page = read("src/app/collections/[slug]/page.tsx");
  for (const editorial of ["editorial.heroImage", "editorial.story", "editorial.gallery", "editorial.video"]) {
    assert.ok(page.includes(editorial), `the collection page must keep ${editorial}`);
  }
  assert.match(page, /data\.sortOptions/, "the collection's own sort links stay");
  assert.match(page, /data\.sizeOptions/, "the collection's own size filter stays");

  const route = read("src/routes/collection.ts");
  assert.match(route, /orderByFeaturedSlugs/, "featured ordering must survive the re-skin");
  assert.match(
    route,
    /buildCollectionBreadcrumbStructuredData/,
    "breadcrumb structured data must survive the re-skin",
  );
});

/** `/shop` keeps its own query semantics; only its chrome is shared. */
test("shop keeps its free-text query and collection facet, which the category panel has no notion of", () => {
  const page = read("src/app/shop/page.tsx");
  assert.match(page, /name="q"/, "the free-text search stays");
  assert.match(page, /name="collection"/, "the collection facet stays");
  assert.match(page, /method="get"/, "the form stays a crawlable GET over this route's parameters");
  assert.ok(
    !page.includes("PlpFilterPanel"),
    "the category filter panel builds hrefs from a taxonomy key /shop does not have",
  );
});
