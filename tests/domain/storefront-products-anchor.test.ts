import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STOREFRONT_PRODUCTS_ANCHOR,
  STOREFRONT_PRODUCTS_ALIAS_ANCHOR,
  resolveStorefrontAnchor,
  storefrontQueryAnchor,
  storefrontScrollBehavior,
} from "../../src/routes/storefront-anchors.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("storefront products anchor constants define canonical Vietnamese and English fragment identifiers", () => {
  assert.equal(STOREFRONT_PRODUCTS_ANCHOR, "san-pham");
  assert.equal(STOREFRONT_PRODUCTS_ALIAS_ANCHOR, "products");
});

test("shared ListingProductGrid carries canonical #san-pham id, #products alias, and scroll margin offset", () => {
  const chrome = read("src/components/brand/listing-view.tsx");
  assert.match(chrome, /id\s*=\s*STOREFRONT_PRODUCTS_ANCHOR/, "grid defaults to #san-pham anchor");
  assert.match(chrome, /id=\{STOREFRONT_PRODUCTS_ALIAS_ANCHOR\}/, "grid carries #products alias span");
  assert.match(chrome, /collection-products-anchor/, "grid carries masthead-clearing scroll margin class");
  assert.match(chrome, /data-products-anchor/, "grid marks data-products-anchor for telemetry/styling");
});

test("category PLP routes expose #san-pham on grid and empty state, and #bo-loc on filters", () => {
  const categoryRoute = read("src/routes/category.tsx");
  assert.match(categoryRoute, /id="bo-loc"/, "PLP filter container carries #bo-loc anchor");
  assert.match(categoryRoute, /collection-products-anchor/, "PLP filter container clears masthead");

  const plpGrid = read("src/components/brand/plp-infinite-grid.tsx");
  assert.match(plpGrid, /<ListingProductGrid/, "PLP grid uses shared ListingProductGrid");
  assert.match(
    plpGrid,
    /id=\{emptyStateAnchors \? "san-pham" : undefined\}/,
    "PLP empty state carries #san-pham anchor unless the listing placed it above the grid",
  );
  assert.match(plpGrid, /emptyStateAnchors = true/, "the category listing keeps the anchor by default");
});

test("collection #san-pham keeps landing on the title or the controls, never on the grid", () => {
  // homepage-hero.spec.ts locks this: the CTA lands with the H1 (no gallery) or the controls
  // section (gallery) in view, and exactly one #san-pham exists on the page.
  const collectionPage = read("src/app/collections/[slug]/page.tsx");
  assert.match(
    collectionPage,
    /href=\{`#\$\{COLLECTION_PRODUCTS_ANCHOR\}`\}/,
    "hero cue links to #san-pham",
  );
  assert.match(collectionPage, /productsAnchorOnTitle \? COLLECTION_PRODUCTS_ANCHOR : "bo-suu-tap"/, "title carries #san-pham, else #bo-suu-tap");
  assert.match(collectionPage, /productsAnchorOnTitle \? "bo-loc" : COLLECTION_PRODUCTS_ANCHOR/, "controls carry #san-pham when a gallery/video precedes them, else #bo-loc");
  assert.match(collectionPage, /emptyStateAnchors=\{false\}/, "the grid must not add a second #san-pham");
  assert.doesNotMatch(collectionPage, /<div id=\{COLLECTION_PRODUCTS_ANCHOR\}/, "the empty state must not add a second #san-pham");
});

test("shop, sale, and new-arrivals listing surfaces carry #san-pham on populated and empty states", () => {
  const shopPage = read("src/app/shop/page.tsx");
  assert.match(shopPage, /id="bo-loc"/, "shop filter section carries #bo-loc");
  assert.match(shopPage, /<ListingProductGrid/, "shop uses shared ListingProductGrid");
  assert.match(shopPage, /id="san-pham"/, "shop empty state carries #san-pham");

  const saleListing = read("src/components/brand/sale-listing.tsx");
  assert.match(saleListing, /<PlpInfiniteGrid/, "sale uses the shared infinite grid, which draws the shared ListingProductGrid");
  assert.match(saleListing, /id="san-pham"/, "sale empty state carries #san-pham");

  const newArrivals = read("src/app/new-arrivals/page.tsx");
  assert.match(newArrivals, /<ListingProductGrid/, "new-arrivals uses shared ListingProductGrid");
  assert.match(newArrivals, /id="san-pham"/, "new-arrivals empty state carries #san-pham");
});

