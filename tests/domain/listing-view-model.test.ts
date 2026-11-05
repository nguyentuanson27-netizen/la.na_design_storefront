import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_LISTING_VIEW,
  DEFAULT_PRODUCT_IMAGE_SIZES,
  LISTING_VIEWS,
  LISTING_VIEW_COOKIE,
  collectionGridClassName,
  collectionImageSizes,
  parseListingView,
  planListingViewRequest,
  productGridClassName,
  productImageSizes,
  readListingViewParam,
  resolveListingView,
  serializeListingViewCookie,
  withListingViewParam,
} from "../../src/components/headless/listing-view-model.ts";

test("only the three named views parse; everything else is ignored", () => {
  assert.equal(parseListingView("large"), "large");
  assert.equal(parseListingView("medium"), "medium");
  assert.equal(parseListingView("small"), "small");
  for (const bad of ["", "LARGE", "huge", " small", null, undefined, 2, {}]) {
    assert.equal(parseListingView(bad), null);
  }
});

test("the URL beats the cookie, the cookie beats the default", () => {
  assert.equal(resolveListingView({ param: "small", cookie: "medium" }), "small");
  assert.equal(resolveListingView({ param: undefined, cookie: "medium" }), "medium");
  assert.equal(resolveListingView({ param: "garbage", cookie: "medium" }), "medium");
  assert.equal(resolveListingView({ param: "garbage", cookie: "garbage" }), DEFAULT_LISTING_VIEW);
  assert.equal(DEFAULT_LISTING_VIEW, "large");
});

test("the product grid is 2/3/4, 3/4/5 and 4/5/6 across at phone/tablet/desktop", () => {
  assert.match(productGridClassName("large"), /\bgrid-cols-2 md:grid-cols-3 lg:grid-cols-4\b/);
  assert.match(productGridClassName("medium"), /\bgrid-cols-3 md:grid-cols-4 lg:grid-cols-5\b/);
  // The narrowest phones keep three: a fourth column would leave a card too narrow to read.
  assert.match(productGridClassName("small"), /\bgrid-cols-3 min-\[360px\]:grid-cols-4 md:grid-cols-5 lg:grid-cols-6\b/);
});

test("the collections grid keeps its large view at 1 across on a phone and 2 on desktop", () => {
  assert.match(collectionGridClassName("large"), /\bgrid-cols-1 md:grid-cols-2\b/);
  assert.match(collectionGridClassName("small"), /\bgrid-cols-3 md:grid-cols-4\b/);
});

test("the query string helpers read and write only `view`", () => {
  assert.equal(readListingViewParam("?view=small&page=2"), "small");
  assert.equal(readListingViewParam("?view=nope"), null);
  assert.equal(readListingViewParam(new URLSearchParams("sort=name-asc")), null);
  assert.equal(withListingViewParam("", "medium"), "?view=medium");
  assert.equal(withListingViewParam("?sort=name-asc&view=small", "large"), "?sort=name-asc&view=large");
});

test("the cookie lasts a year, site-wide, and is Secure only when asked", () => {
  const cookie = serializeListingViewCookie("small");
  assert.ok(cookie.startsWith(`${LISTING_VIEW_COOKIE}=small;`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(serializeListingViewCookie("small", { secure: true }), /Secure/);
});

test("the proxy plan remembers a view named in the URL, and only then", () => {
  const named = planListingViewRequest({ method: "GET", search: "?view=small", cookie: "large" });
  assert.equal(named.view, "small");
  assert.ok(named.setCookie?.startsWith(`${LISTING_VIEW_COOKIE}=small;`));

  const same = planListingViewRequest({ method: "GET", search: "?view=small", cookie: "small" });
  assert.equal(same.view, "small");
  assert.equal(same.setCookie, null);

  const cookieOnly = planListingViewRequest({ method: "GET", search: "", cookie: "medium" });
  assert.deepEqual(cookieOnly, { view: "medium", setCookie: null });

  const post = planListingViewRequest({ method: "POST", search: "?view=small", cookie: undefined });
  assert.equal(post.view, "small");
  assert.equal(post.setCookie, null);

  const junk = planListingViewRequest({ method: "GET", search: "?view=huge", cookie: "medium" });
  assert.deepEqual(junk, { view: "medium", setCookie: null });
});

test("image `sizes` follow the columns each view draws, not the large view's", () => {
  // What a 390px phone is asked for: large 2 across (50vw), medium 3 (34vw), small 4 (25vw).
  assert.match(productImageSizes("large"), /, 50vw$/);
  assert.match(productImageSizes("medium"), /, 34vw$/);
  assert.match(productImageSizes("small"), /\(min-width: 360px\) 25vw/);
  // 6 columns on a desktop is ~17vw, so 25vw would fetch a file a third too wide.
  assert.match(productImageSizes("small"), /\(min-width: 1024px\) 17vw/);
  assert.match(productImageSizes("small"), /\(min-width: 360px\) 25vw, 34vw$/);
  // Large keeps the desktop figure it always had, and fixes the tablet step (3 columns, not 2).
  assert.match(productImageSizes("large"), /^\(min-width: 1024px\) 25vw/);
  assert.match(DEFAULT_PRODUCT_IMAGE_SIZES, /1024px\) 25vw, 50vw$/);
  for (const view of LISTING_VIEWS) {
    assert.ok(collectionImageSizes(view).length > 0);
  }
  assert.equal(collectionImageSizes("large"), "(min-width: 768px) 50vw, 100vw");
});

test("the small and medium views never set text under 10px, or name and price under 12px", () => {
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf('Listing view ("kiểu xem")'));
  const sizes = [...block.matchAll(/(\.product-[a-z-]+)\s*\{[^}]*?font-size:\s*([\d.]+)(px|rem)/g)].map(
    ([, selector, value, unit]) => ({ selector: selector!, px: Number(value) * (unit === "rem" ? 16 : 1) }),
  );
  assert.ok(sizes.length >= 20, "the listing-view type steps are present");
  for (const { selector, px } of sizes) {
    assert.ok(px >= 10, `${selector} is ${px}px`);
    if (selector === ".product-title" || selector === ".product-price") assert.ok(px >= 12, `${selector} is ${px}px`);
  }
});
