import assert from "node:assert/strict";
import test from "node:test";

import {
  readSearchExposure,
  shouldNoIndexRequest,
  validateSearchExposureForRelease,
} from "../../src/seo/search-exposure.ts";
import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../../src/commerce/storefront-origin.ts";

const TEMPORARY_PRODUCTION_DOMAIN = LEGACY_TEMPORARY_STOREFRONT_HOST;
const OFFICIAL_PRODUCTION_DOMAIN = OFFICIAL_PRODUCTION_STOREFRONT_HOST;
const NEAR_MISS_DOMAIN = OFFICIAL_PRODUCTION_DOMAIN.startsWith("www.")
  ? OFFICIAL_PRODUCTION_DOMAIN.slice("www.".length)
  : `www.${OFFICIAL_PRODUCTION_DOMAIN}`;

const publicEnvironment = {
  APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN,
  SEARCH_INDEXING_ENABLED: "true",
} as const;

const CUTOVER_CATEGORY_PATHS = [
  "/ao-dai",
  "/ao-dai/cach-tan",
  "/ao-dai/tet",
  "/ao-dai/cuoi",
  "/ao-dai/4-ta",
  "/ao-dai/6-ta",
  "/set-do",
  "/set-do/set-vay",
  "/set-do/set-quan-ao",
  "/vay-dam",
  "/phu-kien",
] as const;

test("runtime search exposure defaults missing or malformed indexing requests to disabled", () => {
  assert.deepEqual(readSearchExposure({ APP_DOMAIN: "shop.example.com" }), {
    origin: "https://shop.example.com",
    indexingEnabled: false,
  });
  assert.deepEqual(
    readSearchExposure({ APP_DOMAIN: "shop.example.com", SEARCH_INDEXING_ENABLED: "TRUE" }),
    { origin: "https://shop.example.com", indexingEnabled: false },
  );
});

test("runtime search exposure never enables staging or local origins", () => {
  for (const appDomain of ["staging.lanadesign.vn", "localhost:3000", "127.0.0.1:3000"]) {
    const exposure = readSearchExposure({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "true" });
    assert.equal(exposure.indexingEnabled, false, `${appDomain} must remain non-indexable`);
  }
});

test("runtime search exposure can enable only the explicitly requested approved permanent origin", () => {
  assert.deepEqual(readSearchExposure(publicEnvironment), {
    origin: `https://${OFFICIAL_PRODUCTION_DOMAIN}`,
    indexingEnabled: true,
  });
});

test("release search exposure requires an explicit canonical boolean flag without echoing hostile input", () => {
  assert.throws(
    () => validateSearchExposureForRelease({ APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN }),
    /SEARCH_INDEXING_ENABLED must be explicitly configured as true or false/,
  );
  const malformed = "TRUE?value=invalid";
  try {
    validateSearchExposureForRelease({
      APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN,
      SEARCH_INDEXING_ENABLED: malformed,
    });
    assert.fail("expected malformed indexing flag to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /SEARCH_INDEXING_ENABLED/);
    assert.equal(message.includes(malformed), false);
  }
});

test("release search exposure blocks indexing on staging/local but accepts explicit false", () => {
  for (const appDomain of ["staging.lanadesign.vn", "localhost:3000", "127.0.0.1:3000"]) {
    assert.throws(
      () => validateSearchExposureForRelease({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "true" }),
      /Search indexing cannot be enabled on staging or local storefront origins/,
    );
    assert.deepEqual(
      validateSearchExposureForRelease({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "false" }),
      {
        origin: appDomain === "staging.lanadesign.vn" ? "https://staging.lanadesign.vn" : `http://${appDomain}`,
        indexingEnabled: false,
      },
    );
  }
});

test("release search exposure accepts explicit true on the approved permanent origin", () => {
  assert.deepEqual(validateSearchExposureForRelease(publicEnvironment), {
    origin: `https://${OFFICIAL_PRODUCTION_DOMAIN}`,
    indexingEnabled: true,
  });
});

test("noindex policy is global for HTML surfaces while indexing is disabled", () => {
  for (const pathname of ["/", "/shop", "/new-arrivals", "/ao-dai", "/sale", "/lookbook", "/cart"]) {
    assert.equal(shouldNoIndexRequest({ indexingEnabled: false, pathname, search: "" }), true);
  }
});

test("crawl-blocked API surfaces are outside the page-level noindex policy", () => {
  for (const indexingEnabled of [false, true]) {
    for (const pathname of ["/api", "/api/auth/session"]) {
      assert.equal(shouldNoIndexRequest({ indexingEnabled, pathname, search: "" }), false);
    }
  }
});

test("enabled noindex policy allows approved cutover routes and retires obsolete public paths", () => {
  for (const pathname of [
    "/",
    "/shop",
    "/shop/current-product",
    "/collections",
    "/collections/summer-shirts",
    "/new-arrivals",
    ...CUTOVER_CATEGORY_PATHS,
    "/sale",
    "/about",
    "/contact",
    "/returns",
    "/shipping",
    "/size-guide",
    "/feedback",
  ]) {
    assert.equal(
      shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "" }),
      false,
      `${pathname} should be eligible when indexing is enabled`,
    );
  }

  for (const pathname of [
    "/lookbook",
    "/flash-sale",
    "/admin",
    "/account",
    "/cart",
    "/checkout",
    "/track-order",
    "/search",
    "/unexpected",
    "/shop/a/nested-path",
    "/collections/a/nested-path",
    "/ao-dai/not-a-category",
    "/set-do/not-a-category",
  ]) {
    assert.equal(
      shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "" }),
      true,
      `${pathname} must remain noindex`,
    );
  }
});

