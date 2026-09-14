import assert from "node:assert/strict";
import test from "node:test";

import { readProjectConfig, type ProjectConfig } from "../../src/config/project-config.ts";
import { assertIdentityMirrors } from "../../src/operations/identity-mirrors.ts";

const CONFIG: ProjectConfig = Object.freeze({
  projectSlug: "acme-women",
  databaseName: "acme_women",
  composeProjectName: "acme-women",
  productionDomain: "acme-women.vn",
});

function mirrors(overrides: Partial<Parameters<typeof assertIdentityMirrors>[0]> = {}) {
  return assertIdentityMirrors({
    config: CONFIG,
    databaseUrl: "postgresql://acme:secret@postgres:5432/acme_women",
    appDomain: "acme-women.vn",
    composeProject: "acme-women",
    ...overrides,
  });
}

test("a fully mirrored production environment passes", () => {
  assert.deepEqual(mirrors(), {
    databaseName: "acme_women",
    appDomainScope: "production",
    composeProjectChecked: true,
  });
});

test("a DATABASE_URL pointing at another brand's database stops the deployment", () => {
  assert.throws(
    () => mirrors({ databaseUrl: "postgresql://acme:secret@postgres:5432/other_brand" }),
    /DATABASE_URL[\s\S]*other_brand[\s\S]*acme_women/,
  );
});

test("a DATABASE_URL that merely prefixes the configured database is rejected", () => {
  assert.throws(
    () => mirrors({ databaseUrl: "postgresql://acme:secret@postgres:5432/acme_women_staging" }),
    /DATABASE_URL/,
  );
});

test("query parameters do not hide the database name", () => {
  assert.equal(
    mirrors({ databaseUrl: "postgresql://acme:secret@postgres:5432/acme_women?schema=public" })
      .databaseName,
    "acme_women",
  );
  assert.throws(
    () => mirrors({ databaseUrl: "postgresql://acme:secret@postgres:5432/other?schema=acme_women" }),
    /DATABASE_URL/,
  );
});

test("a missing or malformed DATABASE_URL fails closed", () => {
  for (const databaseUrl of [undefined, "", "   ", "not-a-url", "postgresql://host:5432/"]) {
    assert.throws(
      () => mirrors({ databaseUrl }),
      /DATABASE_URL/,
      `${JSON.stringify(databaseUrl)} must fail closed`,
    );
  }
});

test("an APP_DOMAIN that is not the configured production domain stops the deployment", () => {
  for (const appDomain of [
    "acme-women.com",
    "www.acme-women.vn",
    "acme-women.vn.attacker.example",
    "shop.example.test",
    "acme-women.vn:8443",
  ]) {
    assert.throws(
      () => mirrors({ appDomain }),
      /APP_DOMAIN/,
      `${appDomain} must fail closed`,
    );
  }
});

test("the local exception is explicit and covers only loopback hosts", () => {
  for (const appDomain of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3219"]) {
    assert.equal(
      mirrors({ appDomain }).appDomainScope,
      "local",
      `${appDomain} is a local development host`,
    );
  }
  // Not loopback, so no exception applies even though the name suggests one.
  assert.throws(() => mirrors({ appDomain: "local.acme-women.vn" }), /APP_DOMAIN/);
});

test("a missing APP_DOMAIN fails closed", () => {
  for (const appDomain of [undefined, "", "  "]) {
    assert.throws(() => mirrors({ appDomain }), /APP_DOMAIN/);
  }
});

test("a COMPOSE_PROJECT_NAME that drifts from the config stops the deployment", () => {
  assert.throws(() => mirrors({ composeProject: "other-brand" }), /COMPOSE_PROJECT_NAME/);
});

test("an absent COMPOSE_PROJECT_NAME reports that no compose mirror was checked", () => {
  for (const composeProject of [undefined, ""]) {
    assert.equal(mirrors({ composeProject }).composeProjectChecked, false);
  }
});

test("the committed baseline environment mirrors the committed identity", () => {
  const config = readProjectConfig();
  assert.deepEqual(
    assertIdentityMirrors({
      config,
      databaseUrl: `postgresql://user:pass@postgres:5432/${config.databaseName}`,
      appDomain: config.productionDomain,
      composeProject: config.composeProjectName,
    }),
    {
      databaseName: config.databaseName,
      appDomainScope: "production",
      composeProjectChecked: true,
    },
  );
});

test("an approved legacy host is accepted only when the caller names it", () => {
  assert.throws(() => mirrors({ appDomain: "legacy.acme-women.vn" }), /APP_DOMAIN/);
  assert.equal(
    mirrors({
      appDomain: "legacy.acme-women.vn",
      approvedLegacyDomains: ["legacy.acme-women.vn"],
    }).appDomainScope,
    "legacy",
  );
  // Naming one legacy host does not admit any other.
  assert.throws(
    () => mirrors({ appDomain: "other.example", approvedLegacyDomains: ["legacy.acme-women.vn"] }),
    /APP_DOMAIN/,
  );
});
