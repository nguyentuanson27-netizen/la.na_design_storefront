import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LISTING_ACTION_BAR_CLASSES } from "../../src/components/headless/listing-view-model.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

test("the category listing, /sale and /shop draw their phone action bar from the same classes", () => {
  const panel = read("src/components/brand/plp-filter-panel.tsx");
  const shopPage = read("src/app/shop/page.tsx");
  const shopControls = read("src/components/brand/shop-controls.tsx");

  for (const [name, source] of [["plp-filter-panel", panel], ["shop page", shopPage]] as const) {
    assert.match(source, /LISTING_ACTION_BAR_CLASSES\.bar/, `${name} uses the shared bar`);
    assert.match(source, /LISTING_ACTION_BAR_CLASSES\.controls/, `${name} uses the shared controls row`);
    assert.match(source, /LISTING_ACTION_BAR_CLASSES\.sortSelect/, `${name} uses the shared sort select`);
    assert.match(source, /<ListingViewToggle compact/, `${name} uses the compact view toggle`);
  }
  assert.match(panel, /LISTING_ACTION_BAR_CLASSES\.filterTrigger/, "the panel's drawer trigger is the shared one");
  assert.match(shopControls, /LISTING_ACTION_BAR_CLASSES\.filterTrigger/, "the shop drawer trigger is the shared one");
  assert.match(shopControls, /LISTING_ACTION_BAR_CLASSES\.filterTriggerLabel/, "the shop trigger hides its word on a narrow phone");
  assert.match(shopControls, /LISTING_ACTION_BAR_CLASSES\.filterBadge/, "the applied-filter count moves to the funnel's corner");
});

test("the result count is not drawn on /shop; only a visually hidden live copy carries it", () => {
  const shopPage = read("src/app/shop/page.tsx");
  const counts = shopPage.match(/\{data\.totalCount\} sản phẩm/g) ?? [];
  assert.equal(counts.length, 2, "one live copy in each of the two forms");
  assert.equal(
    (shopPage.match(/<span role="status" className="sr-only">\s*\{data\.totalCount\} sản phẩm/g) ?? []).length,
    2,
    "both copies are visually hidden status regions",
  );
});

test("the search is a line of its own under the phone bar and keeps a 36px height", () => {
  const shopPage = read("src/app/shop/page.tsx");
  const mobile = shopPage.slice(shopPage.indexOf('className="md:hidden"'), shopPage.indexOf('className="hidden md:block"'));
  assert.ok(mobile.indexOf("LISTING_ACTION_BAR_CLASSES.bar") < mobile.indexOf('name="q"'), "bar first, then the search");
  assert.match(mobile, /className="h-9 w-full rounded-full/, "a 36px, full-width search");
});

test("the classes keep the sizes the touch-target review settled on", () => {
  const classes = LISTING_ACTION_BAR_CLASSES;
  assert.match(classes.filterTrigger, /after:-inset-x-\[3px\] after:-inset-y-\[5px\]/, "40x44 touch area (insets are 1px past the border)");
  assert.match(classes.filterTrigger, /max-\[423px\]:w-9/, "36px funnel below 424px");
  assert.match(classes.filterTriggerLabel, /max-\[423px\]:sr-only/, "the word stays for assistive technology");
  assert.match(classes.controls, /min-w-\[11\.4rem\]/, "wraps instead of squeezing the sort");
  assert.match(classes.sortSelect, /\bh-9\b/);
  assert.match(classes.bar, /flex-wrap/);
});

test("a collection draws the same one-line bar, keeps its named sort region, and no longer draws the count", () => {
  const panel = read("src/components/brand/collection-filter-panel.tsx");
  assert.match(panel, /LISTING_ACTION_BAR_CLASSES\.bar/, "the bar is the shared one");
  assert.match(panel, /<ListingViewToggle compact/, "the compact view toggle");
  assert.match(panel, /<nav\s+aria-label="Sắp xếp bộ sưu tập"/, "the sort region keeps its name (specs and assistive technology use it)");
  assert.match(panel, /<span role="status" className="sr-only">\s*\{totalCount\} sản phẩm/, "the count is a hidden live region");
  assert.doesNotMatch(panel, /ListingResultCount/, "the visible count is gone");
  assert.match(panel, /sr-only[^"]*sm:not-sr-only/, "the sort label is hidden on a phone so the select keeps its width");
});
