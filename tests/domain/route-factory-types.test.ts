import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/route-factory");

/**
 * The factory's contract is a type-level one, so it is checked by running the real compiler over
 * fixtures rather than by reading the source. The fixtures live outside `tsconfig.json`'s include:
 * the negative one is meant to fail, and would otherwise break `pnpm typecheck`.
 */
function diagnose(fixture: string): string[] {
  const configFile = ts.readConfigFile(path.join(REPO_ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  const entry = path.join(FIXTURES, fixture);
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: true, incremental: false });

  const file = program.getSourceFile(entry);
  assert.ok(file, `${fixture} was loaded`);
  return program
    .getSemanticDiagnostics(file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

test("both factory shapes compile: with page metadata, and without", () => {
  assert.deepEqual(
    diagnose("overloads-valid.tsx"),
    [],
    "the supported usage must not produce diagnostics",
  );
});

test("the no-metadata overload does not expose generateMetadata", () => {
  const messages = diagnose("overloads-invalid.tsx");

  // Without this the two overloads would be decoration: a layout- or static-mode page could
  // re-export an undefined `generateMetadata` and silently ship no metadata for the segment.
  assert.ok(
    messages.some((m) => m.includes("generateMetadata")),
    `expected generateMetadata to be rejected, got:\n${messages.join("\n") || "(no diagnostics)"}`,
  );
});
