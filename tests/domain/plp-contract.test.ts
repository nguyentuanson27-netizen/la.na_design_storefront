import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCategoryDiscoveryHref,
  decodeCategoryCursor,
  encodeCategoryCursor,
  parseCategoryDiscoverySearchParams,
} from "../../src/commerce/category-discovery-url.ts";
import { handleDrawerFocusTrap } from "../../src/components/headless/cart-drawer-model.ts";
import { buildCatalogListingMetadata } from "../../src/seo/catalog-listing-metadata.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ORIGIN = "https://lanadesign.vn";

test("F4a parses bounded URL-backed category discovery filters", () => {
  const parsed = parseCategoryDiscoverySearchParams("aoDai", {
    color: "Trắng",
    size: "M",
    minPrice: "300000",
    maxPrice: "900000",
    sale: "true",
    sort: "price-asc",
    page: "2",
  });

  assert.deepEqual(parsed, {
    categoryKey: "aoDai",
    query: null,
    color: "Trắng",
    size: "M",
    availability: null,
    minPriceVnd: 300000,
    maxPriceVnd: 900000,
    sale: true,
    collection: null,
    sort: "price-asc",
    page: 2,
    cursor: null,
  });
});

test("F4a defaults to manual merchandising sort ('default') when sort is omitted", () => {
  const parsed = parseCategoryDiscoverySearchParams("aoDai", {});
  assert.equal(parsed.sort, "default");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.color, null);
  assert.equal(parsed.size, null);
  assert.equal(parsed.sale, null);
});

test("F4a strictly refuses fake bestseller sort", () => {
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { sort: "bestseller" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { sort: "ban-chay" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { sort: "featured" }),
    /invalid/i,
  );
});

test("F4a rejects duplicate, contradictory, and out-of-bounds parameters", () => {
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { size: ["S", "M"] }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { minPrice: "500000", maxPrice: "200000" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { sale: "yes" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { page: "0" }),
    /invalid/i,
  );
  assert.throws(
    () => parseCategoryDiscoverySearchParams("aoDai", { color: "x".repeat(65) }),
    /invalid/i,
  );
});

test("F4a cursor encoding and decoding round-trip cleanly", () => {
  const cursor = encodeCategoryCursor(3);
  assert.ok(typeof cursor === "string" && cursor.length > 0);
  assert.deepEqual(decodeCategoryCursor(cursor), { page: 3 });

  // Passing cursor sets page if page param is not provided
  const parsed = parseCategoryDiscoverySearchParams("aoDai", { cursor });
  assert.equal(parsed.page, 3);
  assert.equal(parsed.cursor, cursor);
});

test("F4a rejects tampered or malformed cursor", () => {
  assert.throws(() => decodeCategoryCursor("not-base-64!@#"), /invalid/i);
  assert.throws(() => decodeCategoryCursor(Buffer.from("invalid-json").toString("base64url")), /invalid/i);
  assert.throws(
    () => decodeCategoryCursor(Buffer.from(JSON.stringify({ p: -1 })).toString("base64url")),
    /invalid/i,
  );
});

test("F4a builds stable category URLs with default omissions", () => {
  // Base path has no params
  assert.equal(
    buildCategoryDiscoveryHref("/ao-dai", { categoryKey: "aoDai", sort: "default", page: 1 }),
    "/ao-dai",
  );

  // Pure pagination produces /ao-dai?page=2
  assert.equal(
    buildCategoryDiscoveryHref("/ao-dai", { categoryKey: "aoDai", sort: "default", page: 2 }, 2),
    "/ao-dai?page=2",
  );

  // Filtered URL omits sort=default and page=1
  assert.equal(
    buildCategoryDiscoveryHref(
      "/ao-dai",
      {
        categoryKey: "aoDai",
        size: "M",
        color: "Đỏ",
        sale: true,
        sort: "default",
        page: 1,
      },
      1,
    ),
    "/ao-dai?color=%C4%90%E1%BB%8F&size=M&sale=true",
  );

  // Non-default sort is retained
  assert.equal(
    buildCategoryDiscoveryHref(
      "/ao-dai",
      {
        categoryKey: "aoDai",
        sort: "price-asc",
        page: 2,
      },
      2,
    ),
    "/ao-dai?sort=price-asc&page=2",
  );
});

