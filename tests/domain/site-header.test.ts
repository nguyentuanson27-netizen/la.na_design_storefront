import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATION } from "../../src/brand/index.ts";
import { buildSiteChromeContent } from "../../src/components/headless/site-chrome-model.ts";

test("F2a navigation: primary navigation matches approved order and exclusions", () => {
  const primaryLabels = NAVIGATION.primary.map((item) => item.label);
  const expectedLabels = [
    "Áo dài",
    "Set đồ",
    "Váy, đầm",
    "Phụ kiện",
    "Hàng mới về",
    "Bộ sưu tập",
    "Sale",
  ];

  assert.deepEqual(
    primaryLabels,
    expectedLabels,
    "Primary navigation must match exact approved 7-item order",
  );

  // Logo links to / and there is no Trang chủ
  assert.equal(NAVIGATION.brandHomeLabel, "La.na Design — Trang chủ");
  assert.ok(
    !primaryLabels.includes("Trang chủ"),
    "Trang chủ must not appear in primary navigation",
  );

  // No Wishlist in primary, utility, or mobile utility
  const allHrefs = [
    ...NAVIGATION.primary.map((i) => i.href),
    ...NAVIGATION.utility.map((i) => i.href),
    ...NAVIGATION.mobileUtility.map((i) => i.href),
  ];
  assert.ok(
    !allHrefs.some((href) => href.toLowerCase().includes("wishlist")),
    "Wishlist must not exist in any navigation surface",
  );
});

test("F2a mega-menu: Áo dài and Set đồ have approved children subcategories", () => {
  type HierarchicalLink = { href: string; label: string; children?: readonly HierarchicalLink[] };
  const primary = NAVIGATION.primary as readonly HierarchicalLink[];

  const aoDai = primary.find((i) => i.label === "Áo dài");
  assert.ok(aoDai?.children, "Áo dài must have children for mega menu");
  assert.deepEqual(
    aoDai.children.map((c) => c.label),
    ["Áo dài cách tân", "Áo dài Tết", "Áo dài cưới", "Áo dài 4 tà", "Áo dài 6 tà"],
  );

  const setDo = primary.find((i) => i.label === "Set đồ");
  assert.ok(setDo?.children, "Set đồ must have children for mega menu");
  assert.deepEqual(
    setDo.children.map((c) => c.label),
    ["Set váy", "Set quần áo"],
  );
});

test("F2a site chrome model: supports category mega media projection", () => {
  const chromeContent = buildSiteChromeContent([
    { categoryKey: "aoDai", imageUrl: "https://example.com/aodai.jpg", altText: "Áo dài La.na" },
  ]);

  assert.ok(chromeContent.header, "site-chrome-model must provide header content");
  assert.equal(chromeContent.header.megaMedia.length, 1);
  assert.equal(chromeContent.header.megaMedia[0]!.categoryKey, "aoDai");
});
