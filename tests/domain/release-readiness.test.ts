import assert from "node:assert/strict";
import test from "node:test";

import { readProjectConfig } from "../../src/config/project-config.ts";
import { validateReleaseEnvironment } from "../../src/operations/release-readiness.ts";

const PROJECT_CONFIG = readProjectConfig();

const validEnvironment = {
  DATABASE_URL: `postgresql://release_user:super-secret-password@db.internal:5432/${PROJECT_CONFIG.databaseName}`,
  APP_DOMAIN: PROJECT_CONFIG.productionDomain,
  SEARCH_INDEXING_ENABLED: "false",
  BETTER_AUTH_SECRET: "release-only-secret-0123456789abcdef",
  BETTER_AUTH_URL: `https://${PROJECT_CONFIG.productionDomain}`,
  BETTER_AUTH_IP_HEADER: "cf-connecting-ip",
  PANCAKE_API_KEY: "super-secret-pancake-key",
  PANCAKE_SHOP_ID: "920007",
  LA_SHIPPING_FEE_VND: "30000",
  LA_FREE_SHIPPING_SUBTOTAL_VND: "1000000",
  LA_FREE_SHIPPING_MIN_QUANTITY: "3",
} as const;

test("release preflight validates required server configuration without returning secrets", () => {
  const result = validateReleaseEnvironment(validEnvironment);

  assert.deepEqual(result, {
    databaseConfigured: true,
    storefrontOriginConfigured: true,
    searchIndexingEnabled: false,
    trackingMode: "disabled",
    trackingLoadsGoogleTagManager: false,
    merchantMarketStatus: "UNRESOLVED",
    authConfigured: true,
    trustedIpHeaderConfigured: true,
    pancakeConfigured: true,
    pancakeShopId: 920_007,
    shippingPolicy: {
      feeVnd: 30_000,
      freeShippingSubtotalVnd: 1_000_000,
      freeShippingMinQuantity: 3,
    },
    identityMirrors: {
      databaseName: PROJECT_CONFIG.databaseName,
      appDomainScope: "production",
      composeProjectChecked: false,
    },
  });

  const serialized = JSON.stringify(result);
  for (const sensitiveValue of [
    "release_user",
    "super-secret-password",
    validEnvironment.BETTER_AUTH_SECRET,
    validEnvironment.PANCAKE_API_KEY,
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false);
  }
});

test("release preflight rejects missing or non-PostgreSQL database URLs without echoing credentials", () => {
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, DATABASE_URL: undefined }),
    /DATABASE_URL must be configured/,
  );

  const secretUrl = `mysql://release_user:should-never-leak@db.internal/${PROJECT_CONFIG.databaseName}`;
  try {
    validateReleaseEnvironment({ ...validEnvironment, DATABASE_URL: secretUrl });
    assert.fail("expected invalid database URL to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /DATABASE_URL must use PostgreSQL/);
    assert.equal(message.includes("should-never-leak"), false);
  }
});

test("release preflight requires a safe server-owned storefront origin", () => {
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, APP_DOMAIN: undefined }),
    /APP_DOMAIN must be configured/,
  );

  const hostileDomain = "attacker.example/path?token=should-not-leak";
  try {
    validateReleaseEnvironment({ ...validEnvironment, APP_DOMAIN: hostileDomain });
    assert.fail("expected invalid APP_DOMAIN to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /APP_DOMAIN/);
    assert.equal(message.includes(hostileDomain), false);
    assert.equal(message.includes("should-not-leak"), false);
  }
});

test("release preflight requires Better Auth to use the server-owned storefront origin", () => {
  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        BETTER_AUTH_URL: `http://${PROJECT_CONFIG.productionDomain}`,
      }),
    /BETTER_AUTH_URL must use HTTPS/,
  );

  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        APP_DOMAIN: "la.lanadesign.vn",
      }),
    /BETTER_AUTH_URL must match APP_DOMAIN storefront origin/,
  );
});

