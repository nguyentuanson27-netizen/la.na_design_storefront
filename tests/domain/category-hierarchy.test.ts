import assert from "node:assert/strict";
import test from "node:test";

import { CATEGORY_ROUTE_PATHS } from "../../src/brand/category.config.ts";
import {
  categoryByKey,
  categoryByPath,
  categoryAncestorKeys,
  CURRENT_CATEGORY_TAXONOMY,
} from "../../src/commerce/category-taxonomy.ts";
import {
  buildCategoryBreadcrumbStructuredData,
} from "../../src/seo/category-breadcrumb-structured-data.ts";
import {
  resolveCategoryBreadcrumbs,
} from "../../src/routes/category-breadcrumbs.ts";

test("F3b category hierarchy: parent -> child hierarchy agrees with taxonomy", () => {
  // 1. Áo dài children have Áo dài as ancestor
  const aoDaiCachTanAncestors = categoryAncestorKeys("aoDaiCachTan");
  assert.deepEqual(aoDaiCachTanAncestors, ["aoDai"]);

  const aoDaiAncestors = categoryAncestorKeys("aoDai");
  assert.deepEqual(aoDaiAncestors, []);

  // 2. Set đồ children have Set đồ as ancestor
  const setVayAncestors = categoryAncestorKeys("setVay");
  assert.deepEqual(setVayAncestors, ["setDo"]);

  // 3. Top-level categories have no ancestors
  assert.deepEqual(categoryAncestorKeys("vayDam"), []);
  assert.deepEqual(categoryAncestorKeys("phuKien"), []);
});

test("F3b breadcrumbs: resolveCategoryBreadcrumbs builds full hierarchy", () => {
  // Subcategory breadcrumbs: Trang chủ -> Parent -> Subcategory
  const cachTanBreadcrumbs = resolveCategoryBreadcrumbs("aoDaiCachTan");
  assert.deepEqual(cachTanBreadcrumbs, [
    { label: "Trang chủ", href: "/" },
    { label: "Áo dài", href: "/ao-dai" },
    { label: "Áo dài cách tân" },
  ]);

  // Parent category breadcrumbs: Trang chủ -> Parent
  const aoDaiBreadcrumbs = resolveCategoryBreadcrumbs("aoDai");
  assert.deepEqual(aoDaiBreadcrumbs, [
    { label: "Trang chủ", href: "/" },
    { label: "Áo dài" },
  ]);

  // Set váy breadcrumbs: Trang chủ -> Set đồ -> Set váy
  const setVayBreadcrumbs = resolveCategoryBreadcrumbs("setVay");
  assert.deepEqual(setVayBreadcrumbs, [
    { label: "Trang chủ", href: "/" },
    { label: "Set đồ", href: "/set-do" },
    { label: "Set váy" },
  ]);
});

test("F3b breadcrumb structured data matches JSON-LD BreadcrumbList specification", () => {
  const doc = buildCategoryBreadcrumbStructuredData({
    origin: "https://www.lanadesign.vn",
    items: [
      { name: "Trang chủ", href: "/" },
      { name: "Áo dài", href: "/ao-dai" },
      { name: "Áo dài Tết" },
    ],
  });

  assert.deepEqual(doc, {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Trang chủ",
        item: "https://www.lanadesign.vn/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Áo dài",
        item: "https://www.lanadesign.vn/ao-dai",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Áo dài Tết",
      },
    ],
  });
});

test("F3b all category paths in CATEGORY_ROUTE_PATHS have valid nodes and non-empty breadcrumbs", () => {
  for (const path of CATEGORY_ROUTE_PATHS) {
    const node = categoryByPath(path);
    assert.ok(node, `Category node must exist for path ${path}`);
    const breadcrumbs = resolveCategoryBreadcrumbs(node.key);
    assert.ok(breadcrumbs.length >= 2, `Breadcrumbs for ${path} must have at least Trang chu and current node`);
    assert.equal(breadcrumbs[0]!.href, "/");
  }
});
