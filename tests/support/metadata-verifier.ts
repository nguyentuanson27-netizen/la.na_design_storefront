import ts from "typescript";

import type { MetadataMode } from "../../src/routes/manifest.ts";

/**
 * Proves that the metadata a route module exports is the value a canonical builder returned.
 *
 * The heuristic this deliberately avoids is "the builder is imported and its name appears somewhere
 * in the file". That passes three things it should not: a default import (which counts as a use the
 * moment it is referenced), a call whose result is thrown away before hand-written metadata is
 * returned, and any file that merely mentions the builder. Each is a real way to ship metadata that
 * never went through the shared builder, so the check here is on the exported *expression*.
 */

export const METADATA_BUILDER_MODULE_PREFIX = "@/routes/metadata/";

export type MetadataViolation = Readonly<{ code: string; message: string }>;

export type MetadataCheckInput = Readonly<{
  /** Source of the module that declares the metadata for this route. */
  source: string;
  fileName: string;
  mode: MetadataMode;
}>;

function parse(input: MetadataCheckInput): ts.SourceFile {
  return ts.createSourceFile(
    input.fileName,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/**
 * Names imported from `@/routes/metadata/*`, and only through a named import.
 *
 * A default or namespace import is rejected rather than recorded: it would let the module rename the
 * builder to anything, which makes "is this expression a call to the canonical builder?"
 * unanswerable by inspection.
 */
function namedMetadataBuilders(sf: ts.SourceFile, violations: MetadataViolation[]): Set<string> {
  const names = new Set<string>();

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!st.moduleSpecifier.text.startsWith(METADATA_BUILDER_MODULE_PREFIX)) continue;

    const clause = st.importClause;
    if (!clause) continue;

    if (clause.name) {
      violations.push({
        code: "default-import",
        message: `${sf.fileName}: metadata builder must use a named import, not a default import`,
      });
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      violations.push({
        code: "namespace-import",
        message: `${sf.fileName}: metadata builder must use a named import, not a namespace import`,
      });
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }

  return names;
}

/** Strips the wrappers that do not change the value: `await`, parentheses, `as`, `satisfies`. */
function unwrapMetadataExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isDirectBuilderCall(expr: ts.Expression, names: ReadonlySet<string>): boolean {
  const unwrapped = unwrapMetadataExpression(expr);
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    names.has(unwrapped.expression.text)
  );
}

/**
 * The expression a function hands back: an arrow's expression body, or the single returned
 * expression of a block. A block with no return, or with more than one, is not accepted -- the
 * branching belongs in `src/routes/metadata/*`, and accepting it here would mean guessing which
 * branch produces the metadata.
 */
function returnedExpression(
  fn: ts.FunctionLikeDeclaration,
  violations: MetadataViolation[],
  label: string,
): ts.Expression | null {
  if (fn.body && !ts.isBlock(fn.body)) return fn.body;
  if (!fn.body) return null;

  const returns: ts.ReturnStatement[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) returns.push(node);
    node.forEachChild(walk);
  };
  fn.body.forEachChild(walk);

  if (returns.length !== 1) {
    violations.push({
      code: "indirect-return",
      message: `${label}: metadata must come from exactly one return of a direct builder call (found ${returns.length})`,
    });
    return null;
  }
  return returns[0]!.expression ?? null;
}

function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.name?.text === name &&
      (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return st;
    }
    if (ts.isVariableStatement(st)) {
      const exported = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      for (const decl of st.declarationList.declarations) {
        if (decl.name.getText(sf) !== name || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

function findExportedConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const decl of st.declarationList.declarations) {
      if (decl.name.getText(sf) === name && decl.initializer) return decl.initializer;
    }
  }
  return null;
}

export const ROUTE_FACTORY_NAME = "createStorefrontRoute";
export const ROUTE_FACTORY_MODULE = "@/routes/factory";