test("product detail pages (PDP) provide #san-pham, #chi-tiet, and #mua-hang anchors", () => {
  const pdpPage = read("src/app/shop/[slug]/page.tsx");
  assert.match(pdpPage, /id="san-pham"/, "PDP top anchor is #san-pham");
  assert.match(pdpPage, /id="chi-tiet"/, "PDP carries #chi-tiet alias");
  assert.match(pdpPage, /collection-products-anchor/, "PDP anchor clears masthead");

  const pdpDetail = read("src/components/brand/product-detail.tsx");
  assert.match(pdpDetail, /id="mua-hang"/, "purchase panel carries #mua-hang anchor");
  assert.match(pdpDetail, /id="chon-size"/, "purchase panel carries #chon-size alias");
  assert.match(pdpDetail, /id="dat-hang"/, "purchase panel carries #dat-hang alias");
});

test("StorefrontAnchorScroll helper is mounted in SiteDocument for mobile WebView resilience", () => {
  const doc = read("src/components/brand/site-document.tsx");
  assert.match(doc, /StorefrontAnchorScroll/, "SiteDocument mounts StorefrontAnchorScroll");

  const helper = read("src/components/brand/storefront-anchor-scroll.tsx");
  assert.match(helper, /"use client"/, "helper is a client component");
  assert.match(helper, /scrollIntoView/, "helper uses native scrollIntoView");
});

test("StorefrontAnchorScroll follows client-side navigation, not just the first load", () => {
  const helper = read("src/components/brand/storefront-anchor-scroll.tsx");
  assert.match(helper, /usePathname\(\)/, "reacts to pathname changes");
  assert.match(helper, /useSearchParams\(\)/, "reacts to query-only changes");
  assert.match(helper, /<Suspense/, "useSearchParams is wrapped in Suspense");
  assert.match(helper, /\[pathname, queryAnchor\]/, "effect re-runs on navigation, not on every query change");
  assert.match(helper, /TARGET_WAIT_ATTEMPTS/, "waits a bounded time for the new route's target");
  assert.match(helper, /userMoved/, "delayed scrolls are skipped once the shopper scrolls manually");
  assert.doesNotMatch(helper, /get\("view"\)/, "must not hijack the listing ?view= param");
});

test("scroll honours prefers-reduced-motion", () => {
  assert.equal(storefrontScrollBehavior(true), "instant");
  assert.equal(storefrontScrollBehavior(false), "smooth");
  const helper = read("src/components/brand/storefront-anchor-scroll.tsx");
  assert.match(helper, /prefers-reduced-motion: reduce/, "helper reads the OS setting");
  assert.doesNotMatch(helper, /behavior:\s*"smooth"/, "no hard-coded smooth scroll");
});

test("resolveStorefrontAnchor prefers the fragment and falls back to ?scroll= / ?anchor=", () => {
  assert.equal(resolveStorefrontAnchor("#san-pham", ""), "san-pham");
  assert.equal(resolveStorefrontAnchor("#mua-hang", "?scroll=san-pham"), "mua-hang");
  assert.equal(resolveStorefrontAnchor("", "?scroll=san-pham"), "san-pham");
  assert.equal(resolveStorefrontAnchor("", "?anchor=bo-loc"), "bo-loc");
  assert.equal(resolveStorefrontAnchor("#%E0%A4%A", ""), null, "malformed escape does not throw");
});

test("a fragment the helper does not manage is never overridden by the query fallback", () => {
  // PDP "Xem ảnh khách hàng" link: opened with ?scroll=mua-hang, then the shopper clicks #pdp-feedback.
  assert.equal(resolveStorefrontAnchor("#pdp-feedback", "?scroll=mua-hang"), null);
  assert.equal(resolveStorefrontAnchor("#unknown", "?anchor=bo-loc"), null);
  assert.equal(resolveStorefrontAnchor("#%E0%A4%A", "?scroll=san-pham"), null, "malformed fragment is still a fragment");
});

test("resolveStorefrontAnchor ignores unrelated and unsupported input", () => {
  assert.equal(resolveStorefrontAnchor("", "?view=small"), null, "?view= is the listing size, not an anchor");
  assert.equal(resolveStorefrontAnchor("", "?scroll=evil"), null);
  assert.equal(resolveStorefrontAnchor("", ""), null);
  assert.equal(storefrontQueryAnchor("?view=small&scroll=san-pham"), "san-pham");
  assert.equal(storefrontQueryAnchor("?view=small"), null);
});

test("alias anchor spans are zero-size, not sr-only (sr-only's -1px margin trips the mobile overflow gate)", () => {
  const files = [
    "src/components/brand/listing-view.tsx",
    "src/components/brand/plp-infinite-grid.tsx",
    "src/components/brand/sale-listing.tsx",
    "src/components/brand/product-detail.tsx",
    "src/app/new-arrivals/page.tsx",
    "src/app/shop/[slug]/page.tsx",
    "src/app/shop/page.tsx",
    "src/app/collections/[slug]/page.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /<span id=[^>]*className="sr-only" aria-hidden="true" \/>/,
      `${file}: an alias anchor span must not use sr-only (it sits at left:-1px)`,
    );
    assert.match(source, /pointer-events-none absolute h-0 w-0/, `${file}: alias anchor span is zero-size`);
  }
});
