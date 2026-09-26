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
  // `ListingHeader` is `PageHeader` re-exported: the listings and every other page share one.
  assert.match(
    read("src/components/brand/listing-chrome.tsx"),
    /PageHeader as ListingHeader[\s\S]*from "\.\/page-chrome"/,
    "the listing header is the page header, not a second copy of it",
  );
  const chrome = read("src/components/brand/page-chrome.tsx");
  const header = componentSource(chrome, "PageHeader");
  assert.match(header, /className="eyebrow/, "the eyebrow sits above the heading");
  assert.match(header, /<h1[\s\S]*?font-display/, "master spec §9 (amended): the display face on the listing heading");
  assert.match(header, /<h1[\s\S]*?font-normal/, "normal weight, not the old bold sans shout");
});

test("the shared product grid is 4 across on desktop and 2 on mobile", () => {
  const chrome = read("src/components/brand/listing-chrome.tsx");
  const grid = componentSource(chrome, "ListingProductGrid");
  // Master spec §18.
  assert.match(grid, /grid-cols-2/, "2 columns on mobile");
  assert.match(grid, /lg:grid-cols-4/, "4 products per row on desktop");
});

test("storefront product card media and loading skeletons pin the 2:3 aspect ratio contract", () => {
  const brandCard = read("src/components/brand/product-card.tsx");
  const commerceCard = read("src/components/commerce/product-card.tsx");
  const searchOverlay = read("src/components/brand/search-overlay.tsx");
  const plpGrid = read("src/components/brand/plp-infinite-grid.tsx");
  const shopLoading = read("src/app/shop/loading.tsx");
  const css = read("src/app/globals.css");

  assert.match(brandCard, /aspect-\[2\/3\]/, "brand ProductCard must use 2:3 aspect ratio");
  assert.doesNotMatch(brandCard, /aspect-\[4\/5\]|aspect-\[3\/4\]/, "brand ProductCard must not revert to 4:5 or 3:4");

  assert.match(commerceCard, /aspect-\[2\/3\]/, "commerce ProductCard must use 2:3 aspect ratio");
  assert.match(searchOverlay, /aspect-\[2\/3\]/, "search overlay suggested product cards must use 2:3 aspect ratio");
  assert.match(plpGrid, /aspect-\[2\/3\]/, "PLP infinite grid skeleton must use 2:3 aspect ratio");
  assert.match(shopLoading, /aspect-\[2\/3\]/, "shop loading skeleton must use 2:3 aspect ratio");

  assert.match(css, /--media-product-ratio:\s*2\s*\/\s*3;/, "CSS token --media-product-ratio must be 2 / 3");
  assert.match(css, /\.product-visual\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*3;/, ".product-visual rule must define aspect-ratio: 2 / 3");
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
 * Links take their colour from Tailwind utilities, because the reset that makes them inherit is layered.
 *
 * `globals.css` used to declare `a { color: inherit }` outside any layer. Tailwind's utilities live
 * in `@layer utilities`, and an unlayered rule beats every layered one however specific, so
 * `text-[#FAF7F2]` on a selected filter chip and `hover:text-white` on a filled button silently
 * lost: the chip filled with ink and kept its label in that same ink. Individual pages patched it
 * with unlayered one-off classes; these pin the fix at its root instead.
 */
test("the link colour reset sits in the base layer so text utilities win on links", () => {
  const css = read("src/app/globals.css");

  assert.match(
    css,
    /@layer base \{[\s\S]*?\n  a \{\s*color: inherit;[\s\S]*?\n\}/,
    "`a { color: inherit }` must live inside `@layer base`",
  );
  // No unlayered copy of it at the top level, which would restore the bug.
  assert.doesNotMatch(css, /^a \{\s*color: inherit/m, "an unlayered `a` colour reset beats every text-* utility");
});

test("a selected PLP filter chip announces itself as well as filling", () => {
  const panel = read("src/components/brand/plp-filter-panel.tsx");
  // Desktop and sheet: sale, size and colour, each marked current when selected.
  assert.equal(
    (panel.match(/aria-current=\{(isSelected|isSaleActive) \? "true" : undefined\}/g) ?? []).length,
    6,
    "every selectable filter link must set aria-current when it is the active filter",
  );
});

/**
 * Every storefront page, not only the listings, opens with the same shell, breadcrumb and header.
 *
 * The account, cart, checkout, order-tracking, search and content pages each drew their own head:
 * a 9rem bold sans H1 on some, a 72px display H1 on others, over their own gutter and padding. The
 * login page looked like a different site from the category page it was reached from.
 */
const PAGE_HEAD_PAGES = [
  "src/app/login/page.tsx",
  "src/app/account/page.tsx",
  "src/app/search/page.tsx",
  "src/app/track-order/page.tsx",
  "src/app/cart/page.tsx",
  "src/app/cart/error.tsx",
  "src/app/checkout/page.tsx",
  "src/app/checkout/success/page.tsx",
  "src/app/shop/error.tsx",
  "src/app/feedback/page.tsx",
  "src/app/about/page.tsx",
  "src/app/contact/page.tsx",
  "src/app/policies/page.tsx",
  "src/app/shipping/page.tsx",
  "src/app/returns/page.tsx",
  "src/app/size-guide/page.tsx",
] as const;

test("every storefront page takes its shell, breadcrumb and heading from the shared page chrome", () => {
  for (const modulePath of PAGE_HEAD_PAGES) {
    const source = read(modulePath);
    assert.match(source, /from "@\/components\/brand\/page-chrome"/, `${modulePath} must use the page chrome`);
    for (const primitive of ["PageShell", "PageBreadcrumbs", "PageHeader"]) {
      assert.ok(source.includes(`<${primitive}`), `${modulePath} must render ${primitive}`);
    }
    assert.doesNotMatch(source, /<h1/, `${modulePath} must not draw its own h1 beside the shared one`);
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

/**
 * The fast-gate half of the same contract the runtime spec drives.
 *
 * The hero and the shared chrome arrived on separate branches that both rewrote this page's top.
 * A merge that resolves them by putting the hero back inside the container is a one-line change
 * that looks right in review and silently drops the header overlay, so the order is pinned here
 * too -- a browser is not needed to see which of the two comes first in the file.
 */
test("a collection hero stays the first full-bleed surface, above the shared listing chrome", () => {
  const page = read("src/app/collections/[slug]/page.tsx");

  // The class the stylesheet targets, not the bare attribute name: the comment above the hero
  // names the contract too, and matching that would let this pass wherever the hero ended up.
  // Matched by regex rather than an exact string so re-indenting the JSX does not read as a
  // regression.
  const heroIndex = page.search(/className="collection-page-hero"/);
  const shellIndex = page.search(/<ListingShell[\s>]/);
  assert.ok(heroIndex >= 0, "the hero must render as the full-bleed section");
  assert.ok(shellIndex >= 0, "the listing chrome must still be rendered");
  assert.match(
    page.slice(heroIndex, heroIndex + 400),
    /data-header-overlay-hero=""/,
    "the hero must declare the header overlay contract",
  );
  assert.ok(
    heroIndex < shellIndex,
    "the hero renders before the listing container, not inside it",
  );

  assert.match(
    page,
    /className="collection-page-hero"/,
    "the hero keeps the full-bleed class its stylesheet rule targets",
  );
  // The constrained block the hero used to be is what a naive merge restores.
  assert.doesNotMatch(
    page,
    /aspect-\[16\/9\][^]*?editorial\.heroImage|editorial\.heroImage[^]*?aspect-\[16\/9\]/,
    "the hero must not go back to a constrained 16:9 block inside the container",
  );
});

/** The collection detail keeps its editorial half and its featured ordering. */
test("a collection page keeps its editorial content and featured ordering", () => {
  const page = read("src/app/collections/[slug]/page.tsx");
  for (const editorial of ["editorial.heroImage", "editorial.gallery", "editorial.video"]) {
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

/** Master spec, "Sale display": the discount badge sits at the image's top-right. */
test("product card sale tags are anchored top-right, with the discount in the corner", () => {
  const css = read("src/app/globals.css");
  const stack = css.match(/\.product-tags\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(stack, /position:\s*absolute;/);
  assert.match(stack, /right:\s*0\.625rem;/);
  assert.match(stack, /justify-content:\s*flex-end;/, "tags pack against the right edge");

  const card = read("src/components/brand/product-card.tsx");
  const tags = card.slice(card.indexOf('className="product-tags"'));
  assert.ok(
    tags.indexOf("product-tag--flash") < tags.indexOf("marketingBadge.label"),
    "the discount renders last, so it is the tag in the corner",
  );
});