/**
 * The local name `createStorefrontRoute` is bound to, if it is a named import from the canonical
 * factory module.
 *
 * Matching on the callee's text alone was not enough: a module could declare its own
 * `createStorefrontRoute` and satisfy the check with a function that returns whatever it likes.
 * Resolving the binding to the real import is what makes "built through the factory" mean something.
 * An alias (`createStorefrontRoute as make`) is honoured, since that is still the canonical function.
 */
function factoryBindingName(sf: ts.SourceFile): string | null {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== ROUTE_FACTORY_MODULE) continue;

    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === ROUTE_FACTORY_NAME) return element.name.text;
    }
  }
  return null;
}

type RouteDefinitionSite = Readonly<{
  /** The variable the factory result is assigned to, so the export can be tied back to it. */
  routeBinding: string;
  metadata: ts.Expression | ts.FunctionLikeDeclaration | null;
}>;

/**
 * Locates `const route = createStorefrontRoute({ … })` and returns both the binding and the
 * `metadata` property, so page mode can require the exported value to come from *this* call rather
 * than from anything that happens to have a `generateMetadata` property.
 */
function routeDefinitionSite(
  sf: ts.SourceFile,
  violations: MetadataViolation[],
  label: string,
): RouteDefinitionSite | null {
  const factory = factoryBindingName(sf);
  if (factory === null) {
    violations.push({
      code: "missing-route-factory",
      message: `${label}: page mode must import ${ROUTE_FACTORY_NAME} from ${ROUTE_FACTORY_MODULE}`,
    });
    return null;
  }

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      const initializer = decl.initializer;
      if (
        !initializer ||
        !ts.isCallExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        initializer.expression.text !== factory ||
        !ts.isIdentifier(decl.name)
      ) {
        continue;
      }

      const definition = initializer.arguments[0];
      if (!definition || !ts.isObjectLiteralExpression(definition)) {
        violations.push({
          code: "missing-metadata",
          message: `${label}: ${ROUTE_FACTORY_NAME} must receive a route definition object literal`,
        });
        return { routeBinding: decl.name.text, metadata: null };
      }

      for (const property of definition.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(sf) === "metadata") {
          return { routeBinding: decl.name.text, metadata: property.initializer };
        }
        if (ts.isMethodDeclaration(property) && property.name.getText(sf) === "metadata") {
          return { routeBinding: decl.name.text, metadata: property };
        }
      }

      violations.push({
        code: "missing-metadata",
        message: `${label}: page mode requires a \`metadata\` property on the route definition`,
      });
      return { routeBinding: decl.name.text, metadata: null };
    }
  }

  violations.push({
    code: "missing-route-factory",
    message: `${label}: page mode must assign the ${ROUTE_FACTORY_NAME} result to a binding it exports from`,
  });
  return null;
}

/**
 * Whether the module exports `generateMetadata` taken from the factory result named `routeBinding`.
 *
 * The object matters as much as the property name. Accepting any `<something>.generateMetadata` let
 * a module build a real route, then export a hand-written `fake.generateMetadata` beside it -- the
 * verifier saw the right names and Next shipped the wrong metadata.
 */
