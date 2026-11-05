import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LISTING_VIEW,
  LISTING_VIEW_COOKIE,
  collectionGridClassName,
  parseListingView,
  planListingViewRequest,
  productGridClassName,
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
  assert.match(productGridClassName("small"), /\bgrid-cols-4 md:grid-cols-5 lg:grid-cols-6\b/);
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
