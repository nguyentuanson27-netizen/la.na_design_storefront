import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  checkModuleBoundary,
  collectModuleEdges,
  isInside,
  readCompilerOptions,
  resolveSpecifier,
  storefrontPagePolicy,
  type BoundaryPolicy,
} from "../../src/routes/boundary-verifier.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/route-boundary");
const COMPILER_OPTIONS = readCompilerOptions(REPO_ROOT);

/**
 * Fixtures stand in for `src/app`: the engine is the thing under test, so the policy handed to it
 * points its page root at the fixture directory. The real five-root policy is asserted separately,
 * below, so this substitution cannot quietly weaken what ships.
 */
function policyFor(fixtureDir: string): BoundaryPolicy {
  const real = storefrontPagePolicy(REPO_ROOT);
  return {
    ...real,
    sourceRoots: [
      path.join(FIXTURES, fixtureDir),
      ...real.sourceRoots.filter((root) => root !== path.resolve(REPO_ROOT, "src/app")),
    ],
  };
}

function check(fixtureDir: string, file: string) {
  const fileName = path.join(FIXTURES, fixtureDir, file);
  return checkModuleBoundary({
    fileName,
    source: readFileSync(fileName, "utf8"),
    compilerOptions: COMPILER_OPTIONS,
    policy: policyFor(fixtureDir),
  });
}

/* ------------------------------------------------------------- negative matrix */

const NEGATIVE_EXPECTATIONS: Record<string, string> = {
  "alias-core.ts": "source-root",
  "alias-db.ts": "source-root",
  "alias-integration.ts": "source-root",
  "relative-core.ts": "source-root",
  "prefix-escape.ts": "source-root",
  "package-prisma.ts": "external-specifier",
  "package-pg.ts": "external-specifier",
  "next-headers.ts": "external-specifier",
  "next-server.ts": "external-specifier",
  "next-cache.ts": "external-specifier",
  "direct-commerce-component.ts": "source-root",
  "direct-commerce-checkout.ts": "source-root",
  "direct-account-component.ts": "source-root",
  "dynamic-template-interpolated.ts": "dynamic-specifier",
  "dynamic-expression.ts": "dynamic-specifier",
  "side-effect-import.ts": "source-root",
  "re-export.ts": "source-root",
  "export-star.ts": "source-root",
  "export-star-as.ts": "source-root",
  "unresolvable.ts": "unresolvable",
};

for (const [file, expectedCode] of Object.entries(NEGATIVE_EXPECTATIONS)) {
  test(`negative: ${file} is rejected with ${expectedCode}`, () => {
    const violations = check("negative", file);
    assert.ok(violations.length > 0, `${file} must be rejected`);
    assert.ok(
      violations.some((v) => v.code === expectedCode),
      `${file} should report ${expectedCode}, got ${violations.map((v) => v.code).join(", ")}`,
    );
  });
}

test("the negative matrix covers every fixture on disk, so a new one cannot be forgotten", () => {
  const onDisk = readdirSync(path.join(FIXTURES, "negative")).sort();
  assert.deepEqual(onDisk, Object.keys(NEGATIVE_EXPECTATIONS).sort());
});

/* ------------------------------------------------------------- positive matrix */

for (const file of [
  "allowed-internal.ts",
  "allowed-presentation.tsx",
  "allowed-relative.ts",
  "allowed-dynamic-static.ts",
  "allowed-side-effect.ts",
  "allowed-re-export.ts",
]) {
  test(`positive: ${file} passes`, () => {
    const violations = check("positive", file);
    assert.deepEqual(
      violations.map((v) => v.message),
      [],
      `${file} must be accepted`,
    );
  });
}

/* --------------------------------------------------------------- edge collection */

test("every module edge shape is collected, including the ones that bind nothing", () => {
  const source = `
    import a from "one";
    import "two";
    import { b } from "three";
    export { c } from "four";
    export * from "five";
    export * as ns from "six";
    const p = import("seven");
    const q = import(\`eight\`);
    const r = import(variable);
    const s = import(\`nine/\${name}\`);
  `;
  const sf = ts.createSourceFile("edges.ts", source, ts.ScriptTarget.Latest, true);
  const edges = collectModuleEdges(sf);

  assert.deepEqual(
    edges.map((e) => [e.kind, e.specifier]),
    [
      ["import", "one"],
      ["side-effect-import", "two"],
      ["import", "three"],
      ["re-export", "four"],
      ["export-star", "five"],
      ["re-export", "six"],
      ["dynamic-import", "seven"],
      ["dynamic-import", "eight"],
      // Both computed forms come back as null, which the checker turns into a violation.
      ["dynamic-import", null],
      ["dynamic-import", null],
    ],
  );
});

/* ------------------------------------------------------------------- containment */

