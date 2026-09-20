/**
 * W15b signal 1 — release:check search-origin wiring.
 *
 * This spawns `scripts/release-readiness.ts` — the exact entry point behind `pnpm release:check` —
 * rather than importing the validator, because the deployment command is the contract under test.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { readProjectConfig } from "../../src/config/project-config.ts";
import { fileURLToPath } from "node:url";

const releaseCheckScript = fileURLToPath(
  new URL("../../scripts/release-readiness.ts", import.meta.url),
);

import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
} from "../../src/commerce/storefront-origin.ts";

const TEMPORARY_PRODUCTION_HOST = LEGACY_TEMPORARY_STOREFRONT_HOST;
const OFFICIAL_PRODUCTION_HOST = OFFICIAL_PRODUCTION_STOREFRONT_HOST;
const DATABASE_PASSWORD = "super-secret-release-password";

/**
 * Constructed rather than inherited. An ambient `APP_DOMAIN` or `SEARCH_INDEXING_ENABLED` from a
 * developer's shell would silently decide the outcome of the very assertion this test exists for.
 */
function releaseEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "",
    DATABASE_URL: `postgresql://release_user:${DATABASE_PASSWORD}@db.internal:5432/${readProjectConfig().databaseName}`,
    BETTER_AUTH_SECRET: "release-only-secret-0123456789abcdef",
    BETTER_AUTH_IP_HEADER: "cf-connecting-ip",
    PANCAKE_API_KEY: "super-secret-pancake-key",
    PANCAKE_SHOP_ID: "920007",
    RESEND_API_KEY: "re_ci-only-contact-key",
    LA_MERCHANT_TARGET_COUNTRY: "VN",
    LA_MERCHANT_CONTENT_LANGUAGE: "vi",
    LA_MERCHANT_CURRENCY: "VND",
    ...overrides,
  };
}

function runReleaseCheck(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", releaseCheckScript],
    { env: releaseEnvironment(overrides), encoding: "utf8" },
  );
}

test("W15b release:check fails closed when the temporary production host requests indexing", () => {
  const result = runReleaseCheck({
    APP_DOMAIN: TEMPORARY_PRODUCTION_HOST,
    BETTER_AUTH_URL: `https://${TEMPORARY_PRODUCTION_HOST}`,
    SEARCH_INDEXING_ENABLED: "true",
  });

  assert.notEqual(result.status, 0, `release:check must fail for the temporary host\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Search indexing cannot be enabled on the temporary production storefront origin/,
    `release:check must fail for the indexing reason, not incidentally\n${result.stderr}`,
  );
  assert.equal(result.stdout.includes('"ok": true'), false, "a refused preflight must print no success summary");
  assert.equal(result.stdout.includes('"ok":true'), false, "a refused preflight must print no success summary");
});

test("W15b the refused release:check leaks no credentials in its failure output", () => {
  const result = runReleaseCheck({
    APP_DOMAIN: TEMPORARY_PRODUCTION_HOST,
    BETTER_AUTH_URL: `https://${TEMPORARY_PRODUCTION_HOST}`,
    SEARCH_INDEXING_ENABLED: "true",
  });

  const output = `${result.stdout}${result.stderr}`;
  for (const secret of [
    DATABASE_PASSWORD,
    "super-secret-pancake-key",
    "release-only-secret-0123456789abcdef",
    "re_ci-only-contact-key",
  ]) {
    assert.equal(output.includes(secret), false, `release:check output must not echo ${secret.slice(0, 12)}…`);
  }
});

test("W15b the legacy temporary host still passes preflight while indexing stays disabled", () => {
  const result = runReleaseCheck({
    APP_DOMAIN: TEMPORARY_PRODUCTION_HOST,
    BETTER_AUTH_URL: `https://${TEMPORARY_PRODUCTION_HOST}`,
    SEARCH_INDEXING_ENABLED: "false",
  });

  assert.equal(result.status, 0, `the temporary host must still deploy with indexing off\n${result.stderr}`);
  assert.match(result.stdout, /"searchIndexingEnabled":\s*false/);
});

test("permanent-domain release preflight accepts the official host with indexing disabled", () => {
  const result = runReleaseCheck({
    APP_DOMAIN: OFFICIAL_PRODUCTION_HOST,
    BETTER_AUTH_URL: `https://${OFFICIAL_PRODUCTION_HOST}`,
    SEARCH_INDEXING_ENABLED: "false",
  });

  assert.equal(result.status, 0, `official permanent host must pass with indexing off\n${result.stderr}`);
  assert.match(result.stdout, /"searchIndexingEnabled":\s*false/);
});

test("permanent-domain release preflight admits indexing only for the official host", () => {
  const official = runReleaseCheck({
    APP_DOMAIN: OFFICIAL_PRODUCTION_HOST,
    BETTER_AUTH_URL: `https://${OFFICIAL_PRODUCTION_HOST}`,
    SEARCH_INDEXING_ENABLED: "true",
  });
  assert.equal(official.status, 0, `official permanent host must be eligible for Gate S\n${official.stderr}`);
  assert.match(official.stdout, /"searchIndexingEnabled":\s*true/);

  const unapproved = runReleaseCheck({
    APP_DOMAIN: "shop.example.com",
    BETTER_AUTH_URL: "https://shop.example.com",
    SEARCH_INDEXING_ENABLED: "true",
  });
  assert.notEqual(unapproved.status, 0);
  assert.match(unapproved.stderr, /approved permanent storefront origin/);
});
