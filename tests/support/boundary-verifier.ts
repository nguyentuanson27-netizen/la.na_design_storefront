import path from "node:path";

import ts from "typescript";

/**
 * Proves that a module reaches only the things the page layer is allowed to reach.
 *
 * Two decisions carry the weight. Module specifiers are resolved by TypeScript itself rather than
 * matched by regex, so `@/*`, extensions and `moduleResolution` come from the project's own
 * `tsconfig.json` instead of a second, drifting copy of its rules. And containment is decided with
 * `path.relative`, not string prefixes, because `src/app2` shares a prefix with `src/app` and a
 * `startsWith` check would wave it through.
 */

export type EdgeKind =
  | "import"
  | "side-effect-import"
  | "re-export"
  | "export-star"
  | "dynamic-import";

export type ModuleEdge = Readonly<{
  kind: EdgeKind;
  /** `null` when a dynamic import's argument is not a static string: that is a violation, not a gap. */
  specifier: string | null;
  line: number;
}>;

export type BoundaryPolicy = Readonly<{
  /** Absolute directories a resolved internal module may live in. */
  sourceRoots: readonly string[];
  /**
   * Exact specifiers, never package roots. `next` being allowed must not admit `next/headers`:
   * that is a Dynamic API reading request state, and collapsing to the package root would punch a
   * hole straight through the boundary at the page layer.
   */
  externalSpecifiers: ReadonlySet<string>;
}>;

export type BoundaryViolation = Readonly<{
  code:
    | "dynamic-specifier"
    | "unresolvable"
    | "source-root"
    | "external-specifier";
  specifier: string | null;
  kind: EdgeKind;
  line: number;
  message: string;
}>;

/** The real policy for `src/app`. Spec 04 §6.3. */
export function storefrontPagePolicy(repoRoot: string): BoundaryPolicy {
  return {
    sourceRoots: [
      "src/app",
      "src/routes",
      "src/brand",
      "src/components/brand",
      "src/components/headless",
    ].map((relative) => path.resolve(repoRoot, relative)),
    externalSpecifiers: new Set(["react", "react-dom", "next", "next/image", "next/link"]),
  };
}

/** A specifier that is a static string, or `null` for anything computed at runtime. */
function staticSpecifier(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Every module edge in a file: plain imports, side-effect imports, re-exports, export-star and
 * dynamic imports. Missing any one of these shapes would leave a way to reach a forbidden module
 * without the verifier seeing it.
 */
export function collectModuleEdges(sourceFile: ts.SourceFile): readonly ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      edges.push({
        // No import clause at all means `import "x"` -- evaluated for its side effects, which is a
        // real edge even though it binds nothing.
        kind: statement.importClause ? "import" : "side-effect-import",
        specifier: statement.moduleSpecifier.text,
        line: lineOf(statement),
      });
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      edges.push({
        // `export * from` and `export * as ns from` both re-expose a module wholesale.
        kind: statement.exportClause ? "re-export" : "export-star",
        specifier: statement.moduleSpecifier.text,
        line: lineOf(statement),
      });
    }
  }

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      edges.push({
        kind: "dynamic-import",
        specifier: argument ? staticSpecifier(argument) : null,
        line: lineOf(node),
      });
    }
    node.forEachChild(walk);
  };
  walk(sourceFile);

  return edges;
}

/** `true` when `target` is `root` itself or below it. Rejects `src/app2` against `src/app`. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Internal means "part of this project": a relative path, or the `@/*` alias. */
function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/");
}

export function resolveSpecifier(
  specifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  return (
    ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule
      ?.resolvedFileName ?? null
  );
}

export type BoundaryCheckInput = Readonly<{
  fileName: string;
  source: string;
  compilerOptions: ts.CompilerOptions;
  policy: BoundaryPolicy;
}>;

export function checkModuleBoundary(input: BoundaryCheckInput): readonly BoundaryViolation[] {
  const sourceFile = ts.createSourceFile(
    input.fileName,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    input.fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: BoundaryViolation[] = [];

  for (const edge of collectModuleEdges(sourceFile)) {
    if (edge.specifier === null) {
      // Fail closed. A computed specifier cannot be checked, so it cannot be allowed; the branching
      // belongs in a loader where it is not crossing this boundary.
      violations.push({
        code: "dynamic-specifier",
        specifier: null,
        kind: edge.kind,
        line: edge.line,
        message: `${input.fileName}:${edge.line}: dynamic import must use a static specifier`,
      });
      continue;
    }

    if (!isInternalSpecifier(edge.specifier)) {
      if (!input.policy.externalSpecifiers.has(edge.specifier)) {
        violations.push({
          code: "external-specifier",
          specifier: edge.specifier,
          kind: edge.kind,
          line: edge.line,
          message: `${input.fileName}:${edge.line}: "${edge.specifier}" is not an allowed external specifier`,
        });
      }
      continue;
    }

    const resolved = resolveSpecifier(edge.specifier, input.fileName, input.compilerOptions);
    if (resolved === null) {
      // Unresolvable is red, not skipped: a typo would otherwise buy an exemption.
      violations.push({
        code: "unresolvable",
        specifier: edge.specifier,
        kind: edge.kind,
        line: edge.line,
        message: `${input.fileName}:${edge.line}: "${edge.specifier}" does not resolve`,
      });
      continue;
    }

    if (!input.policy.sourceRoots.some((root) => isInside(root, resolved))) {
      violations.push({
        code: "source-root",
        specifier: edge.specifier,
        kind: edge.kind,
        line: edge.line,
        message: `${input.fileName}:${edge.line}: "${edge.specifier}" resolves outside the allowed source roots (${resolved})`,
      });
    }
  }

  return violations;
}

/** Compiler options straight from the project's own tsconfig, never a second guess at its rules. */
export function readCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = path.join(repoRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, " "));
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot).options;
}
