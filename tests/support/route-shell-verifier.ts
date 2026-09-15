import ts from "typescript";

/**
 * Proves a page module actually renders through the route shell.
 *
 * The weaker check this replaces asked whether the source mentioned `@/routes/factory` and exported
 * something whose name ended in `.Page`. Both are satisfiable without the shell: an unused import
 * next to a hand-rolled `{ Page }` object passes a text match while `StorefrontRoute` never renders,
 * and with it go the promotion refresh, the commerce event and the JSON-LD the shell exists to
 * mount unconditionally. So the default export is traced back to the call that produced it instead.
 *
 * What is checked is provenance, not spelling: the default export must be the `.Page` of a binding
 * initialised by calling the factory, and the callee must be the local name that `@/routes/factory`
 * was imported under. A module can name the binding whatever it likes.
 */

export const FACTORY_MODULE = "@/routes/factory";
export const FACTORY_EXPORT = "createStorefrontRoute";

export type ShellViolation = Readonly<{ code: ShellViolationCode; message: string }>;

export type ShellViolationCode =
  | "no-factory-import"
  | "no-default-export"
  | "default-not-page"
  | "unknown-binding"
  | "binding-not-factory-call";

function violation(code: ShellViolationCode, message: string): ShellViolation {
  return { code, message };
}

/** The local name `createStorefrontRoute` was imported under, or `null` if it was not imported. */
function factoryLocalName(source: ts.SourceFile): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== FACTORY_MODULE) continue;

    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      // `import { createStorefrontRoute as make }` binds the factory to `make`; the propertyName is
      // what was imported, the name is what this module calls it.
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === FACTORY_EXPORT) return element.name.text;
    }
  }
  return null;
}

/** The initialiser of a top-level `const`/`let` with this name, or `null`. */
function bindingInitialiser(source: ts.SourceFile, name: string): ts.Expression | null {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

export function checkRouteShellProvenance(
  input: Readonly<{ source: string; fileName: string }>,
): readonly ShellViolation[] {
  const file = ts.createSourceFile(
    input.fileName,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const factory = factoryLocalName(file);
  if (factory === null) {
    return [
      violation("no-factory-import", `${input.fileName} does not import ${FACTORY_EXPORT} from ${FACTORY_MODULE}`),
    ];
  }

  const defaultExport = file.statements.find(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && statement.isExportEquals !== true,
  );
  if (!defaultExport) {
    return [violation("no-default-export", `${input.fileName} has no default export`)];
  }

  const exported = defaultExport.expression;
  if (
    !ts.isPropertyAccessExpression(exported) ||
    exported.name.text !== "Page" ||
    !ts.isIdentifier(exported.expression)
  ) {
    return [
      violation(
        "default-not-page",
        `${input.fileName} must default-export the \`Page\` of a ${FACTORY_EXPORT} result`,
      ),
    ];
  }

  const bindingName = exported.expression.text;
  const initialiser = bindingInitialiser(file, bindingName);
  if (initialiser === null) {
    return [
      violation("unknown-binding", `${input.fileName} exports \`${bindingName}.Page\` but declares no \`${bindingName}\``),
    ];
  }

  // The call may carry type arguments -- `createStorefrontRoute<Props, Data>({...})` -- which is
  // still a call expression whose callee is the identifier.
  const isFactoryCall =
    ts.isCallExpression(initialiser) &&
    ts.isIdentifier(initialiser.expression) &&
    initialiser.expression.text === factory;

  if (!isFactoryCall) {
    return [
      violation(
        "binding-not-factory-call",
        `${input.fileName} exports \`${bindingName}.Page\`, but \`${bindingName}\` is not a ${FACTORY_EXPORT} call`,
      ),
    ];
  }

  return [];
}