test("release preflight requires explicit fail-closed search indexing configuration", () => {
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, SEARCH_INDEXING_ENABLED: undefined }),
    /SEARCH_INDEXING_ENABLED must be explicitly configured as true or false/,
  );

  const hostileFlag = "TRUE?token=should-not-leak";
  try {
    validateReleaseEnvironment({ ...validEnvironment, SEARCH_INDEXING_ENABLED: hostileFlag });
    assert.fail("expected invalid SEARCH_INDEXING_ENABLED to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /SEARCH_INDEXING_ENABLED/);
    assert.equal(message.includes(hostileFlag), false);
    assert.equal(message.includes("should-not-leak"), false);
  }

  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        APP_DOMAIN: "staging.lanadesign.vn",
        BETTER_AUTH_URL: "https://staging.lanadesign.vn",
        SEARCH_INDEXING_ENABLED: "true",
      }),
    /Search indexing cannot be enabled on staging or local storefront origins/,
  );

  const enabled = validateReleaseEnvironment({
    ...validEnvironment,
    SEARCH_INDEXING_ENABLED: "true",
  });
  assert.equal(enabled.searchIndexingEnabled, true);
});

test("T2 release preflight fails closed on malformed tracking configuration", () => {
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, LA_TRACKING_MODE: "enabled" }),
    /LA_TRACKING_MODE/,
  );
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, LA_TRACKING_MODE: "live" }),
    /LA_GTM_CONTAINER_ID/,
  );
});

test("T2 release preflight reports a requested tracking mode that still loads no GTM", () => {
  for (const mode of ["preview", "live"] as const) {
    const summary = validateReleaseEnvironment({
      ...validEnvironment,
      LA_TRACKING_MODE: mode,
      LA_GTM_CONTAINER_ID: "GTM-ABC123",
    });

    assert.equal(summary.trackingMode, mode);
    assert.equal(summary.trackingLoadsGoogleTagManager, false);
    assert.equal(
      JSON.stringify(summary).includes("GTM-ABC123"),
      false,
      "the release summary reports posture, not vendor configuration values",
    );
  }
});

test("release preflight delegates auth, Pancake and shipping validation fail closed", () => {
  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        BETTER_AUTH_URL: `http://${PROJECT_CONFIG.productionDomain}`,
      }),
    /BETTER_AUTH_URL must use HTTPS/,
  );
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, PANCAKE_SHOP_ID: "0" }),
    /PANCAKE_SHOP_ID must be a positive integer/,
  );
  assert.throws(
    () => validateReleaseEnvironment({ ...validEnvironment, LA_SHIPPING_FEE_VND: "30000.5" }),
    /LA_SHIPPING_FEE_VND/,
  );
});

test("release preflight reports approved Merchant market status when configured on the server", () => {
  const summary = validateReleaseEnvironment({
    ...validEnvironment,
    LA_MERCHANT_TARGET_COUNTRY: "VN",
    LA_MERCHANT_CONTENT_LANGUAGE: "vi",
    LA_MERCHANT_CURRENCY: "VND",
  });

  assert.equal(summary.merchantMarketStatus, "APPROVED");
});

test("release preflight refuses a DATABASE_URL that points at another project's database", () => {
  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        DATABASE_URL: "postgresql://release_user:super-secret-password@db.internal:5432/other_brand",
      }),
    /refusing to deploy against another project's database/,
  );
});

test("release preflight refuses a COMPOSE_PROJECT_NAME that drifts from the committed identity", () => {
  assert.throws(
    () =>
      validateReleaseEnvironment({ ...validEnvironment, COMPOSE_PROJECT_NAME: "other-brand" }),
    /COMPOSE_PROJECT_NAME/,
  );

  assert.equal(
    validateReleaseEnvironment({
      ...validEnvironment,
      COMPOSE_PROJECT_NAME: PROJECT_CONFIG.composeProjectName,
    }).identityMirrors.composeProjectChecked,
    true,
  );
});

test("release preflight refuses an APP_DOMAIN that is neither the production nor an approved host", () => {
  assert.throws(
    () =>
      validateReleaseEnvironment({
        ...validEnvironment,
        APP_DOMAIN: "shop.example.test",
        BETTER_AUTH_URL: "https://shop.example.test",
      }),
    /APP_DOMAIN/,
  );
});
