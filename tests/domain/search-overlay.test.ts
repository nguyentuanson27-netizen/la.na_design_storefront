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

  // Role alert for error state
  assert.match(source, /role="alert"/);

  // Focus restore prioritizes actual opener over desktop trigger and checks DOM connection
  assert.match(source, /previouslyFocusedElement\.current \?\? triggerRef\?\.current/);
  assert.match(source, /document\.body\.contains\(candidateTarget\)/);

  // Input enforces maxLength and placeholder has high contrast
  assert.match(source, /maxLength=\{STOREFRONT_DISCOVERY_LIMITS\.query\}/);
  assert.match(source, /placeholder:text-\[#70584B\]/);

  // Submit and View All CTA guard against query > 80 chars
  assert.match(source, /trimmed\.length\s*<=\s*STOREFRONT_DISCOVERY_LIMITS\.query/);
  assert.match(source, /query\.trim\(\)\.length\s*<=\s*STOREFRONT_DISCOVERY_LIMITS\.query/);

  // Suggested product cards pin 2:3 aspect ratio
  assert.match(source, /aspect-\[2\/3\]/, "search suggestion product cards must pin 2:3 aspect ratio");
  assert.doesNotMatch(source, /aspect-\[4\/5\]/, "search suggestion product cards must not revert to 4:5");
});

test("F2b search suggestions: enforces 80-character query limit and handles infrastructure errors", async () => {
  const { searchStorefrontSuggestionsWithFinder } = await import(
    "../../src/commerce/storefront-search-actions.ts"
  );

  // 1. Query exceeding 80 chars must be rejected with error state
  const overlongQuery = "a".repeat(81);
  const overlongResult = await searchStorefrontSuggestionsWithFinder(overlongQuery, async () => []);
  assert.ok(overlongResult.error, "Overlong query must return error");
  assert.match(overlongResult.error, /80 ký tự/);
  assert.deepEqual(overlongResult.categories, []);
  assert.deepEqual(overlongResult.products, []);

  // 2. Query within 80 chars succeeds
  const validQuery = "áo dài";
  const validResult = await searchStorefrontSuggestionsWithFinder(validQuery, async () => [
    {
      id: "prod-1",
      slug: "ao-dai-lua",
      name: "Áo Dài Lụa",
      primaryImageUrl: null,
      priceText: "850.000 ₫",
    },
  ]);
  assert.equal(validResult.error, undefined);
  assert.equal(validResult.products.length, 1);
  assert.ok(validResult.categories.length > 0);

  // 3. Finder/DB failure must return typed error state, not silent empty result
  const failingResult = await searchStorefrontSuggestionsWithFinder("áo", async () => {
    throw new Error("Prisma client connection failure");
  });
  assert.ok(failingResult.error, "Infrastructure failure must return error property");
  assert.match(failingResult.error, /Không thể kết nối/);
  assert.deepEqual(failingResult.products, [], "Products must be empty on failure");
  assert.ok(failingResult.categories.length > 0, "Matched taxonomy categories can still be provided");
});

