import assert from "node:assert/strict";
import test from "node:test";

import {
  checkMetadataContract,
  exportsAnyMetadata,
  type MetadataCheckInput,
} from "../support/metadata-verifier.ts";

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
       export const metadata = { title: "Handwritten" };`,
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

/**
 * Page mode is checked against the post-migration shape from spec 04 §5.2: the page does not write
 * `generateMetadata` itself, it hands a `metadata` function to `createStorefrontRoute` and re-exports
 * what the factory returns. Checking the export alone would prove nothing about where the value came
 * from, which is the only question worth asking.
 */
function pageModule(body: string): string {
  return `import { createStorefrontRoute } from "@/routes/factory";
    import { buildHomeMetadata } from "@/routes/metadata/home";
    ${body}
    export const generateMetadata = route.generateMetadata;
    export default route.Page;`;
}

test("page: a metadata property returning a direct builder call passes", () => {
  assert.deepEqual(
    codes(
      pageModule(`const route = createStorefrontRoute({
        load, render, metadata: (props) => buildHomeMetadata(props),
      });`),
      "page",
    ),
    [],
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
        pageModule(`const route = createStorefrontRoute({
          load, render, metadata: async (props) => ${expression},
        });`),
        "page",
      ),
      [],
      `${expression} should be accepted`,
    );
  }
});

test("page: a block body with a single return of the builder call passes", () => {
  assert.deepEqual(
    codes(
      pageModule(`const route = createStorefrontRoute({
        load, render,
        metadata: async (props) => { return buildHomeMetadata(props); },
      });`),
      "page",
    ),
    [],
  );
});

test("page: calling the builder then returning hand-written metadata fails", () => {
  assert.deepEqual(
    codes(
      pageModule(`const route = createStorefrontRoute({
        load, render,
        metadata: async (props) => { buildHomeMetadata(props); return { title: "Home" }; },
      });`),
      "page",
    ),
    ["not-direct-call"],
  );
});

test("page: hand-written metadata with the builder merely imported fails", () => {
  assert.deepEqual(
    codes(
      pageModule(`const route = createStorefrontRoute({
        load, render, metadata: async () => ({ title: "Home" }),
      });`),
      "page",
    ),
    ["not-direct-call"],
  );
});

test("page: branching in the route module is rejected rather than guessed at", () => {
  assert.deepEqual(
    codes(
      pageModule(`const route = createStorefrontRoute({
        load, render,
        metadata: async (props) => {
          if (props.x) return buildHomeMetadata(props);
          return { title: "other" };
        },
      });`),
      "page",
    ),
    ["indirect-return"],
  );
});

test("page: a route not built through the factory is rejected", () => {
  // The pre-migration shape. It has to fail, or migrating a page would be optional in practice.
  assert.ok(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       export async function generateMetadata(props) { return buildHomeMetadata(props); }`,
      "page",
    ).includes("missing-route-factory"),
  );
});

test("page: a factory call with no metadata property is rejected", () => {
  assert.ok(
    codes(
      pageModule(`const route = createStorefrontRoute({ load, render });`),
      "page",
    ).includes("missing-metadata"),
  );
});

test("page: failing to re-export the factory's generateMetadata is rejected", () => {
  assert.ok(
    codes(
      `import { createStorefrontRoute } from "@/routes/factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       const route = createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       });
       export default route.Page;`,
      "page",
    ).includes("missing-generate-metadata"),
  );
});

test("page: exporting generateMetadata from a different object is rejected", () => {
  // The route is built correctly and the builder is called correctly; the module then exports a
  // hand-written `generateMetadata` from a *different* object beside it. Matching on the property
  // name alone saw the right names and let Next ship the wrong metadata.
  assert.deepEqual(
    codes(
      `import { createStorefrontRoute } from "@/routes/factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       const route = createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       });
       const fake = { generateMetadata: async () => ({ title: "handwritten" }) };
       export const generateMetadata = fake.generateMetadata;
       export default route.Page;`,
      "page",
    ),
    ["missing-generate-metadata"],
  );
});

test("page: a locally declared createStorefrontRoute does not count as the factory", () => {
  // Matching the callee's text alone let a module declare its own factory and return whatever it
  // liked. The binding has to resolve to the named import from the canonical module.
  assert.deepEqual(
    codes(
      `import { buildHomeMetadata } from "@/routes/metadata/home";
       function createStorefrontRoute(d) {
         return { Page: null, generateMetadata: async () => ({ title: "fake" }) };
       }
       const route = createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       });
       export const generateMetadata = route.generateMetadata;
       export default route.Page;`,
      "page",
    ),
    ["missing-route-factory"],
  );
});

test("page: importing the factory from somewhere else is rejected", () => {
  assert.ok(
    codes(
      `import { createStorefrontRoute } from "@/routes/not-the-factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       const route = createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       });
       export const generateMetadata = route.generateMetadata;`,
      "page",
    ).includes("missing-route-factory"),
  );
});

test("page: an aliased factory import is still the canonical factory", () => {
  // `createStorefrontRoute as make` is the same function under another local name; rejecting it
  // would be pedantry rather than a guarantee.
  assert.deepEqual(
    codes(
      `import { createStorefrontRoute as make } from "@/routes/factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       const route = make({ load, render, metadata: (props) => buildHomeMetadata(props) });
       export const generateMetadata = route.generateMetadata;
       export default route.Page;`,
      "page",
    ),
    [],
  );
});

test("page: the same export written as a separate statement plus an export list passes", () => {
  assert.deepEqual(
    codes(
      `import { createStorefrontRoute } from "@/routes/factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       const route = createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       });
       const generateMetadata = route.generateMetadata;
       export { generateMetadata };
       export default route.Page;`,
      "page",
    ),
    [],
  );
});

test("page: a factory result that is never bound cannot be exported from", () => {
  assert.ok(
    codes(
      `import { createStorefrontRoute } from "@/routes/factory";
       import { buildHomeMetadata } from "@/routes/metadata/home";
       export default createStorefrontRoute({
         load, render, metadata: (props) => buildHomeMetadata(props),
       }).Page;`,
      "page",
    ).includes("missing-route-factory"),
  );
});

test("page: a default import fails even when the call is direct", () => {
  const found = codes(
    `import { createStorefrontRoute } from "@/routes/factory";
     import buildHomeMetadata from "@/routes/metadata/home";
     const route = createStorefrontRoute({
       load, render, metadata: (props) => buildHomeMetadata(props),
     });
     export const generateMetadata = route.generateMetadata;`,
    "page",
  );
  assert.ok(found.includes("default-import"));
  assert.ok(found.includes("not-direct-call"));
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
