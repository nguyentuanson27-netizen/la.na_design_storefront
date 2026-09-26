import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATION, type NavigationLink } from "../../src/brand/index.ts";
import { CATEGORY_DESTINATIONS } from "../../src/routes/category-destinations.ts";
import { matchesStorefrontRoute } from "../../src/routes/manifest.ts";
import { STATIC_CANONICAL_PATHS } from "../../src/seo/search-sitemap-repository.ts";

type HierarchicalNavigationLink = NavigationLink & Readonly<{
  children?: readonly HierarchicalNavigationLink[];
}>;

const EXPECTED_PRIMARY = ["Áo dài", "Set đồ", "Váy, đầm", "Phụ kiện", "Hàng mới về", "Bộ sưu tập", "Sale"];
const EXPECTED_AO_DAI = ["Áo dài cách tân", "Áo dài Tết", "Áo dài cưới", "Áo dài 4 tà", "Áo dài 6 tà"];
const EXPECTED_SET_DO = ["Set váy", "Set quần áo"];
const primary = NAVIGATION.primary as readonly HierarchicalNavigationLink[];

function activePrimaryHrefs(): string[] {
  return primary.flatMap((item) => [item.href, ...(item.children?.map((child) => child.href) ?? [])]);
}

test("A6 primary navigation has the exact approved order and hierarchy", () => {
  assert.deepEqual(primary.map((item) => item.label), EXPECTED_PRIMARY);
  assert.deepEqual(primary[0]?.children?.map((child) => child.label), EXPECTED_AO_DAI);
  assert.deepEqual(primary[1]?.children?.map((child) => child.label), EXPECTED_SET_DO);
  assert.deepEqual(primary.at(-1)?.children?.map((child) => child.label), ["Ưu đãi", "Flash Sale", "Xả hàng lẻ size"]);
  assert.equal(primary.some((item) => item.href === "/shop" || item.label === "Trang chủ"), false);
});

test("every active primary and footer href resolves and obsolete links are absent", () => {
  const hrefs = [...activePrimaryHrefs(), ...NAVIGATION.footer.map((item) => item.href)];
  assert.deepEqual(hrefs.filter((href) => !matchesStorefrontRoute(href)), []);
  assert.equal(hrefs.includes("/lookbook"), false);
  assert.equal(hrefs.includes("/flash-sale"), false);
});

test("A8 retires obsolete public routes while keeping sale public and canonical", () => {
  assert.equal(matchesStorefrontRoute("/lookbook"), false);
  assert.equal(matchesStorefrontRoute("/flash-sale"), false);
  assert.equal(matchesStorefrontRoute("/sale"), true);
  assert.equal(STATIC_CANONICAL_PATHS.includes("/sale"), true);
  for (const child of ["/sale/uu-dai", "/sale/flash-sale", "/sale/xa-hang-le-size"]) {
    assert.equal(matchesStorefrontRoute(child), true, `${child} must be a declared route`);
    assert.equal((STATIC_CANONICAL_PATHS as readonly string[]).includes(child), true);
  }
  assert.equal((STATIC_CANONICAL_PATHS as readonly string[]).includes("/lookbook"), false);
  assert.equal((STATIC_CANONICAL_PATHS as readonly string[]).includes("/flash-sale"), false);
});

test("F3a category route identity does not claim collection-backed membership authority", () => {
  for (const destination of Object.values(CATEGORY_DESTINATIONS)) {
    assert.deepEqual(Object.keys(destination).sort(), ["href", "label"]);
    assert.equal("collectionSlug" in destination, false);
  }
});
