import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PROJECT_CONFIG_PATH,
  parseProjectConfig,
  readProjectConfig,
  type ProjectConfig,
} from "../../src/config/project-config.ts";

const VALID: ProjectConfig = {
  projectSlug: "acme-women",
  databaseName: "acme_women",
  composeProjectName: "acme-women",
  productionDomain: "acme-women.vn",
};

function withField<K extends keyof ProjectConfig>(key: K, value: unknown): Record<string, unknown> {
  return { ...VALID, [key]: value };
}

test("the committed project config is plain JSON and parses through the validator", () => {
  const raw = readFileSync(fileURLToPath(PROJECT_CONFIG_PATH), "utf8");
  // Plain JSON, not JSONC: a comment would make JSON.parse throw.
  const parsed: unknown = JSON.parse(raw);
  assert.deepEqual(readProjectConfig(), parseProjectConfig(parsed));
});

test("the committed project config keeps the baseline brand identity", () => {
  assert.deepEqual(readProjectConfig(), {
    projectSlug: "la-clothing",
    databaseName: "la_clothing",
    composeProjectName: "la-clothing",
    productionDomain: "www.lafashion.asia",
  });
});

test("the committed project config carries no secrets", () => {
  const raw = readFileSync(fileURLToPath(PROJECT_CONFIG_PATH), "utf8");
  for (const forbidden of ["SECRET", "secret", "PASSWORD", "password", "API_KEY", "apiKey", "TOKEN", "token"]) {
    assert.ok(
      !raw.includes(forbidden),
      `project.config.json must never carry secrets, found ${forbidden}`,
    );
  }
});

test("a valid identity object parses into a frozen config", () => {
  const config = parseProjectConfig(structuredClone(VALID));
  assert.deepEqual(config, VALID);
  assert.ok(Object.isFrozen(config));
});

test("a non-object document is rejected", () => {
  for (const raw of [null, undefined, "acme", 7, true, [], [VALID]]) {
    assert.throws(() => parseProjectConfig(raw), /must be a JSON object/);
  }
});

test("every identity field is required", () => {
  for (const key of Object.keys(VALID) as (keyof ProjectConfig)[]) {
    const incomplete: Record<string, unknown> = { ...VALID };
    delete incomplete[key];
    assert.throws(
      () => parseProjectConfig(incomplete),
      new RegExp(key),
      `missing ${key} must fail closed`,
    );
  }
});

test("null, blank and non-string identity values are rejected", () => {
  for (const key of Object.keys(VALID) as (keyof ProjectConfig)[]) {
    for (const value of [null, undefined, "", "   ", 7, true, {}, []]) {
      assert.throws(
        () => parseProjectConfig(withField(key, value)),
        new RegExp(key),
        `${key}=${JSON.stringify(value)} must fail closed`,
      );
    }
  }
});

test("unknown keys are rejected so a typo cannot silently drift", () => {
  assert.throws(
    () => parseProjectConfig({ ...VALID, dbName: "acme_women" }),
    /unknown key/i,
  );
});

test("projectSlug follows the image/route slug shape", () => {
  for (const value of ["acme", "a-b", "la-clothing", "a".repeat(31)]) {
    assert.equal(parseProjectConfig(withField("projectSlug", value)).projectSlug, value);
  }
  for (const value of [
    "ab", // shorter than three characters
    "1acme", // must start with a letter
    "-acme",
    "acme_women", // underscores belong to the database name only
    "acme.women",
    "a".repeat(32), // longer than the 31 character bound
    "Acme-Women",
  ]) {
    assert.throws(
      () => parseProjectConfig(withField("projectSlug", value)),
      /projectSlug/,
      `${value} must fail closed`,
    );
  }
});

test("databaseName rejects hyphens because PostgreSQL does not accept them unquoted", () => {
  assert.throws(() => parseProjectConfig(withField("databaseName", "acme-women")), /databaseName/);
  assert.equal(parseProjectConfig(withField("databaseName", "acme_women")).databaseName, "acme_women");
});

test("composeProjectName follows the Docker Compose project rules", () => {
  for (const value of ["acme-women", "0acme", "a_b", "ab"]) {
    assert.equal(
      parseProjectConfig(withField("composeProjectName", value)).composeProjectName,
      value,
    );
  }
  for (const value of ["a", "-acme", "_acme", "Acme", "acme.women", `a${"b".repeat(63)}`]) {
    assert.throws(
      () => parseProjectConfig(withField("composeProjectName", value)),
      /composeProjectName/,
      `${value} must fail closed`,
    );
  }
});

test("productionDomain rejects scheme, path and port", () => {
  for (const value of [
    "https://acme-women.vn",
    "acme-women.vn/",
    "acme-women.vn:443",
    "acme-women",
    "ACME-WOMEN.VN",
    "acme-women.v",
    "acme women.vn",
  ]) {
    assert.throws(
      () => parseProjectConfig(withField("productionDomain", value)),
      /productionDomain/,
      `${value} must fail closed`,
    );
  }
  for (const value of ["acme-women.vn", "www.lafashion.asia", "shop.acme-women.com"]) {
    assert.equal(
      parseProjectConfig(withField("productionDomain", value)).productionDomain,
      value,
    );
  }
});

test("readProjectConfig fails closed on malformed JSON", () => {
  assert.throws(
    () => readProjectConfig(new URL("../fixtures/project-config-malformed.json", import.meta.url)),
    /is not valid JSON/,
  );
});

test("readProjectConfig fails closed when the file is missing", () => {
  assert.throws(
    () => readProjectConfig(new URL("../fixtures/project-config-absent.json", import.meta.url)),
    /ENOENT|could not be read/,
  );
});
