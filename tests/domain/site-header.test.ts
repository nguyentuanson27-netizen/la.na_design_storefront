import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NAVIGATION } from "../../src/brand/index.ts";
import { handleDrawerFocusTrap } from "../../src/components/headless/cart-drawer-model.ts";
import { buildSiteChromeContent } from "../../src/components/headless/site-chrome-model.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

test("F2a mobile navigation structure: hamburger on left, logo centered, cart on right in mobile header layout", () => {
  const headerSource = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/site-header.tsx"),
    "utf8",
  );
  const cssSource = readFileSync(
    path.join(REPO_ROOT, "src/app/globals.css"),
    "utf8",
  );

  // In nav-shell, the order of elements must be: mobile-nav (hamburger), brand-mark (logo), desktop-nav, utility-nav
  const mobileNavIndex = headerSource.indexOf('className="mobile-nav"');
  const brandMarkIndex = headerSource.indexOf('className="brand-mark"');
  const desktopNavIndex = headerSource.indexOf('className="desktop-nav"');
  const utilityNavIndex = headerSource.indexOf('className="utility-nav"');

  assert.ok(mobileNavIndex > 0, "mobile-nav trigger must exist");
  assert.ok(brandMarkIndex > 0, "brand-mark logo must exist");
  assert.ok(desktopNavIndex > 0, "desktop-nav must exist");
  assert.ok(utilityNavIndex > 0, "utility-nav must exist");

  assert.ok(
    mobileNavIndex < brandMarkIndex,
    "mobile-nav trigger must be placed before brand-mark for mobile left placement",
  );
  assert.ok(
    brandMarkIndex < desktopNavIndex,
    "brand-mark must be placed before desktop-nav",
  );
  assert.ok(
    desktopNavIndex < utilityNavIndex,
    "desktop-nav must be placed before utility-nav",
  );

  // In CSS: mobile layout has 3 columns: hamburger (start), logo (center), cart (end)
  assert.match(
    cssSource,
    /\.brand-mark\s*\{[^}]*justify-self:\s*center;[^}]*text-align:\s*center;/,
    "globals.css must center the brand mark on mobile",
  );
  assert.match(
    cssSource,
    /\.mobile-nav\s*\{[^}]*justify-self:\s*start;/,
    "globals.css must align mobile-nav to the left",
  );
  assert.match(
    cssSource,
    /\.utility-nav\s*a:not\(:last-child\),\s*\.utility-nav\s*button:not\(:last-child\)\s*\{\s*display:\s*none;/,
    "globals.css must hide utility items other than the last (cart) on mobile",
  );
});

test("F2a mobile navigation dialog: enforces full-screen accessible dialog, Escape dismissal, and focus restoration", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/site-header.tsx"),
    "utf8",
  );

  // Full-screen accessible modal dialog semantics
  assert.match(source, /id="mobile-navigation-dialog"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="Menu điều hướng"/);

  // Hamburger trigger button attributes
  assert.match(source, /aria-label="Menu"/);
  assert.match(source, /aria-expanded=\{isMobileNavOpen\}/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /aria-controls="mobile-navigation-dialog"/);

  // Close button inside dialog
  assert.match(source, /aria-label="Đóng menu"/);

  // Escape key handler closes mobile nav
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /setIsMobileNavOpen\(false\)/);

  // Tab focus trapping
  assert.match(source, /handleDrawerFocusTrap\(event,\s*mobileNavDrawerRef\.current\)/);

  // Focus restoration to trigger button
  assert.match(source, /previouslyFocusedBeforeMobileNav\.current \?\? mobileNavTriggerRef\.current/);
  assert.match(source, /returnTarget\?\.focus\?\.\(\)/);

  // Body scroll locking when open
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
});

test("F2a mobile navigation focus trap: traps Tab and Shift+Tab within container", () => {
  let closeBtnFocused = false;
  let lastLinkFocused = false;

  const mockCloseBtn = {
    tagName: "BUTTON",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => { closeBtnFocused = true; },
  } as unknown as HTMLElement;

  const mockFirstLink = {
    tagName: "A",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => {},
  } as unknown as HTMLElement;

  const mockLastLink = {
    tagName: "A",
    hasAttribute: () => false,
    getAttribute: () => null,
    focus: () => { lastLinkFocused = true; },
  } as unknown as HTMLElement;

  const focusables = [mockCloseBtn, mockFirstLink, mockLastLink];

  const mockContainer = {
    querySelectorAll: () => focusables,
  } as unknown as HTMLElement;

  // Setup global document mock without any
  const originalDoc = globalThis.document;
  const docHolder = globalThis as unknown as { document: unknown };
  docHolder.document = { activeElement: mockLastLink };

  try {
    // 1. Tab on last element wraps to close button (first)
    let prevented = false;
    const tabEvent = {
      key: "Tab",
      shiftKey: false,
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent;

    handleDrawerFocusTrap(tabEvent, mockContainer);
    assert.equal(closeBtnFocused, true, "Tab from last element must focus first element (close button)");
    assert.equal(prevented, true, "Tab from last element must prevent default browser tabbing");

    // 2. Shift+Tab on first element wraps to last element
    (docHolder.document as { activeElement: HTMLElement | null }).activeElement = mockCloseBtn;
    let shiftPrevented = false;
    const shiftTabEvent = {
      key: "Tab",
      shiftKey: true,
      preventDefault: () => { shiftPrevented = true; },
    } as unknown as KeyboardEvent;

    handleDrawerFocusTrap(shiftTabEvent, mockContainer);
    assert.equal(lastLinkFocused, true, "Shift+Tab from first element must focus last element");
    assert.equal(shiftPrevented, true, "Shift+Tab from first element must prevent default browser tabbing");
  } finally {
    docHolder.document = originalDoc;
  }
});
