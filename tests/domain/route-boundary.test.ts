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
} from "../support/boundary-verifier.ts";
import { STOREFRONT_ROUTES } from "../../src/routes/manifest.ts";

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
  "direct-analytics-component.ts": "source-root",
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

function normalizePath(filePath: string | null): string | null {
  return filePath ? path.resolve(filePath) : null;
}

test("resolution goes through TypeScript, using the project's own alias and extension rules", () => {
  const from = path.join(REPO_ROOT, "src/app/page.tsx");

  // `@/*` is not special-cased here; it works because tsconfig `paths` says so.
  assert.equal(
    normalizePath(resolveSpecifier("@/routes/manifest", from, COMPILER_OPTIONS)),
    normalizePath(path.join(REPO_ROOT, "src/routes/manifest.ts")),
  );
  assert.equal(
    normalizePath(resolveSpecifier("@/routes/core", from, COMPILER_OPTIONS)),
    normalizePath(path.join(REPO_ROOT, "src/routes/core.tsx")),
    "the .tsx extension is resolved without being named",
  );
  assert.equal(resolveSpecifier("@/nope/missing", from, COMPILER_OPTIONS), null);
});

test("normalizePath handles forward slashes and backslashes portably across platforms", () => {
  const forward = "src/routes/manifest.ts";
  const backward = "src\\routes\\manifest.ts";
  assert.equal(normalizePath(forward), normalizePath(backward));
  assert.equal(normalizePath(null), null);
});

test("the fixture-backed checker is not vacuous: the same engine accepts and rejects", () => {
  // If the engine returned violations for everything, every negative test above would pass while
  // the verifier was useless. The positive matrix is what rules that out, and this pins the pairing.
  assert.ok(check("negative", "alias-db.ts").length > 0);
  assert.equal(check("positive", "allowed-internal.ts").length, 0);
});

/* ------------------------------------------------------ the live gate (T32B) */

/**
 * Every `.ts` and `.tsx` under `src/app`, admin excluded.
 *
 * The whole tree is enumerated rather than the manifest's pages alone, so a new file cannot reach
 * the app directory without this test seeing it. What each file is held to is decided below.
 */
function appModulesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        // Admin does not change per brand, so it is outside the redraw and outside this contract
        // (spec 04 §8).
        if (entry.name === "admin") continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk("src/app");
  return found.sort();
}

/**
 * The App Router conventions that are server endpoints rather than markup, split by where Next
 * actually recognises each one.
 *
 * These exist to read the catalog and the SEO configuration and serialise it, so a policy forbidding
 * `@/db` and `@/seo` would forbid them from the only thing they are for. They also reach external
 * specifiers off the allowlist (`next/og`, `better-auth/next-js`), and wrapping those only to get
 * past the gate is indirection that buys nothing.
 *
 * The split matters because these conventions are not all shaped the same, and a single
 * "any file with this basename" rule would exempt modules Next would never treat as endpoints:
 *
 * - **Route handlers nest.** `route.ts` and `route.tsx` are handlers at any depth. Next resolves
 *   the `route` convention against `pageExtensions`, which defaults to `['tsx','ts','jsx','js']`,
 *   so `.tsx` is a handler too -- verified by building `src/app/probe-route-tsx/route.tsx` against
 *   Next 16.2.11, which listed it as `ƒ /probe-route-tsx`.
 * - **`sitemap` nests.** Next's own matcher is unanchored (`[\\/]sitemap…$`), so a sitemap may sit
 *   in any segment -- that is how `generateSitemaps` produces more than one.
 * - **`robots` does not.** Next's matcher is anchored (`^[\\/]robots…$`), so only `src/app/robots.ts`
 *   is the convention. A nested `robots.ts` is an ordinary module, and exempting one by basename
 *   would hand anything that name as a way past the gate.
 *
 * Route handlers are matched by filename rather than by path because the path is not stable:
 * `bootstrap:brand` renames `src/app/<slug>-social-card.png/` to match the fork's project slug (see
 * `src/operations/bootstrap-brand.ts`), so a listed path would name a directory that no longer
 * exists the moment someone forks this template -- failing the gate on a handler that is perfectly
 * valid. The filename is the convention and survives the rename.
 *
 * Approved in spec 04 §8.1, which is where the gate's scope is settled. This comment describes that
 * decision; it does not make it.
 */