test("F4a base category route self-canonicalizes while query states withhold canonical", () => {
  // Base category path self-canonicalizes
  const canonicalBase = buildCatalogListingMetadata({
    origin: ORIGIN,
    indexingEnabled: true,
    pathname: "/ao-dai",
    searchParams: {},
    title: "Áo Dài",
  });
  assert.equal(canonicalBase.alternates?.canonical, "https://lanadesign.vn/ao-dai");

  // Query states (page, filters) withhold canonical per search exposure policy
  const queryStatePage = buildCatalogListingMetadata({
    origin: ORIGIN,
    indexingEnabled: true,
    pathname: "/ao-dai",
    searchParams: { page: "2" },
    title: "Áo Dài",
  });
  assert.equal(queryStatePage.alternates?.canonical, undefined);

  const queryStateFiltered = buildCatalogListingMetadata({
    origin: ORIGIN,
    indexingEnabled: true,
    pathname: "/ao-dai",
    searchParams: { color: "Đỏ", size: "M" },
    title: "Áo Dài",
  });
  assert.equal(queryStateFiltered.alternates?.canonical, undefined);
});

test("F4b infinite-scroll URL contract updates to loaded page (not nextHref) and reconstructs on refresh", () => {
  const categoryPath = "/danh-muc/dam";
  const discovery = parseCategoryDiscoverySearchParams("dam", {
    color: "Trắng",
    sort: "price-asc",
    page: "2",
  });

  // When page 2 is loaded, browser URL must reflect page 2 (currentHref), preserving filters
  const currentHref = buildCategoryDiscoveryHref(categoryPath, discovery, 2);
  assert.equal(currentHref, "/danh-muc/dam?color=Tr%E1%BA%AFng&sort=price-asc&page=2");

  // While nextHref continues to point to page 3 for crawler / load-next contract
  const nextHref = buildCategoryDiscoveryHref(categoryPath, discovery, 3);
  assert.equal(nextHref, "/danh-muc/dam?color=Tr%E1%BA%AFng&sort=price-asc&page=3");

  // When browser refreshes with currentHref, discovery contract reconstructs page 2
  const refreshedUrl = new URL(currentHref, "https://lanadesign.vn");
  const reconstructed = parseCategoryDiscoverySearchParams(
    "dam",
    Object.fromEntries(refreshedUrl.searchParams.entries()),
  );

  assert.equal(reconstructed.page, 2);
  assert.equal(reconstructed.color, "Trắng");
  assert.equal(reconstructed.sort, "price-asc");
});

test("F4b mobile PLP filter drawer: enforces focus trap, Escape dismissal, and opener restoration", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/plp-filter-panel.tsx"),
    "utf8",
  );

  // Dialog semantics
  assert.match(source, /id="mobile-plp-filters"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="Bộ lọc sản phẩm"/);

  // Escape closes filter drawer
  assert.match(source, /e\.key === "Escape"/);
  assert.match(source, /setIsMobileOpen\(false\)/);

  // Tab focus trap
  assert.match(source, /handleDrawerFocusTrap\(e,\s*drawerRef\.current\)/);

  // Opener button reference captured on open
  assert.match(source, /openerButtonRef\.current = e\.currentTarget/);

  // Focus restored to opener on drawer close
  assert.match(source, /openerButtonRef\.current\?\.focus\?\.\(\)/);

  // Body scroll locked while drawer is open
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
});

test("F4b mobile PLP filter drawer focus trap: traps Tab and Shift+Tab within filter drawer", () => {
  let closeBtnFocused = false;
  let applyBtnFocused = false;

  const mockCloseBtn = {
    tagName: "BUTTON",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => { closeBtnFocused = true; },
  } as unknown as HTMLElement;

  const mockFilterLink = {
    tagName: "A",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => {},
  } as unknown as HTMLElement;

  const mockApplyBtn = {
    tagName: "BUTTON",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => { applyBtnFocused = true; },
  } as unknown as HTMLElement;

  const focusables = [mockCloseBtn, mockFilterLink, mockApplyBtn];

  const mockContainer = {
    querySelectorAll: () => focusables,
  } as unknown as HTMLElement;

  const originalDoc = globalThis.document;
  const docHolder = globalThis as unknown as { document: { activeElement: HTMLElement | null } };
  docHolder.document = { activeElement: mockApplyBtn };

  try {
    // 1. Tab on last element (Apply button) wraps to close button (first)
    let prevented = false;
    const tabEvent = {
      key: "Tab",
      shiftKey: false,
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent;

    handleDrawerFocusTrap(tabEvent, mockContainer);
    assert.equal(closeBtnFocused, true, "Tab from last element must wrap to close button");
    assert.equal(prevented, true, "Tab from last element must prevent default");

    // 2. Shift+Tab on first element (close button) wraps to apply button (last)
    docHolder.document.activeElement = mockCloseBtn;
    let shiftPrevented = false;
    const shiftTabEvent = {
      key: "Tab",
      shiftKey: true,
      preventDefault: () => { shiftPrevented = true; },
    } as unknown as KeyboardEvent;

    handleDrawerFocusTrap(shiftTabEvent, mockContainer);
    assert.equal(applyBtnFocused, true, "Shift+Tab from close button must wrap to apply button");
    assert.equal(shiftPrevented, true, "Shift+Tab from close button must prevent default");
  } finally {
    docHolder.document = originalDoc;
  }
});

