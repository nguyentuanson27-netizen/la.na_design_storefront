import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OFFICIAL_PRODUCTION_STOREFRONT_HOST } from "../../src/commerce/storefront-origin.ts";
import { PROJECT_CONFIG_PATH, readProjectConfig } from "../../src/config/project-config.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = readProjectConfig();

/**
 * Infrastructure that provisions or names the deployment. Every identity value here, the production
 * domain included, has to come from project.config.json.
 */
const INFRASTRUCTURE_PATHS = [".github", "deploy", "Dockerfile"] as const;

/**
 * Operations scripts. Scanned for the project, database and Compose names only. Several HTTP smoke
 * scripts still name the production domain directly to exercise indexing-enabled behavior; that is
 * storefront-origin coupling rather than deployment identity, and migrating it is not part of the
 * operations layer.
 */
const SCRIPT_PATHS = ["scripts"] as const;

/**
 * One identity value, in every spelling infrastructure tends to use it: the slug itself, the
 * database form with underscores, and the run-together form.
 */
function nameNeedles(): readonly string[] {
  const spellings = new Set<string>();
  for (const value of [CONFIG.projectSlug, CONFIG.databaseName, CONFIG.composeProjectName]) {
    spellings.add(value);
    spellings.add(value.replaceAll("-", "_"));
    spellings.add(value.replaceAll("_", "-"));
    spellings.add(value.replaceAll("-", "").replaceAll("_", ""));
  }
  return [...spellings];
}

function* walk(root: string): Generator<string> {
  const absolute = path.join(REPO_ROOT, root);
  if (statSync(absolute).isFile()) {
    yield root;
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.isFile()) yield child;
  }
}

function scanFor(roots: readonly string[], needles: readonly string[]): readonly string[] {
  const leaked: string[] = [];
  for (const root of roots) {
    for (const relative of walk(root)) {
      const contents = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      for (const [index, line] of contents.split("\n").entries()) {
        const hit = needles.find((needle) => line.toLowerCase().includes(needle.toLowerCase()));
        if (hit !== undefined) leaked.push(`${relative}:${index + 1}: ${hit}`);
      }
    }
  }
  return leaked;
}

const CONFIG_FILE = path.basename(fileURLToPath(PROJECT_CONFIG_PATH));

test("no deployment infrastructure hardcodes the project identity", () => {
  const leaked = scanFor(INFRASTRUCTURE_PATHS, [...nameNeedles(), CONFIG.productionDomain]);
  assert.deepEqual(leaked, [], `Project identity must come from ${CONFIG_FILE}:\n${leaked.join("\n")}`);
});

test("no operations script hardcodes the project, database or Compose name", () => {
  const leaked = scanFor(SCRIPT_PATHS, nameNeedles());
  assert.deepEqual(leaked, [], `Project identity must come from ${CONFIG_FILE}:\n${leaked.join("\n")}`);
});

test("every workflow that provisions the database loads identity from the committed config", () => {
  const workflows = path.join(REPO_ROOT, ".github", "workflows");
  const reusable = "./.github/workflows/project-identity.yml";

  for (const file of readdirSync(workflows)) {
    const contents = readFileSync(path.join(workflows, file), "utf8");
    if (!contents.includes("POSTGRES_DB") && !contents.includes("DATABASE_URL")) continue;
    assert.ok(
      contents.includes(reusable),
      `${file} provisions a database but does not load identity from ${reusable}`,
    );
  }
});

test("the reusable identity workflow fails closed on a missing key", () => {
  const contents = readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "project-identity.yml"),
    "utf8",
  );
  assert.match(contents, /set -euo pipefail/);
  for (const key of ["projectSlug", "databaseName", "composeProjectName", "productionDomain"]) {
    // `jq -e` exits non-zero on a missing or null key; the assignment lets `set -e` stop the job.
    assert.match(contents, new RegExp(`jq -er '\\.${key}'`));
  }
});

test("compose interpolates project identity and requires the real edge boundary", () => {
  const compose = readFileSync(path.join(REPO_ROOT, "deploy", "vps", "compose.yml"), "utf8");
  for (const required of [
    "name: ${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME}",
    "${PROJECT_SLUG:?set PROJECT_SLUG}",
    "APP_DOMAIN: ${APP_DOMAIN:?set APP_DOMAIN}",
    "EDGE_TRUSTED_PROXY_CIDR: ${EDGE_TRUSTED_PROXY_CIDR:?set EDGE_TRUSTED_PROXY_CIDR}",
    "name: ${EDGE_NETWORK_NAME:?set EDGE_NETWORK_NAME}",
  ]) {
    assert.ok(compose.includes(required), `compose.yml must contain ${required}`);
  }
});

test("the deploy env example carries runtime controls and secrets, never duplicated project identity", () => {
  const envExample = readFileSync(path.join(REPO_ROOT, "deploy", "vps", "env.example"), "utf8");
  const assignments = envExample
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));

  for (const identityKey of ["APP_DOMAIN", "BETTER_AUTH_URL", "POSTGRES_DB", "COMPOSE_PROJECT_NAME"]) {
    assert.ok(
      !assignments.includes(identityKey),
      `${identityKey} is project identity and must come from project.config.json, not env.example`,
    );
  }

  for (const requiredKey of [
    "DEPLOY_TARGET",
    "BETTER_AUTH_SECRET",
    "POSTGRES_PASSWORD",
    "DATABASE_URL",
    "RESEND_API_KEY",
    "EDGE_NETWORK_NAME",
    "EDGE_TRUSTED_PROXY_CIDR",
  ]) {
    assert.ok(assignments.includes(requiredKey), `${requiredKey} must stay in env.example`);
  }
  assert.match(envExample, /BETTER_AUTH_SECRET=REPLACE_ME_/);
});

test("deployment target is explicit and temporary maps only to the approved noindex host", () => {
  const script = "source deploy/vps/project-identity.sh; printf '%s|%s|%s' \"$DEPLOY_TARGET\" \"$APP_DOMAIN\" \"$BETTER_AUTH_URL\"";

  const temporary = execFileSync("bash", ["-lc", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, DEPLOY_TARGET: "temporary" },
    encoding: "utf8",
  });
  assert.equal(
    temporary,
    "temporary|la.lanadesign.vn|https://la.lanadesign.vn",
  );

  const production = execFileSync("bash", ["-lc", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, DEPLOY_TARGET: "production" },
    encoding: "utf8",
  });
  assert.equal(
    production,
    `production|${CONFIG.productionDomain}|https://${CONFIG.productionDomain}`,
  );

  const invalid = spawnSync("bash", ["-lc", "source deploy/vps/project-identity.sh"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DEPLOY_TARGET: "other" },
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /DEPLOY_TARGET/);
});

test("Caddy trusts only the explicitly supplied edge proxy range", () => {
  const caddy = readFileSync(path.join(REPO_ROOT, "deploy", "vps", "Caddyfile"), "utf8");
  assert.match(caddy, /trusted_proxies static \{\$EDGE_TRUSTED_PROXY_CIDR\}/);
  assert.equal(caddy.includes("192.0.2.1/32"), false);
});

test("the storefront origin constant mirrors the committed production domain", () => {
  // The one copy of the domain that lives in application code rather than infrastructure.
  assert.equal(OFFICIAL_PRODUCTION_STOREFRONT_HOST, CONFIG.productionDomain);
});
