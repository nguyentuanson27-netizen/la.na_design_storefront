import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STOREFRONT_PRODUCTS_ANCHOR,
  STOREFRONT_PRODUCTS_ALIAS_ANCHOR,
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
  const chrome = read("src/components/brand/listing-chrome.tsx");
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
  assert.match(plpGrid, /id="san-pham"/, "PLP empty state carries #san-pham anchor");
});

test("collection pages deep link straight to products grid from hero cue and external URLs", () => {
  const collectionPage = read("src/app/collections/[slug]/page.tsx");
  assert.match(
    collectionPage,
    /href=\{`#\$\{COLLECTION_PRODUCTS_ANCHOR\}`\}/,
    "hero cue links to #san-pham",
  );
  assert.match(collectionPage, /id="bo-suu-tap"/, "collection title carries #bo-suu-tap anchor");
  assert.match(collectionPage, /id="bo-loc"/, "collection filter carries #bo-loc anchor");
  assert.match(collectionPage, /<ListingProductGrid/, "collection uses shared ListingProductGrid");
  assert.match(collectionPage, /id=\{COLLECTION_PRODUCTS_ANCHOR\}/, "collection empty state carries #san-pham anchor");
});

test("shop, sale, and new-arrivals listing surfaces carry #san-pham on populated and empty states", () => {
  const shopPage = read("src/app/shop/page.tsx");
  assert.match(shopPage, /id="bo-loc"/, "shop filter section carries #bo-loc");
  assert.match(shopPage, /<ListingProductGrid/, "shop uses shared ListingProductGrid");
  assert.match(shopPage, /id="san-pham"/, "shop empty state carries #san-pham");

  const saleListing = read("src/components/brand/sale-listing.tsx");
  assert.match(saleListing, /<ListingProductGrid/, "sale uses shared ListingProductGrid");
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
  assert.match(helper, /san-pham/, "helper recognizes san-pham anchor");
  assert.doesNotMatch(helper, /params\.get\("view"\)/, "helper must not hijack the generic ?view param");
  assert.match(
    helper,
    /function scrollToTarget\(\) \{\s*const targetId = resolveTargetId\(\);/,
    "target is re-resolved per attempt so hashchange scrolls to the new fragment",
  );
  assert.match(helper, /userMoved/, "delayed scrolls are skipped once the shopper scrolls manually");
});