test("containment rejects a sibling directory that merely shares a prefix", () => {
  const app = path.resolve(REPO_ROOT, "src/app");

  assert.equal(isInside(app, path.resolve(REPO_ROOT, "src/app/page.tsx")), true);
  assert.equal(isInside(app, app), true);
  assert.equal(isInside(app, path.resolve(REPO_ROOT, "src/app/shop/[slug]/page.tsx")), true);

  // The whole reason for path.relative over startsWith: these share the string prefix "src/app".
  assert.equal(isInside(app, path.resolve(REPO_ROOT, "src/app2/foo.ts")), false);
  assert.equal(isInside(app, path.resolve(REPO_ROOT, "src/application/foo.ts")), false);
  assert.equal(isInside(app, path.resolve(REPO_ROOT, "src/commerce/foo.ts")), false);
});

/* ------------------------------------------------------------------- real policy */

test("the shipped policy lists exactly the five allowed source roots", () => {
  const policy = storefrontPagePolicy(REPO_ROOT);

  assert.deepEqual(
    policy.sourceRoots.map((root) => path.relative(REPO_ROOT, root).split(path.sep).join("/")),
    ["src/app", "src/routes", "src/brand", "src/components/brand", "src/components/headless"],
  );
});

test("the two roots Phase D still has to create are allowed by the policy already", () => {
  // `src/components/brand` and `src/components/headless` do not exist yet -- Phase D/E creates them
  // when CartLineControls and AccountAuthPanel are split. Their fixtures cannot resolve until then,
  // so the policy is checked directly rather than pretending a Phase D file into existence here.
  const policy = storefrontPagePolicy(REPO_ROOT);

  for (const root of ["src/components/brand", "src/components/headless"]) {
    assert.ok(
      policy.sourceRoots.some((allowed) =>
        isInside(allowed, path.resolve(REPO_ROOT, `${root}/example.tsx`)),
      ),
      `${root} must already be allowed`,
    );
  }

  // The transitional roots stay out, so migration cannot be made to pass by widening the allowlist.
  for (const root of ["src/components/commerce", "src/components/account"]) {
    assert.equal(
      policy.sourceRoots.some((allowed) =>
        isInside(allowed, path.resolve(REPO_ROOT, `${root}/example.tsx`)),
      ),
      false,
      `${root} must not be allowed`,
    );
  }
});

test("the external allowlist is exact and does not collapse to package roots", () => {
  const { externalSpecifiers } = storefrontPagePolicy(REPO_ROOT);

  assert.deepEqual([...externalSpecifiers].sort(), [
    "next",
    "next/image",
    "next/link",
    "react",
    "react-dom",
  ]);

  // `next` being allowed must not admit the request-state APIs underneath it.
  for (const denied of ["next/headers", "next/server", "next/cache", "next/navigation"]) {
    assert.equal(externalSpecifiers.has(denied), false, `${denied} must not be allowed`);
  }
});

/* --------------------------------------------------------------------- resolution */

test("resolution goes through TypeScript, using the project's own alias and extension rules", () => {
  const from = path.join(REPO_ROOT, "src/app/page.tsx");

  // `@/*` is not special-cased here; it works because tsconfig `paths` says so.
  assert.equal(
    resolveSpecifier("@/routes/manifest", from, COMPILER_OPTIONS),
    path.join(REPO_ROOT, "src/routes/manifest.ts"),
  );
  assert.equal(
    resolveSpecifier("@/routes/core", from, COMPILER_OPTIONS),
    path.join(REPO_ROOT, "src/routes/core.tsx"),
    "the .tsx extension is resolved without being named",
  );
  assert.equal(resolveSpecifier("@/nope/missing", from, COMPILER_OPTIONS), null);
});

test("the fixture-backed checker is not vacuous: the same engine accepts and rejects", () => {
  // If the engine returned violations for everything, every negative test above would pass while
  // the verifier was useless. The positive matrix is what rules that out, and this pins the pairing.
  assert.ok(check("negative", "alias-db.ts").length > 0);
  assert.equal(check("positive", "allowed-internal.ts").length, 0);
});

/* ---------------------------------------------- scope: engine only, no live scan */

test("the live scan is off because the tree is not migrated yet, not because it would pass", () => {
  // This records why Phase C stops at the engine. The gate goes live at T32B, after the route
  // migrations; turning it on now would fail, and the only way to make it pass would be mass-editing
  // storefront pages, which is explicitly not this PR's job.
  //
  // Asserting that the unmigrated tree *does* violate the policy is worth more than asserting the
  // scan is absent: if this ever goes green on its own, the migration is done and T32B is unblocked.
  const page = path.join(REPO_ROOT, "src/app/page.tsx");
  const violations = checkModuleBoundary({
    fileName: page,
    source: readFileSync(page, "utf8"),
    compilerOptions: COMPILER_OPTIONS,
    policy: storefrontPagePolicy(REPO_ROOT),
  });

  assert.ok(
    violations.length > 0,
    "src/app/page.tsx is expected to still violate the boundary before migration",
  );
  assert.ok(
    violations.some((v) => v.specifier === "next/server"),
    `the known baseline case: connection() imported from next/server at the page layer. Got: ${violations
      .map((v) => v.specifier)
      .join(", ")}`,
  );
});
