import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Structural guarantees of the virtual try-on spec that are properties of the code's shape rather
 * than of any one function: nothing persists an image, no credential reaches the browser, and
 * try-on cannot reach commerce state. Source scans are crude on purpose — they fail loudly when
 * someone adds the import that would break the guarantee.
 */

const ROOT = resolve(import.meta.dirname, "../..");

function files(directory: string, keep: (name: string) => boolean = () => true): string[] {
  return readdirSync(join(ROOT, directory))
    .filter(keep)
    .map((name) => join(directory, name));
}

const SERVER_TRY_ON_FILES = [
  ...files("src/commerce", (name) => name.startsWith("try-on-")),
  ...files("src/integrations/vertex-try-on"),
  ...files("src/integrations/google-flow-try-on"),
  "src/integrations/try-on/config.ts",
  "src/operations/try-on-observability.ts",
  "src/app/api/try-on/route.ts",
];
const CLIENT_TRY_ON_FILES = [
  "src/components/brand/try-on-dialog.tsx",
  "src/components/headless/use-try-on.ts",
  "src/components/headless/try-on-model.ts",
  "src/components/headless/try-on-disclosure.ts",
];
const FLOW_WORKER_FILES = [
  "services/flow-worker/flow_worker/policy.py",
  "services/flow-worker/flow_worker/server.py",
];
const ALL_TRY_ON_FILES = [...SERVER_TRY_ON_FILES, ...CLIENT_TRY_ON_FILES];

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The code with comments removed, so prose explaining a rule cannot trip the rule. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the scan covers the try-on files (guards against a silently empty glob)", () => {
  assert.ok(SERVER_TRY_ON_FILES.length >= 12, SERVER_TRY_ON_FILES.join(","));
  assert.equal(FLOW_WORKER_FILES.length, 2);
});

test("no try-on code has a durable persistence path", () => {
  const forbidden: Array<[RegExp, string]> = [
    [/from "node:fs|from "fs"|from "node:fs\/promises"|require\("fs"\)/, "filesystem"],
    [/writeFile|createWriteStream|appendFile|mkdtemp|tmpdir/, "file writes"],
    [/@google-cloud\/storage|gcsUri|storageUri/, "Cloud Storage"],
    [/prisma|PrismaClient|\$queryRaw|\$executeRaw/i, "database"],
    [/localStorage|sessionStorage|indexedDB|caches\.open|document\.cookie/, "browser storage"],
    [/console\.(log|info|debug|warn|error)/, "ad-hoc logging"],
  ];
  // The runtime wiring is the one file that legitimately reads (never writes) catalog data.
  const databaseExempt = new Set(["src/commerce/try-on-runtime.ts"]);
  for (const path of ALL_TRY_ON_FILES) {
    for (const [pattern, label] of forbidden) {
      if (label === "database" && databaseExempt.has(path)) continue;
      assert.doesNotMatch(code(path), pattern, `${path} must not use ${label}`);
    }
  }
});

test("Flow worker persistence is request-scoped; only the signed-in browser profile is durable", () => {
  const worker = code("services/flow-worker/flow_worker/server.py");
  const dockerfile = source("services/flow-worker/Dockerfile");
  const compose = source("deploy/vps/compose.yml");

  assert.match(worker, /TemporaryDirectory\(prefix="flow-try-on-"\)/);
  assert.match(worker, /db_path = root \/ "gflow\.db"/);
  assert.match(worker, /env\["GFLOW_CLI_DB_PATH"\] = str\(db_path\)/);
  assert.doesNotMatch(worker, /GFLOW_HOME\s*\/\s*["']gflow\.db["']/);

  // Non-generation gflow commands (auth status/login) also default to container-local /tmp,
  // never the persistent Chrome-profile volume.
  assert.match(dockerfile, /GFLOW_CLI_DB_PATH=\/tmp\/gflow-auth\.db/);
  assert.doesNotMatch(compose, /GFLOW_CLI_DB_PATH:\s*\/data\/gflow/);
});

test("the runtime wiring only reads the catalog: no write call on any Prisma model", () => {
  assert.doesNotMatch(
    code("src/commerce/try-on-runtime.ts"),
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/,
  );
});

test("storageUri is never set: the request builder does not mention it", () => {
  assert.doesNotMatch(code("src/integrations/vertex-try-on/client.ts"), /storageUri|gcsUri/);
});

test("credentials stay server-side: no client file imports provider, auth or runtime modules", () => {
  for (const path of CLIENT_TRY_ON_FILES) {
    const text = code(path);
    assert.doesNotMatch(text, /vertex-try-on|google-auth-library|try-on-runtime|process\.env/, path);
    // The only server-side module a client file may reach is the constants-only policy file.
    const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
    for (const specifier of specifiers.filter((value) => /commerce|integrations|operations|\/db\//.test(value))) {
      assert.match(specifier, /try-on-policy(\.ts)?$/, `${path} imports ${specifier}`);
    }
  }
  for (const path of CLIENT_TRY_ON_FILES.filter((file) => file.endsWith("try-on-dialog.tsx") || file.endsWith("use-try-on.ts"))) {
    assert.match(code(path), /^"use client";/m, path);
  }
  assert.doesNotMatch(code("src/commerce/try-on-policy.ts"), /^import\s/m);
});

test("no browser-exposed or build-time configuration carries Google credentials or the try-on switch", () => {
  const nextConfig = source("next.config.mjs");
  assert.doesNotMatch(nextConfig, /GOOGLE_|LA_TRY_ON|aiplatform|vertex/i);
  for (const path of [".env.example", "deploy/vps/env.example"]) {
    const text = source(path);
    assert.doesNotMatch(text, /NEXT_PUBLIC_[A-Z_]*(GOOGLE|TRY_ON|VERTEX)/, path);
    // Placeholders only: no private key or token material may be committed.
    assert.doesNotMatch(text, /BEGIN (RSA |EC )?PRIVATE KEY|"private_key"|ya29\./, path);
  }
});

test("the try-on service cannot reach commerce state", () => {
  const imports = [...code("src/commerce/try-on-service.ts").matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
  for (const specifier of imports) {
    assert.doesNotMatch(
      specifier,
      /cart|checkout|purchase|order|variant|capacity|promotion|prisma|db\//i,
      `try-on-service imports ${specifier}`,
    );
  }
});

test("the PDP renders try-on from a server-decided prop and never from the browser", () => {
  assert.doesNotMatch(code("src/components/brand/product-detail.tsx"), /process\.env|readTryOnConfig/);
  assert.match(code("src/routes/product.ts"), /resolveProductTryOn/);
});