function exportsFactoryGenerateMetadata(sf: ts.SourceFile, routeBinding: string): boolean {
  const initializer = findExportedConstInitializer(sf, "generateMetadata");
  if (initializer) {
    return (
      ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === "generateMetadata" &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === routeBinding
    );
  }

  // `const generateMetadata = route.generateMetadata; export { generateMetadata };` is the same
  // thing written in two statements, so follow the local declaration rather than trusting the name.
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) {
      continue;
    }
    for (const element of st.exportClause.elements) {
      if (element.name.text !== "generateMetadata") continue;
      const local = element.propertyName?.text ?? element.name.text;
      for (const candidate of sf.statements) {
        if (!ts.isVariableStatement(candidate)) continue;
        for (const decl of candidate.declarationList.declarations) {
          if (decl.name.getText(sf) !== local || !decl.initializer) continue;
          if (
            ts.isPropertyAccessExpression(decl.initializer) &&
            decl.initializer.name.text === "generateMetadata" &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === routeBinding
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** Whether a module exports a metadata value at all, in either shape. */
export function exportsAnyMetadata(source: string, fileName = "module.tsx"): boolean {
  const sf = parse({ source, fileName, mode: "page" });
  return (
    findExportedConstInitializer(sf, "metadata") !== null ||
    findExportedFunction(sf, "generateMetadata") !== null
  );
}

/**
 * Checks one route module against the metadata placement its manifest entry declares.
 *
 * Returns every violation rather than the first, so a fixture failing for two reasons reports both.
 */
export function checkMetadataContract(input: MetadataCheckInput): readonly MetadataViolation[] {
  const violations: MetadataViolation[] = [];
  const sf = parse(input);
  const builders = namedMetadataBuilders(sf, violations);
  const label = input.fileName;

  if (builders.size === 0) {
    violations.push({
      code: "no-builder-import",
      message: `${label}: no metadata builder imported from ${METADATA_BUILDER_MODULE_PREFIX}*`,
    });
  }

  if (input.mode === "static") {
    const initializer = findExportedConstInitializer(sf, "metadata");
    if (!initializer) {
      violations.push({ code: "missing-metadata", message: `${label}: expected \`export const metadata\`` });
    } else if (!isDirectBuilderCall(initializer, builders)) {
      violations.push({
        code: "not-direct-call",
        message: `${label}: \`metadata\` must be a direct call to a canonical builder`,
      });
    }
    if (findExportedFunction(sf, "generateMetadata")) {
      violations.push({
        code: "both-metadata-exports",
        message: `${label}: a segment cannot export both \`metadata\` and \`generateMetadata\``,
      });
    }
    return violations;
  }

  if (input.mode === "page") {
    // Page mode inspects the `metadata` property handed to `createStorefrontRoute`, not an exported
    // function: after migration the page does not write `generateMetadata` itself, it re-exports the
    // one the factory built. Checking that export alone would say nothing about where the value came
    // from, which is the entire question.
    const site = routeDefinitionSite(sf, violations, label);
    if (site?.metadata) {
      const expression = ts.isFunctionLike(site.metadata)
        ? returnedExpression(site.metadata, violations, label)
        : site.metadata;
      if (expression && !isDirectBuilderCall(expression, builders)) {
        violations.push({
          code: "not-direct-call",
          message: `${label}: the route's \`metadata\` must be a direct call to a canonical builder`,
        });
      }
    }

    if (site && !exportsFactoryGenerateMetadata(sf, site.routeBinding)) {
      violations.push({
        code: "missing-generate-metadata",
        message: `${label}: page mode must export \`${site.routeBinding}.generateMetadata\`, the value this factory call returned`,
      });
    }

    if (findExportedConstInitializer(sf, "metadata")) {
      violations.push({
        code: "both-metadata-exports",
        message: `${label}: a segment cannot export both \`metadata\` and \`generateMetadata\``,
      });
    }

    return violations;
  }

  // `layout`: the metadata-owning module is the layout, which writes `generateMetadata` by hand and
  // must return the builder call directly.
  const fn = findExportedFunction(sf, "generateMetadata");
  if (!fn) {
    violations.push({
      code: "missing-generate-metadata",
      message: `${label}: expected an exported \`generateMetadata\``,
    });
    return violations;
  }

  if (findExportedConstInitializer(sf, "metadata")) {
    violations.push({
      code: "both-metadata-exports",
      message: `${label}: a segment cannot export both \`metadata\` and \`generateMetadata\``,
    });
  }

  const expression = returnedExpression(fn, violations, label);
  if (expression && !isDirectBuilderCall(expression, builders)) {
    violations.push({
      code: "not-direct-call",
      message: `${label}: \`generateMetadata\` must return a direct call to a canonical builder`,
    });
  }

  return violations;
}
