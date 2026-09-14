import assert from "node:assert/strict";
import test from "node:test";

import {
  checkMetadataContract,
  exportsAnyMetadata,
  type MetadataCheckInput,
} from "../../src/routes/metadata-verifier.ts";

function codes(source: string, mode: MetadataCheckInput["mode"], fileName = "fixture.tsx"): string[] {
  return checkMetadataContract({ source, mode, fileName }).map((v) => v.code).sort();
}

/* ---------------------------------------------------------------- static mode */

test("static: a direct builder call passes", () => {
  assert.deepEqual(
    codes(
      `import { buildCartMetadata } from "@/routes/metadata/cart";
       export const metadata = buildCartMetadata();`,
      "static",
    ),
    [],
  );
});

test("static: a named import with hand-written metadata fails", () => {
  // The exact heuristic failure this verifier exists to avoid: the builder is imported, its name
  // appears in the file, and the metadata shipped is nonetheless hand-written.
  assert.deepEqual(
    codes(
      `import { buildCartMetadata } from "@/routes/metadata/cart";
       export const metadata = { title: "Cart" };`,
      "static",
    ),
    ["not-direct-call"],
  );
});

test("static: a default import fails even when the call is direct", () => {
  assert.deepEqual(
    codes(
      `import buildCartMetadata from "@/routes/metadata/cart";
       export const metadata = buildCartMetadata();`,
      "static",
    ),
    ["default-import", "no-builder-import", "not-direct-call"],
  );
});

test("static: a namespace import fails", () => {
  assert.ok(
    codes(
      `import * as builders from "@/routes/metadata/cart";
       export const metadata = builders.buildCartMetadata();`,
      "static",
    ).includes("namespace-import"),
  );
});

test("static: exporting both metadata and generateMetadata is rejected", () => {
  assert.ok(
    codes(
      `import { buildCartMetadata } from "@/routes/metadata/cart";
       export const metadata = buildCartMetadata();
       export async function generateMetadata() { return buildCartMetadata(); }`,
      "static",
    ).includes("both-metadata-exports"),
  );
});

/* ------------------------------------------------------------------ page mode */

test("page: returning a direct builder call passes", () => {
  assert.deepEqual(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export async function generateMetadata(props) { return buildHomeMetadata(props); }`,
      "page",
    ),
    [],
  );
});

test("page: calling the builder then returning hand-written metadata fails", () => {
  assert.deepEqual(
    codes(
      `import { buildCartMetadata } from "@/routes/metadata/cart";
       export async function generateMetadata() {
         buildCartMetadata();
         return { title: "Cart" };
       }`,
      "page",
    ),
    ["not-direct-call"],
  );
});

test("page: harmless wrappers around the call are accepted", () => {
  // await, parentheses, `as` and `satisfies` do not change the value, so rejecting them would push
  // route modules into contortions without buying any guarantee.
  for (const expression of [
    "await buildHomeMetadata(props)",
    "(buildHomeMetadata(props))",
    "buildHomeMetadata(props) as Metadata",
    "buildHomeMetadata(props) satisfies Metadata",
    "(await buildHomeMetadata(props)) as Metadata",
  ]) {
    assert.deepEqual(
      codes(
        `import { buildHomeMetadata } from "@/routes/metadata/home";
         export async function generateMetadata(props) { return ${expression}; }`,
        "page",
      ),
      [],
      `${expression} should be accepted`,
    );
  }
});

test("page: an arrow function with an expression body passes", () => {
  assert.deepEqual(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export const generateMetadata = (props) => buildHomeMetadata(props);`,
      "page",
    ),
    [],
  );
});

test("page: branching in the route module is rejected rather than guessed at", () => {
  assert.deepEqual(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export async function generateMetadata(props) {
         if (props.x) return buildHomeMetadata(props);
         return { title: "other" };
       }`,
      "page",
    ),
    ["indirect-return"],
  );
});

test("page: a nested callback's return does not count as the module's return", () => {
  assert.ok(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export async function generateMetadata(props) {
         const f = () => buildHomeMetadata(props);
         return { title: "hand-written" };
       }`,
      "page",
    ).includes("not-direct-call"),
  );
});

test("page: a missing generateMetadata is reported", () => {
  assert.ok(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export const metadata = buildHomeMetadata();`,
      "page",
    ).includes("missing-generate-metadata"),
  );
});

/* ---------------------------------------------------------------- layout mode */

test("layout: the layout module must return a direct builder call", () => {
  assert.deepEqual(
    codes(
      `import { buildProductMetadata } from "@/routes/metadata/product";
       export async function generateMetadata({ params }) { return buildProductMetadata(params); }`,
      "layout",
    ),
    [],
  );
});

test("layout: a page in layout mode must export no metadata of its own", () => {
  assert.equal(
    exportsAnyMetadata(`export default function Page() { return null; }`),
    false,
  );
  assert.equal(
    exportsAnyMetadata(`export const metadata = { title: "x" };`),
    true,
  );
  assert.equal(
    exportsAnyMetadata(`export async function generateMetadata() { return {}; }`),
    true,
  );
});

/* ------------------------------------------------------------------ guardrail */

test("the verifier is not vacuous: an empty module fails every mode", () => {
  for (const mode of ["page", "static", "layout"] as const) {
    assert.notDeepEqual(codes(`export default function Page() { return null; }`, mode), []);
  }
});