test("category shells keep query state noindex while sale keeps canonical pagination", () => {
  for (const pathname of CUTOVER_CATEGORY_PATHS) {
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "?page=2" }), true);
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "?page=1" }), true);
  }
  assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname: "/sale", search: "?page=2" }), false);
  for (const pathname of ["/sale/uu-dai", "/sale/flash-sale"]) {
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "" }), false);
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "?page=2" }), false);
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname, search: "?page=1" }), true);
  }
  assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname: "/sale/other", search: "" }), true);
  assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname: "/sale", search: "?page=1" }), true);
  assert.equal(
    shouldNoIndexRequest({ indexingEnabled: true, pathname: "/sale", search: "?page=2&sort=name-asc" }),
    true,
  );
});

test("query state outside canonical pagination remains noindex", () => {
  for (const request of [
    { pathname: "/shop", search: "?sort=price-asc" },
    { pathname: "/shop/current-product", search: "?utm_source=test" },
    { pathname: "/collections/summer-shirts", search: "?color=black" },
    { pathname: "/ao-dai", search: "?sort=name-asc" },
    { pathname: "/sale", search: "?utm_medium=email" },
    { pathname: "/about", search: "?utm_medium=email" },
  ]) {
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, ...request }), true);
  }
});

test("G1 runtime search exposure never enables the temporary production origin", () => {
  assert.deepEqual(
    readSearchExposure({ APP_DOMAIN: TEMPORARY_PRODUCTION_DOMAIN, SEARCH_INDEXING_ENABLED: "true" }),
    { origin: `https://${TEMPORARY_PRODUCTION_DOMAIN}`, indexingEnabled: false },
  );
});

test("G1 release preflight hard-blocks indexing on the temporary production origin", () => {
  assert.throws(
    () => validateSearchExposureForRelease({ APP_DOMAIN: TEMPORARY_PRODUCTION_DOMAIN, SEARCH_INDEXING_ENABLED: "true" }),
    /Search indexing cannot be enabled on the temporary production storefront origin/,
  );
});

test("G1 keeps the approved temporary production origin serving buyer traffic with indexing disabled", () => {
  assert.deepEqual(
    validateSearchExposureForRelease({ APP_DOMAIN: TEMPORARY_PRODUCTION_DOMAIN, SEARCH_INDEXING_ENABLED: "false" }),
    { origin: `https://${TEMPORARY_PRODUCTION_DOMAIN}`, indexingEnabled: false },
  );
});

test("permanent-domain selection fails closed for every other public hostname", () => {
  for (const appDomain of [
    "laclothing.example",
    "www.laclothing.example",
    NEAR_MISS_DOMAIN,
    `www.${TEMPORARY_PRODUCTION_DOMAIN}`,
    `${TEMPORARY_PRODUCTION_DOMAIN}.attacker.example`,
    `${OFFICIAL_PRODUCTION_DOMAIN}.attacker.example`,
  ]) {
    assert.deepEqual(
      readSearchExposure({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "true" }),
      { origin: `https://${appDomain}`, indexingEnabled: false },
    );
    assert.throws(
      () => validateSearchExposureForRelease({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "true" }),
      /approved permanent storefront origin/,
    );
  }
});

test("G1 temporary-host enforcement reads only the server-owned storefront origin", () => {
  const clientControlled = {
    APP_DOMAIN: TEMPORARY_PRODUCTION_DOMAIN,
    SEARCH_INDEXING_ENABLED: "true",
    HOST: OFFICIAL_PRODUCTION_DOMAIN,
    "x-forwarded-host": OFFICIAL_PRODUCTION_DOMAIN,
    NEXT_PUBLIC_SEARCH_INDEXING_ENABLED: "true",
  } as const;
  assert.equal(readSearchExposure(clientControlled).indexingEnabled, false);
  assert.throws(
    () => validateSearchExposureForRelease(clientControlled),
    /Search indexing cannot be enabled on the temporary production storefront origin/,
  );
});
