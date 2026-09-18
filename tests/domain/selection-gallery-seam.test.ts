import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import type { StorefrontProductMedia, TrustedProductImage } from "../../src/commerce/product-media.ts";
import type { StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";
import { withFixtureAvailability } from "../fixtures/storefront-projection-option.ts";
import { resolveGalleryModel } from "../../src/components/headless/resolve-gallery-model.ts";
import { resolveVariantSelectionView } from "../../src/components/headless/variant-selection-model.ts";
import { collectModuleEdges } from "../support/boundary-verifier.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The seam that lets one selection state drive both the purchase panel and the gallery.
 *
 * A PDP has to show the shopper's colour choice in two places at once. That only works if the
 * panel's selection is something a page can hold and hand to both components, rather than state
 * hidden inside the panel. These tests hold both halves of that: the decision chain end to end,
 * and the component surfaces that make it wireable.
 */

function option({
  availability,
  ...overrides
}: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  const merged = {
    id: "variant-1",
    pancakeVariationId: "pancake-1",
    kindKey: null,
    kindLabel: null,
    color: null,
    size: "S",
    price: 100_000,
    basePriceVnd: null,
    isDiscounted: false,
    purchasable: true,
    isPreorderSale: false,
    unavailableReason: null,
    ...overrides,
  };
  // I9 — derived from what the fixture already says rather than cast away, so an option here can
  // never carry an availability the shipped projection would not produce for it.
  return availability === undefined
    ? withFixtureAvailability(merged)
    : { ...merged, availability };
}

function image(n: number): TrustedProductImage {
  return { url: `https://content.pancake.vn/1/2/3/4/photo-${n}.jpg`, alt: "" };
}

const media: StorefrontProductMedia = {
  primary: image(1),
  gallery: [image(1), image(2), image(3), image(4)],
};

const options = [
  option({ id: "black-s", color: "Đen", size: "S" }),
  option({ id: "white-s", color: "Trắng", size: "S" }),
];

/** Server-resolved, the same map `?variant=` deep links already use. */
const galleryIndexByVariantId = { "black-s": 1, "white-s": 3 };

/* ---------------------------------------------------------- the chain end to end */

test("the variant the panel resolves is the photo the gallery shows", () => {
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: "Trắng", size: "S" },
  });
  assert.equal(view.selectedVariantId, "white-s");

  const gallery = resolveGalleryModel({
    media,
    productName: "Áo sơ mi",
    selectedVariantId: view.selectedVariantId,
    galleryIndexByVariantId,
  });

  assert.equal(gallery.activeIndex, 3, "the gallery follows the panel's variant");
});

test("changing colour moves the photo with it", () => {
  const indexFor = (color: string) =>
    resolveGalleryModel({
      media,
      productName: "Áo sơ mi",
      selectedVariantId: resolveVariantSelectionView({
        options,
        productLevelOptions: options,
        selection: { kindKey: null, color, size: "S" },
      }).selectedVariantId,
      galleryIndexByVariantId,
    }).activeIndex;

  assert.equal(indexFor("Đen"), 1);
  assert.equal(indexFor("Trắng"), 3);
});

test("an incomplete selection leaves the gallery where the server opened it", () => {
  // Nothing chosen yet resolves to no variant, and a gallery must not jump on that.
  const view = resolveVariantSelectionView({
    options,
    productLevelOptions: options,
    selection: { kindKey: null, color: null, size: null },
  });
  assert.equal(view.selectedVariantId, null);

  const gallery = resolveGalleryModel({
    media,
    productName: "Áo sơ mi",
    initialIndex: 2,
    selectedVariantId: view.selectedVariantId,
    galleryIndexByVariantId,
  });

  assert.equal(gallery.activeIndex, 2);
});

/* ------------------------------------------------- the surfaces that make it wireable */

/**
 * These are checked by compiling fixtures, not by reading the components' source.
 *
 * `src/components/brand/**` is per-brand throwaway: the architecture promises a fork rewrites it
 * freely. A regex over that source turns formatting into a test failure — Phase G's discardability
 * exercise redrew both components correctly and still failed here, once on where a destructure was
 * broken across lines and once on the spelling of a type expression. The obligations themselves are
 * real, so they moved to where a redraw satisfies them by compiling.
 *
 * The fixtures live outside `tsconfig.json`'s include: the negative one is meant to fail, and would
 * otherwise break `pnpm typecheck`.
 */
function diagnose(fixture: string): string[] {
  const configFile = ts.readConfigFile(path.join(REPO_ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  const entry = path.join(REPO_ROOT, "tests/fixtures/brand-seam", fixture);
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: true, incremental: false });

  const file = program.getSourceFile(entry);
  assert.ok(file, `${fixture} was loaded`);
  return program
    .getSemanticDiagnostics(file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

test("the panel renders a controller it does not own, and still accepts the hook's input alone", () => {
  // Without the first of these, a page cannot drive the panel and the gallery from one selection:
  // it would have to duplicate the state or reimplement the hook.
  assert.deepEqual(diagnose("panel-contract.tsx"), []);
});

test("a panel that owns its own selection does not satisfy the seam", () => {
  // Guards the guard. If the assignment above accepted anything, the contract would be decoration:
  // the shape it exists to forbid has to be rejected by the same check.
  const messages = diagnose("panel-owns-hook.tsx");

  assert.ok(
    messages.length > 0,
    "a panel insisting on making its own selection must not typecheck as the view",
  );
});

test("the gallery accepts the selection the panel resolves, and owns its own manual pick", () => {
  // It takes the model's whole input minus the state it owns itself, which is what carries
  // `selectedVariantId` and `galleryIndexByVariantId` through to the model.
  assert.deepEqual(diagnose("gallery-contract.tsx"), []);
});

test("the brand panel speaks the hook's types, not commerce's", async () => {
  // Checked on the module graph, not on the file's text.
  //
  // A raw `source.includes("@/commerce/")` is wrong in both directions on a file a brand rewrites
  // freely: it fails a redraw that merely mentions the path in a comment or a string, and it misses
  // an exact `@/commerce` specifier with no trailing slash. `collectModuleEdges` is the same AST
  // machinery the boundary gate uses, and it sees specifiers rather than characters.
  const file = new URL("../../src/components/brand/purchase-panel.tsx", import.meta.url);
  const sourceFile = ts.createSourceFile(
    fileURLToPath(file),
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const commerceEdges = collectModuleEdges(sourceFile)
    .map((edge) => edge.specifier)
    .filter(
      (specifier): specifier is string =>
        specifier === "@/commerce" || (specifier?.startsWith("@/commerce/") ?? false),
    );

  assert.deepEqual(
    commerceEdges,
    [],
    "brand markup reaches commerce only through the headless hook's public surface",
  );
});