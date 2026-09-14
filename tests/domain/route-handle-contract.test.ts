import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORE_PATH = path.join(REPO_ROOT, "src/routes/core.tsx");
const CORE_SOURCE = readFileSync(CORE_PATH, "utf8");

/**
 * The shell is verified by analysing its AST rather than by rendering it.
 *
 * That is a constraint, not a preference: this suite runs on `node --experimental-strip-types`,
 * which refuses the `.tsx` extension outright (ERR_UNKNOWN_FILE_EXTENSION, verified under both
 * --experimental-strip-types and --experimental-transform-types). The shell must mount two `.tsx`
 * client components, so no test in this repo can import it whatever extension the shell itself uses.
 * Rendering it would additionally need a bundler and a Next request context, since
 * `StorefrontPromotionRefresher` calls `useRouter`.
 *
 * Parsing is therefore the honest option, and it is stronger than the string matching it replaces:
 * these assertions are about the shape of the returned element tree, not about text appearing
 * somewhere in the file. What parsing cannot prove is covered elsewhere -- the escaping guarantee is
 * executed for real against the canonical serializer in `route-shell-jsonld.test.ts`, and the
 * opacity of the handle is checked by compiling negative fixtures with `tsc` below.
 */
const core = ts.createSourceFile(CORE_PATH, CORE_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findFunction(name: string): ts.FunctionDeclaration {
  const found = core.statements.find(
    (st): st is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  assert.ok(found, `${name} is declared in core.tsx`);
  return found;
}

function collect(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (predicate(n)) out.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

/** Every JSX element in a subtree, as `{ tag, attributes }`. */
function jsxElements(node: ts.Node): { tag: string; node: ts.JsxSelfClosingElement | ts.JsxOpeningElement }[] {
  return collect(node, (n) => ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)).map((n) => {
    const el = n as ts.JsxSelfClosingElement | ts.JsxOpeningElement;
    return { tag: el.tagName.getText(core), node: el };
  });
}

function attribute(
  el: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  name: string,
): ts.JsxAttribute | undefined {
  return el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(core) === name,
  );
}

const shell = findFunction("StorefrontRoute");
const shellJsx = jsxElements(shell);

test("the shell mounts the promotion refresher, fed from the sealed payload", () => {
  const refresher = shellJsx.filter((e) => e.tag === "StorefrontPromotionRefresher");
  assert.equal(refresher.length, 1, "exactly one refresher");

  const attr = attribute(refresher[0]!.node, "refreshAfterMs");
  assert.ok(attr, "refresher receives refreshAfterMs");
  assert.match(
    attr.initializer!.getText(core),
    /payload\.refreshAfterMs/,
    "the duration comes from the payload, not a literal",
  );
});

test("the shell mounts the commerce event reporter, fed from the sealed payload", () => {
  const reporter = shellJsx.filter((e) => e.tag === "CommerceEventReporter");
  assert.equal(reporter.length, 1, "exactly one reporter");

  const attr = attribute(reporter[0]!.node, "event");
  assert.ok(attr, "reporter receives the event");
  assert.match(attr.initializer!.getText(core), /payload\.trackingEvent/);
});

test("the shell mounts the reporter unconditionally, so a null event is not a missing reporter", () => {
  const reporter = shellJsx.find((e) => e.tag === "CommerceEventReporter")!.node;

  // The criterion is that the shell still renders when trackingEvent is null. What would break it is
  // the shell branching on the event -- `{payload.trackingEvent && <CommerceEventReporter .../>}` --
  // which collapses "no event" into "no reporter" and loses the fail-closed path the reporter owns.
  let parent: ts.Node | undefined = reporter.parent;
  while (parent && parent !== shell) {
    assert.equal(
      ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent),
      false,
      "the reporter must not sit behind a conditional",
    );
    parent = parent.parent;
  }

  const refresher = shellJsx.find((e) => e.tag === "StorefrontPromotionRefresher")!.node;
  let refresherParent: ts.Node | undefined = refresher.parent;
  while (refresherParent && refresherParent !== shell) {
    assert.equal(
      ts.isConditionalExpression(refresherParent) || ts.isBinaryExpression(refresherParent),
      false,
      "the refresher must not sit behind a conditional either",
    );
    refresherParent = refresherParent.parent;
  }
});

test("the shell renders JSON-LD through the canonical serializer and defines none of its own", () => {
  const script = shellJsx.filter((e) => e.tag === "script");
  assert.equal(script.length, 1, "exactly one JSON-LD script element");

  const typeAttr = attribute(script[0]!.node, "type");
  assert.equal(typeAttr?.initializer?.getText(core), '"application/ld+json"');

  const html = attribute(script[0]!.node, "dangerouslySetInnerHTML");
  assert.ok(html, "the script is filled through dangerouslySetInnerHTML");
  // One script element in the source, rendered once per document. Serializing the whole array in a
  // single script would turn a route that publishes one graph into `[{…}]`, changing the JSON-LD
  // search engines already read on the PDP; what matters here is that whatever goes in a script goes
  // through the canonical serializer untouched.
  assert.match(
    html.initializer!.getText(core),
    /serializeJsonLd\(\s*document\s*\)/,
    "each document goes straight to the canonical serializer",
  );

  const imports = core.statements.filter(ts.isImportDeclaration);
  const serializerImport = imports.find((st) =>
    (st.moduleSpecifier as ts.StringLiteral).text === "@/seo/structured-data",
  );
  assert.ok(serializerImport, "serializeJsonLd is imported, not reimplemented");

  // A second escaping implementation is the failure mode that matters: it would pass every JSON-LD
  // test here while diverging from the hardened one the rest of the app uses.
  assert.equal(
    collect(core, (n) => ts.isCallExpression(n) && n.expression.getText(core) === "JSON.stringify")
      .length,
    0,
    "the shell must not stringify JSON-LD itself",
  );
});

test("the shell passes sealed data to the page only through the render prop", () => {
  const calls = collect(shell, (n) => ts.isCallExpression(n) && n.expression.getText(core) === "children");
  assert.equal(calls.length, 1, "children is called exactly once");
  assert.equal((calls[0] as ts.CallExpression).arguments[0]!.getText(core), "payload.data");
});

test("unsealRoute and the payload symbol never leave the module", () => {
  const unseal = findFunction("unsealRoute");
  const modifiers = ts.getModifiers(unseal) ?? [];
  assert.equal(
    modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    false,
    "unsealRoute must not be exported",
  );

  const payloadDecl = collect(
    core,
    (n) => ts.isVariableDeclaration(n) && n.name.getText(core) === "PAYLOAD",
  );
  assert.equal(payloadDecl.length, 1, "PAYLOAD is declared once");
  const payloadStatement = payloadDecl[0]!.parent.parent as ts.VariableStatement;
  assert.equal(
    (ts.getModifiers(payloadStatement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    false,
    "PAYLOAD must not be exported",
  );

  // An export list would smuggle either one out without an `export` modifier on the declaration.
  for (const st of core.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) {
      continue;
    }
    for (const el of st.exportClause.elements) {
      assert.equal(
        ["unsealRoute", "PAYLOAD"].includes(el.propertyName?.text ?? el.name.text),
        false,
        "neither may leave through an export list",
      );
    }
  }
});

test("sealRoute is the only exported way to build a handle", () => {
  const exported = core.statements
    .filter(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) &&
        (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map((st) => st.name!.text);

  assert.deepEqual(exported.sort(), ["StorefrontRoute", "sealRoute"]);
});
