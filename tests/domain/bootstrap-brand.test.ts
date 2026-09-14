import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bootstrapBrand } from "../../src/operations/bootstrap-brand.ts";

const VALID_IDENTITY = {
  projectSlug: "acme-women",
  databaseName: "acme_women",
  composeProjectName: "acme-women",
  productionDomain: "acme-women.vn",
};

const ENV_EXAMPLE = [
  "# Server-only secrets. Never commit real values.",
  'DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/la_clothing"',
  "",
  'APP_DOMAIN="localhost:3000"',
  'SEARCH_INDEXING_ENABLED="false"',
  'BETTER_AUTH_SECRET="replace-with-a-random-secret-at-least-32-characters"',
  'BETTER_AUTH_URL="http://localhost:3000"',
  'PANCAKE_API_KEY="replace-me"',
  'PANCAKE_SHOP_ID="replace-me"',
  'NEXT_PUBLIC_FACEBOOK_PIXEL_ID=""',
  'FACEBOOK_CAPI_ACCESS_TOKEN=""',
  "",
].join("\n");

const PACKAGE_JSON = `{
  "name": "website-la-clothing",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev"
  }
}
`;

type Sandbox = Readonly<{ root: string; cleanup: () => void }>;

function createSandbox(
  identity: unknown = VALID_IDENTITY,
  socialCardDirectory = "la-clothing-modern-menswear-social-card.png",
): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "bootstrap-brand-"));
  writeFileSync(path.join(root, "project.config.json"), `${JSON.stringify(identity, null, 2)}\n`);
  writeFileSync(path.join(root, ".env.example"), ENV_EXAMPLE);
  writeFileSync(path.join(root, "package.json"), PACKAGE_JSON);
  const appDir = path.join(root, "src", "app");
  mkdirSync(path.join(appDir, socialCardDirectory), { recursive: true });
  writeFileSync(
    path.join(appDir, socialCardDirectory, "route.ts"),
    "export const dynamic = 'force-static';\n",
  );
  mkdirSync(path.join(appDir, "shop"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readEnvLocal(root: string): string {
  return readFileSync(path.join(root, ".env.local"), "utf8");
}

function envValue(contents: string, key: string): string | undefined {
  for (const line of contents.split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return undefined;
}

test("bootstrap rewrites identity into a fresh .env.local", () => {
  const sandbox = createSandbox();
  try {
    const summary = bootstrapBrand({ rootDir: sandbox.root });
    const envLocal = readEnvLocal(sandbox.root);

    assert.equal(
      envValue(envLocal, "DATABASE_URL"),
      '"postgresql://USER:PASSWORD@HOST:5432/acme_women"',
    );
    assert.equal(summary.projectSlug, "acme-women");
  } finally {
    sandbox.cleanup();
  }
});

test("bootstrap never generates a secret", () => {
  const sandbox = createSandbox();
  try {
    bootstrapBrand({ rootDir: sandbox.root });
    const envLocal = readEnvLocal(sandbox.root);

    // Every secret has to reach the fork through a human, so each one must survive bootstrap
    // exactly as the example left it.
    for (const key of [
      "BETTER_AUTH_SECRET",
      "PANCAKE_API_KEY",
      "PANCAKE_SHOP_ID",
      "NEXT_PUBLIC_FACEBOOK_PIXEL_ID",
      "FACEBOOK_CAPI_ACCESS_TOKEN",
    ]) {
      assert.equal(
        envValue(envLocal, key),
        envValue(ENV_EXAMPLE, key),
        `${key} must stay exactly as .env.example left it`,
      );
    }

    // Only the database identity line may differ from the example at all.
    const exampleLines = ENV_EXAMPLE.split("\n");
    const generatedLines = envLocal.split("\n");
    assert.equal(generatedLines.length, exampleLines.length);
    for (const [index, line] of generatedLines.entries()) {
      if (line.startsWith("DATABASE_URL=")) continue;
      assert.equal(line, exampleLines[index], `line ${index + 1} must not be rewritten`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test("bootstrap renames the social card route folder and updates the package name", () => {
  const sandbox = createSandbox();
  try {
    const summary = bootstrapBrand({ rootDir: sandbox.root });

    const appEntries = readdirSync(path.join(sandbox.root, "src", "app"));
    assert.ok(appEntries.includes("acme-women-social-card.png"));
    assert.ok(!appEntries.includes("la-clothing-modern-menswear-social-card.png"));
    assert.equal(
      readFileSync(
        path.join(sandbox.root, "src", "app", "acme-women-social-card.png", "route.ts"),
        "utf8",
      ),
      "export const dynamic = 'force-static';\n",
    );
    assert.deepEqual(summary.socialCardRoute, {
      from: "la-clothing-modern-menswear-social-card.png",
      to: "acme-women-social-card.png",
      renamed: true,
    });

    const packageJson: unknown = JSON.parse(
      readFileSync(path.join(sandbox.root, "package.json"), "utf8"),
    );
    assert.equal((packageJson as { name: string }).name, "acme-women");
    assert.equal((packageJson as { version: string }).version, "0.1.0");
  } finally {
    sandbox.cleanup();
  }
});

test("bootstrap leaves an already-matching social card route alone", () => {
  const sandbox = createSandbox(VALID_IDENTITY, "acme-women-social-card.png");
  try {
    const summary = bootstrapBrand({ rootDir: sandbox.root });
    assert.deepEqual(summary.socialCardRoute, {
      from: "acme-women-social-card.png",
      to: "acme-women-social-card.png",
      renamed: false,
    });
  } finally {
    sandbox.cleanup();
  }
});

test("bootstrap prints the manual checklist it is not allowed to perform", () => {
  const sandbox = createSandbox();
  try {
    const summary = bootstrapBrand({ rootDir: sandbox.root });
    const checklist = summary.manualChecklist.join("\n");
    for (const owner of [
      "PANCAKE_API_KEY",
      "BETTER_AUTH_SECRET",
      "NEXT_PUBLIC_FACEBOOK_PIXEL_ID",
      "FACEBOOK_CAPI_ACCESS_TOKEN",
      "DNS",
      "SEARCH_INDEXING_ENABLED",
    ]) {
      assert.ok(checklist.includes(owner), `manual checklist must still name ${owner}`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test("an invalid identity fails closed before any write", () => {
  const sandbox = createSandbox({ ...VALID_IDENTITY, databaseName: "acme-women" });
  try {
    assert.throws(() => bootstrapBrand({ rootDir: sandbox.root }), /databaseName/);

    assert.throws(() => readEnvLocal(sandbox.root), /ENOENT/);
    assert.ok(
      readdirSync(path.join(sandbox.root, "src", "app")).includes(
        "la-clothing-modern-menswear-social-card.png",
      ),
    );
    assert.equal(readFileSync(path.join(sandbox.root, "package.json"), "utf8"), PACKAGE_JSON);
  } finally {
    sandbox.cleanup();
  }
});

test("bootstrap refuses to run twice over an existing .env.local", () => {
  const sandbox = createSandbox();
  try {
    bootstrapBrand({ rootDir: sandbox.root });
    writeFileSync(path.join(sandbox.root, ".env.local"), "DATABASE_URL=already-configured\n");

    assert.throws(() => bootstrapBrand({ rootDir: sandbox.root }), /\.env\.local already exists/);
    assert.equal(readEnvLocal(sandbox.root), "DATABASE_URL=already-configured\n");
  } finally {
    sandbox.cleanup();
  }
});

test("an ambiguous or missing social card route fails closed", () => {
  const missing = createSandbox();
  try {
    rmSync(path.join(missing.root, "src", "app", "la-clothing-modern-menswear-social-card.png"), {
      recursive: true,
    });
    assert.throws(() => bootstrapBrand({ rootDir: missing.root }), /social card route/i);
  } finally {
    missing.cleanup();
  }

  const ambiguous = createSandbox();
  try {
    mkdirSync(path.join(ambiguous.root, "src", "app", "second-social-card.png"));
    assert.throws(() => bootstrapBrand({ rootDir: ambiguous.root }), /social card route/i);
  } finally {
    ambiguous.cleanup();
  }
});
