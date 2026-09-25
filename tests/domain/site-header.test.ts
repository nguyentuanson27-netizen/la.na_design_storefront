import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

test("mega-menu: every top-level category and Sale open a panel, the other primary links do not", () => {
  type HierarchicalLink = { href: string; label: string; key?: string; children?: readonly HierarchicalLink[] };
  const primary = NAVIGATION.primary as readonly HierarchicalLink[];
  const headerSource = readFileSync(path.join(REPO_ROOT, "src/components/brand/site-header.tsx"), "utf8");

  // Owner request 2026-09-24: Váy, đầm and Phụ kiện open panels too. A panel belongs to a primary
  // link that is a category (it has a key) or has children, so the keyed set is the panel set.
  assert.match(headerSource, /const hasMenu = hasChildren \|\| Boolean\(item\.key\);/);
  assert.match(headerSource, /\{hasMenu && isMegaOpen \? \(/);
  assert.deepEqual(
    primary.filter((item) => item.key).map((item) => item.label),
    ["Áo dài", "Set đồ", "Váy, đầm", "Phụ kiện"],
  );
  assert.deepEqual(
    primary.filter((item) => !item.key && !item.children?.length).map((item) => item.label),
    ["Hàng mới về", "Bộ sưu tập"],
  );
  // Sale is not a category, but it opens a panel for its sale sub-listings.
  assert.deepEqual(
    primary.find((item) => item.label === "Sale")?.children?.map((child) => child.label),
    ["Ưu đãi", "Flash Sale", "Xả hàng lẻ size"],
  );

  // A leaf category's panel links to the category itself, named for the category it opens.
  assert.match(headerSource, /\{hasChildren \? item\.label : "Xem tất cả"\}/);
  assert.match(headerSource, /<span className="sr-only"> \{item\.label\}<\/span>/);

  // The media is landscape 16:9, up to 44rem wide, beside a link column no narrower than 7.5rem.
  assert.match(headerSource, /grid-cols-\[minmax\(7\.5rem,1fr\)_minmax\(0,44rem\)\]/);
  assert.match(headerSource, /aspect-video/);
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
  /*
   * The mobile utility row used to be cart-only -- everything but the last control was hidden.
   * The mobile spec gives the phone header menu + logo + search + cart, with Account moved into
   * the menu, so the rule that hides "everything but the last" is replaced by one that hides
   * exactly the account link. Search and cart are asserted to survive, which is what the old
   * blanket rule would silently have taken away.
   */
  assert.match(
    cssSource,
    /\.utility-nav\s*a\.mobile-account-link\s*\{\s*display:\s*none;/,
    "globals.css must keep Account out of the mobile utility row",
  );
  assert.doesNotMatch(
    cssSource,
    /\.utility-nav\s*a:not\(:last-child\),\s*\.utility-nav\s*button:not\(:last-child\)\s*\{\s*display:\s*none;/,
    "the cart-only mobile utility row is superseded by menu + logo + search + cart",
  );
  assert.match(
    headerSource,
    /className=\{isAccount \? "mobile-account-link" : undefined\}/,
    "only the account control may carry the class the mobile rule hides",
  );

  // ...and what stays keeps a reachable target.
  assert.match(
    cssSource,
    /\.utility-nav\s*button,\s*\.utility-nav\s*a\s*\{[^}]*min-width:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);/,
    "remaining mobile utility controls must keep the practical touch target",
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

  // Page scroll locking when open, through the shared hook -- see the note in `useScrollLock`.
  assert.match(source, /useScrollLock\(isMobileNavOpen\)/);
});

test("mobile navigation: subcategories are collapsed behind a per-category disclosure", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/site-header.tsx"),
    "utf8",
  );
  const cssSource = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");

  // One expanded category at a time, reset whenever the drawer is reopened, so the menu never
  // reopens showing whatever was last expanded.
  assert.match(source, /const \[expandedMobileGroup, setExpandedMobileGroup\] = useState<string \| null>\(null\)/);
  assert.match(
    source,
    /const openMobileNav = \(\) => \{[^}]*setExpandedMobileGroup\(null\);/,
    "reopening the mobile menu must collapse every category again",
  );
  assert.match(
    source,
    /setExpandedMobileGroup\(isExpanded \? null : item\.href\)/,
    "the disclosure must expand one category and collapse the previous one",
  );

  // The children render only while their own category is expanded, and the disclosure says so.
  assert.match(source, /aria-expanded=\{isExpanded\}/);
  assert.match(source, /aria-controls=\{panelId\}/);
  assert.match(source, /hidden=\{!isExpanded\}/);
  assert.match(
    source,
    /aria-label=\{`\$\{isExpanded \? "Thu gọn" : "Mở rộng"\} \$\{item\.label\}`\}/,
    "the disclosure must name the category it opens, in Vietnamese",
  );

  // The category itself stays a link: collapsing the children must not cost it its route.
  assert.match(source, /className="mobile-menu__link"/);

  // Compact rows: the 44px touch target is the whole row height, with no padding stacked on it.
  assert.match(
    cssSource,
    /\.mobile-menu a,\s*\.mobile-menu button,[^{]*\{[^}]*min-height:\s*var\(--control-height\);/,
    "mobile menu rows must keep the 44px touch target",
  );
  assert.doesNotMatch(
    cssSource,
    /\.mobile-menu a \{[^}]*padding-block:/,
    "mobile menu rows must not stack padding on top of the touch target",
  );
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

test("F2b mobile search: mobile navigation triggers SearchOverlay instead of navigating to /search", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/site-header.tsx"),
    "utf8",
  );

  // In mobile utility section, /search must render a button, not a Link. The list item around it
  // is markup; what this rule is about is that the control is a button, so the assertion allows
  // the row wrapper and still rejects a <Link>.
  assert.match(
    source,
    /if\s*\(\s*item\.href\s*===\s*"\/search"\s*\)\s*\{\s*return\s*\(\s*(<li[^>]*>\s*)?<button/,
    "Mobile utility search must render a <button>, not a <Link>",
  );

  // The button must trigger mobile search opening
  assert.match(
    source,
    /onClick=\{handleOpenMobileSearch\}/,
    "Mobile search button must call handleOpenMobileSearch",
  );

  // handleOpenMobileSearch must close mobile nav and open search overlay
  assert.match(
    source,
    /const handleOpenMobileSearch = \(\) => \{\s*closeMobileNav\(\);\s*openSearch\(mobileNavTriggerRef\.current\);\s*\};/,
    "handleOpenMobileSearch must close mobile nav and open search overlay with mobile trigger ref",
  );

  // SearchOverlay must receive activeSearchTriggerRef
  assert.match(
    source,
    /<SearchOverlay[^>]*triggerRef=\{activeSearchTriggerRef\}/,
    "SearchOverlay must receive activeSearchTriggerRef to restore focus on close",
  );
});



test("owner hero overlay contract is marker-driven and keeps non-hero pages cream", () => {
  const headerSource = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/site-header.tsx"),
    "utf8",
  );
  const cssSource = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");

  assert.match(headerSource, /data-scrolled=\{isScrolled \? "true" : "false"\}/);
  assert.match(headerSource, /window\.scrollY > 20/);
  assert.doesNotMatch(
    headerSource,
    /md:bg-transparent/,
    "desktop must not become transparent merely because the viewport is wide",
  );
  assert.match(
    cssSource,
    /body:has\(#main-content \[data-header-overlay-hero\]\) \.site-header\[data-scrolled="false"\]/,
    "only a real first-surface hero marker may opt the page into transparent header chrome",
  );
  assert.match(
    cssSource,
    /body:has\(#main-content \[data-header-overlay-hero\]\) \.site-masthead[\s\S]*position:\s*fixed/,
    "a marked first surface must begin at the top viewport behind the masthead",
  );
});

/**
 * The page-scroll lock is written once.
 *
 * `document.body.style.overflow = "hidden"` is the usual one-liner, and on this site it does
 * nothing: `globals.css` sets `html { overflow-x: clip }`, and the viewport only falls back to
 * `body` for its overflow when the root computes to `visible` on both axes. Four components -- the
 * header, the search overlay, the cart drawer and the PLP filter panel -- each carried that same
 * ineffective line, so a full-screen overlay never actually held the page still.
 *
 * `useScrollLock` locks the root as well, and this pins both halves of that: the hook keeps doing
 * it, and nothing reintroduces a hand-rolled copy. A fifth copy is how the defect comes back.
 */
test("the page-scroll lock lives in one place and locks the element that actually scrolls", () => {
  const hook = readFileSync(
    path.join(REPO_ROOT, "src/components/headless/use-scroll-lock.ts"),
    "utf8",
  );

  // The root is what scrolls here; body alone is the bug this replaced.
  assert.match(hook, /document\.documentElement/);
  assert.match(hook, /root\.style\.overflow = "hidden"/);
  assert.match(hook, /document\.body\.style\.overflow = "hidden"/);
  // ...and both are put back, rather than being cleared to a hardcoded default.
  assert.match(hook, /root\.style\.overflow = originalRootOverflow/);
  assert.match(hook, /document\.body\.style\.overflow = originalBodyOverflow/);

  const componentsDir = path.join(REPO_ROOT, "src/components/brand");
  const offenders = readdirSync(componentsDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) =>
      readFileSync(path.join(componentsDir, name), "utf8").includes(
        'document.body.style.overflow',
      ),
    );
  assert.deepEqual(
    offenders,
    [],
    "these components lock scroll by hand instead of calling useScrollLock, which does not work on this site",
  );
});
