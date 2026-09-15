import assert from "node:assert/strict";
import test from "node:test";

import {
  readSearchExposure,
  validateSearchExposureForRelease,
} from "../../src/seo/search-exposure.ts";

import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../../src/commerce/storefront-origin.ts";

const OFFICIAL_PRODUCTION_DOMAIN = OFFICIAL_PRODUCTION_STOREFRONT_HOST;
const LEGACY_TEMPORARY_DOMAIN = LEGACY_TEMPORARY_STOREFRONT_HOST;

test("official permanent domain remains fail-closed until indexing is explicitly requested", () => {
  assert.deepEqual(
    readSearchExposure({
      APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN,
      SEARCH_INDEXING_ENABLED: "false",
    }),
    {
      origin: `https://${OFFICIAL_PRODUCTION_DOMAIN}`,
      indexingEnabled: false,
    },
  );
});

test("official permanent domain is the only public production host eligible for the indexing gate", () => {
  assert.deepEqual(
    validateSearchExposureForRelease({
      APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN,
      SEARCH_INDEXING_ENABLED: "true",
    }),
    {
      origin: `https://${OFFICIAL_PRODUCTION_DOMAIN}`,
      indexingEnabled: true,
    },
  );

  for (const appDomain of [
    `www.${OFFICIAL_PRODUCTION_DOMAIN}`,
    "shop.example.com",
    "www.laclothing.example",
    `${OFFICIAL_PRODUCTION_DOMAIN}.attacker.example`,
  ]) {
    assert.deepEqual(
      readSearchExposure({ APP_DOMAIN: appDomain, SEARCH_INDEXING_ENABLED: "true" }),
      { origin: `https://${appDomain}`, indexingEnabled: false },
      `${appDomain} must not become indexable merely because it is a valid public hostname`,
    );
    assert.throws(
      () =>
        validateSearchExposureForRelease({
          APP_DOMAIN: appDomain,
          SEARCH_INDEXING_ENABLED: "true",
        }),
      /approved permanent storefront origin/,
    );
  }
});

test("legacy temporary domain remains non-indexable after permanent-domain selection", () => {
  assert.equal(
    readSearchExposure({
      APP_DOMAIN: LEGACY_TEMPORARY_DOMAIN,
      SEARCH_INDEXING_ENABLED: "true",
    }).indexingEnabled,
    false,
  );

  assert.throws(
    () =>
      validateSearchExposureForRelease({
        APP_DOMAIN: LEGACY_TEMPORARY_DOMAIN,
        SEARCH_INDEXING_ENABLED: "true",
      }),
    /temporary production storefront origin/,
  );
});

test("request-controlled host data cannot substitute for the server-owned official domain", () => {
  const hostile = {
    APP_DOMAIN: "shop.example.com",
    SEARCH_INDEXING_ENABLED: "true",
    HOST: OFFICIAL_PRODUCTION_DOMAIN,
    "x-forwarded-host": OFFICIAL_PRODUCTION_DOMAIN,
    NEXT_PUBLIC_APP_DOMAIN: OFFICIAL_PRODUCTION_DOMAIN,
  } as const;

  assert.equal(readSearchExposure(hostile).indexingEnabled, false);
  assert.throws(
    () => validateSearchExposureForRelease(hostile),
    /approved permanent storefront origin/,
  );
});
