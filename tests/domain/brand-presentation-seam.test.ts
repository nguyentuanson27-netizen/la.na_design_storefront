import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { collectModuleEdges } from "../support/boundary-verifier.ts";

/**
 * The brand presentation layer takes props.
 *
 * Spec 06 holds `src/components/brand/*` to props and public behaviour surfaces, with no direct
 * reach into `@/commerce/*`. That is what makes the redraw contract true: a fork rewrites this
 * directory and gets a working storefront, without inheriting a decision about pricing, shipping
 * policy or the approved fact authority that it cannot see.
 *
 * The rule was checked nowhere until Task 36 moved the site header and footer into this directory
 * and the footer arrived still reading the guest shipping policy itself. The reads moved into
 * `@/components/headless/site-chrome-model`; this is what stops them coming back -- here, or in any
 * other brand component.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BRAND_DIRECTORY = "src/components/brand";

/**
 * The thin adapters spec 06 approves: they compose or re-export a shared component so a brand can
 * redraw around it without rebuilding a form whose submission path is reviewed elsewhere. Named one
 * by one, so adding to the list is a visible diff someone has to justify rather than a category
 * anything can join.
 */
const SHARED_COMPONENT_ADAPTERS: ReadonlySet<string> = new Set([
  "guest-checkout-form.tsx",
  "guest-order-tracking-form.tsx",
]);

function brandModules(): string[] {
  return readdirSync(path.join(REPO_ROOT, BRAND_DIRECTORY))
    .filter((name) => /\.tsx?$/.test(name))
    .sort();
}

function edgesOf(name: string) {
  const file = path.join(REPO_ROOT, BRAND_DIRECTORY, name);
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return collectModuleEdges(sourceFile);
}

function reaches(specifier: string | null, root: string): boolean {
  return specifier === root || (specifier?.startsWith(`${root}/`) ?? false);
}

test("no brand component reaches the commerce layer at runtime", () => {
  // Type-only imports are exempt and deliberately so: they are erased by the compiler, so they are
  // how a prop's shape is spelled, not a path to a decision. `product-detail.tsx` imports
  // `StorefrontProductMedia` that way. A value import of the same module would fail here.
  const offenders = brandModules().flatMap((name) =>
    edgesOf(name)
      .filter((edge) => !edge.typeOnly && reaches(edge.specifier, "@/commerce"))
      .map((edge) => `${BRAND_DIRECTORY}/${name}:${edge.line}: ${edge.specifier}`),
  );

  assert.deepEqual(offenders, [], "brand markup takes props; the commerce read belongs in headless");
});

test("only the approved adapters compose a shared commerce component", () => {
  const offenders = brandModules()
    .filter((name) => !SHARED_COMPONENT_ADAPTERS.has(name))
    .flatMap((name) =>
      edgesOf(name)
        .filter((edge) => reaches(edge.specifier, "@/components/commerce"))
        .map((edge) => `${BRAND_DIRECTORY}/${name}:${edge.line}: ${edge.specifier}`),
    );

  assert.deepEqual(offenders, []);
});

test("every named adapter exists, so the list cannot outlive what it exempts", () => {
  const onDisk = new Set(brandModules());

  for (const adapter of SHARED_COMPONENT_ADAPTERS) {
    assert.ok(onDisk.has(adapter), `${adapter} is exempted but no longer exists`);
  }
});

test("the scan is not vacuous: it sees the whole directory and catches a planted breach", () => {
  // A scan that resolved to no files, or an edge collector that stopped walking, would leave both
  // rules green while checking nothing.
  const modules = brandModules();
  assert.ok(modules.length >= 10, `expected the brand layer, found ${modules.length} modules`);
  for (const chrome of ["site-footer.tsx", "site-masthead.tsx", "site-header.tsx"]) {
    assert.ok(modules.includes(chrome), `${chrome} must be scanned`);
  }

  const planted = ts.createSourceFile(
    "planted.tsx",
    'import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";\n',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const caught = collectModuleEdges(planted).filter(
    (edge) => !edge.typeOnly && reaches(edge.specifier, "@/commerce"),
  );
  assert.equal(caught.length, 1, "the same predicate must reject the import it is written to stop");

  // And the exemption is narrow: the same import written as a type is not what the rule is about.
  const asType = ts.createSourceFile(
    "planted-type.tsx",
    'import type { GuestShippingPolicy } from "@/commerce/guest-shipping-policy";\n',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(
    collectModuleEdges(asType).filter((edge) => !edge.typeOnly).length,
    0,
    "a type-only import must be recognised as erased",
  );
});