const NESTED_ENDPOINT_FILENAMES: ReadonlySet<string> = new Set([
  "route.ts",
  "route.tsx",
  "sitemap.ts",
]);

/**
 * Conventions Next recognises only at the app root, as exact paths.
 *
 * `robots.ts` is here rather than among the filenames above because Next anchors it.
 *
 * The root layout used to be here too, as a scoped exemption spec 04 §8.1 approved for as long as
 * it read the search exposure and mounted the chrome itself. Plan Task 36 moved those into
 * `@/routes/site-chrome` and the brand layer, so the layout is wiring now and is scanned like every
 * other page-layer module. Nothing replaced it: this list is one entry long.
 */
const ROOT_ONLY_EXEMPT_PATHS: ReadonlySet<string> = new Set(["src/app/robots.ts"]);

/** Whether the live boundary scan holds this module to the page-layer policy. */
export function isPageLayerModule(relative: string): boolean {
  if (ROOT_ONLY_EXEMPT_PATHS.has(relative)) return false;
  return !NESTED_ENDPOINT_FILENAMES.has(path.basename(relative));
}

function liveViolations(relative: string) {
  const file = path.join(REPO_ROOT, relative);
  return checkModuleBoundary({
    fileName: file,
    source: readFileSync(file, "utf8"),
    compilerOptions: COMPILER_OPTIONS,
    policy: storefrontPagePolicy(REPO_ROOT),
  });
}

test("every page-layer module under src/app holds the boundary", () => {
  // Phase C built this engine and deliberately left the scan off, recording that the unmigrated tree
  // would fail it. Every storefront route is migrated now, so this is the live gate: it runs against
  // the repository, not fixtures, and a page reaching past the allowed roots fails here.
  const scanned = appModulesOnDisk().filter(isPageLayerModule);
  assert.ok(scanned.length >= STOREFRONT_ROUTES.length, "every declared route is in the scan");

  const offenders = scanned
    .map((relative) => ({ relative, violations: liveViolations(relative) }))
    .filter((entry) => entry.violations.length > 0);

  assert.deepEqual(
    offenders.map((entry) => `${entry.relative}: ${entry.violations.map((v) => v.message).join("; ")}`),
    [],
  );
});

test("only server endpoints are exempt from the scan", () => {
  // Without this, the classifier is a hole: a predicate that quietly widened would send the scan
  // green over a page it stopped looking at. Every file the scan skips must be one of the kinds.
  const skipped = appModulesOnDisk().filter((relative) => !isPageLayerModule(relative));

  for (const relative of skipped) {
    const nested = ["route.ts", "route.tsx", "sitemap.ts"].includes(path.basename(relative));
    const rootOnly = ["src/app/robots.ts"].includes(relative);
    assert.ok(
      nested || rootOnly,
      `${relative} is not a server endpoint, so it must hold the boundary`,
    );
  }

  // Every page module is in the scan, so an exemption cannot be smuggled in as one.
  for (const route of STOREFRONT_ROUTES) {
    assert.equal(isPageLayerModule(route.path), true, `${route.path} must be scanned`);
  }
});

test("a fork's renamed social-card route is still classified as a handler", () => {
  // `bootstrap:brand` renames `src/app/<slug>-social-card.png/` to match the fork's project slug.
  // A path-based exemption would name a directory that no longer exists, failing the gate on a
  // route handler that is perfectly valid. This is the regression that pins the structural rule.
  assert.equal(
    isPageLayerModule("src/app/la-clothing-modern-menswear-social-card.png/route.ts"),
    false,
    "the route handler this template ships with",
  );
  assert.equal(
    isPageLayerModule("src/app/acme-storefront-social-card.png/route.ts"),
    false,
    "the same handler after a fork renames it",
  );
  assert.equal(
    isPageLayerModule("src/app/anything/else/route.ts"),
    false,
    "any route handler, at any depth",
  );

  // The rule stays narrow: renaming a page into that directory does not exempt it.
  assert.equal(isPageLayerModule("src/app/acme-storefront-social-card.png/page.tsx"), true);
  assert.equal(isPageLayerModule("src/app/shop/layout.tsx"), true, "no layout is exempt");
});

