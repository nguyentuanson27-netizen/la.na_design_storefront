import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSearchAnnouncement,
  matchTaxonomyCategories,
  removeVietnameseAccents,
} from "../../src/components/headless/search-overlay-model.ts";
import { matchesStorefrontRoute } from "../../src/routes/manifest.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("F2b search overlay: matches categories from approved taxonomy only", () => {
  assert.equal(removeVietnameseAccents("Áo Dài"), "ao dai");

  // Empty query returns prominent top-level categories
  const emptyMatches = matchTaxonomyCategories("");
  assert.ok(emptyMatches.length >= 4, "Empty query must show top categories");
  assert.ok(emptyMatches.every((cat) => matchesStorefrontRoute(cat.href)), "Every category must resolve to a valid route");

  // Query with Vietnamese accents
  const aoDaiMatches = matchTaxonomyCategories("áo dài");
  assert.ok(aoDaiMatches.length >= 5, "Should match Áo dài and subcategories");
  assert.ok(
    aoDaiMatches.every((cat) => cat.href.startsWith("/ao-dai")),
    "Every matched category must link to an approved F3a/F3b route",
  );

  // Query without accents (deaccented)
  const deaccentMatches = matchTaxonomyCategories("vay");
  assert.ok(deaccentMatches.length >= 1, "Should match Váy, đầm or Set váy");
  assert.ok(
    deaccentMatches.some((cat) => cat.href === "/vay-dam"),
    "Should include /vay-dam route",
  );
});

test("F2b search overlay: builds accessible live region announcements", () => {
  assert.equal(buildSearchAnnouncement("áo dài", true, 0, 0), "Đang tìm kiếm...");
  assert.equal(
    buildSearchAnnouncement("xyz123", false, 0, 0),
    'Không tìm thấy kết quả nào cho "xyz123".',
  );
  assert.equal(
    buildSearchAnnouncement("áo", false, 4, 2),
    'Tìm thấy 4 sản phẩm và 2 danh mục cho "áo".',
  );
});

test("F2b search overlay component: enforces accessible dialog contracts and Escape dismissal", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "src/components/brand/search-overlay.tsx"),
    "utf8",
  );

  // Accessible dialog semantics
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="Tìm kiếm sản phẩm"/);

  // Live region for screen readers
  assert.match(source, /aria-live="polite"/);

  // Escape key and focus trap handlers
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /handleDrawerFocusTrap/);

  // Close button with accessible label
  assert.match(source, /aria-label="Đóng tìm kiếm"/);
});