test("each endpoint convention is exempt exactly where Next recognises it", () => {
  // Next does not shape these conventions the same way, and a single basename rule would hand a
  // nested module a name to hide behind. What is pinned here is the asymmetry itself.

  // `route` nests, and `.tsx` is a handler: Next resolves the convention against `pageExtensions`,
  // which defaults to ['tsx','ts','jsx','js']. Verified by building src/app/probe-route-tsx/route.tsx
  // against Next 16.2.11, which listed it as `ƒ /probe-route-tsx`.
  assert.equal(isPageLayerModule("src/app/deeply/nested/route.ts"), false);
  assert.equal(isPageLayerModule("src/app/deeply/nested/route.tsx"), false);

  // `sitemap` nests -- Next's matcher is unanchored, which is how `generateSitemaps` yields several.
  assert.equal(isPageLayerModule("src/app/sitemap.ts"), false);
  assert.equal(isPageLayerModule("src/app/products/sitemap.ts"), false);

  // `robots` does not nest -- Next anchors it to the app root. A nested `robots.ts` is an ordinary
  // module, and exempting it by basename would make that filename a way past the gate.
  assert.equal(isPageLayerModule("src/app/robots.ts"), false, "the convention Next recognises");
  assert.equal(
    isPageLayerModule("src/app/marketing/robots.ts"),
    true,
    "a nested robots.ts is not a metadata route and must hold the boundary",
  );

  // Task 36 brought the root layout under the boundary, so no layout is exempt at any depth.
  assert.equal(isPageLayerModule("src/app/layout.tsx"), true, "the root layout is scanned");
  assert.equal(isPageLayerModule("src/app/checkout/layout.tsx"), true);
});

test("no storefront page reaches request state through next/server or next/navigation", () => {
  // Named rather than left to the allowlist because this is the specific thing the migration was
  // for: `connection()` and `notFound()` are loader decisions, and a page calling them is a page
  // that has started loading its own data again. Cart and checkout are why -- both imported
  // `next/server` before Phase E.
  for (const route of STOREFRONT_ROUTES) {
    const file = path.join(REPO_ROOT, route.path);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const reached = collectModuleEdges(sourceFile)
      .map((edge) => edge.specifier)
      .filter((specifier): specifier is string =>
        specifier === "next/server" ||
        specifier === "next/navigation" ||
        specifier === "next/headers" ||
        specifier === "next/cache",
      );

    assert.deepEqual(reached, [], `${route.path} must not reach request state directly`);
  }
});

test("no storefront page imports a transitional commerce or account component", () => {
  // The redraw's point: a brand rewrites `src/components/brand` and gets a working storefront. A
  // page reaching into `@/components/commerce` or `@/components/account` is a page that would not
  // survive that, and those are exactly the imports the checkout, tracking and account pages held.
  //
  // `@/components/layout` no longer exists -- Task 36 moved the site header and footer into the
  // brand layer -- and the prefix stays listed on purpose, so recreating that root is a red test
  // rather than a quiet second home for chrome.
  for (const route of STOREFRONT_ROUTES) {
    const file = path.join(REPO_ROOT, route.path);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const reached = collectModuleEdges(sourceFile)
      .map((edge) => edge.specifier)
      .filter(
        (specifier): specifier is string =>
          typeof specifier === "string" &&
          (specifier.startsWith("@/components/commerce") ||
            specifier.startsWith("@/components/account") ||
            specifier.startsWith("@/components/analytics") ||
            specifier.startsWith("@/components/layout")),
      );

    assert.deepEqual(reached, [], `${route.path} must render through the brand layer`);
  }
});

test("the live gate is not vacuous: the same scan rejects a page that breaches the boundary", () => {
  // Guards the gate. If `liveViolations` returned nothing for everything -- a policy that resolved
  // to no roots, a checker that stopped walking -- the scan above would be green and worthless.
  const breach = path.join(FIXTURES, "negative/alias-db.ts");
  assert.ok(
    checkModuleBoundary({
      fileName: path.join(REPO_ROOT, "src/app/cart/page.tsx"),
      source: readFileSync(breach, "utf8"),
      compilerOptions: COMPILER_OPTIONS,
      policy: storefrontPagePolicy(REPO_ROOT),
    }).length > 0,
    "a page importing @/db must fail the live policy",
  );
});
