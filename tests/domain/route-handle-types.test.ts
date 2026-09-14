import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/route-handle");

/**
 * Type-level claims have to be compiled to be worth anything. This runs the real compiler, with the
 * project's real options, over fixtures that live outside `tsconfig.json`'s include -- excluded
 * precisely because a negative fixture is *supposed* to fail, and would otherwise break
 * `pnpm typecheck`.
 */
function compile(fixture: string): readonly ts.Diagnostic[] {
  const configPath = path.join(REPO_ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, "tsconfig.json parses");

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT);
  const program = ts.createProgram([path.join(FIXTURES, fixture)], {
    ...parsed.options,
    noEmit: true,
    incremental: false,
  });

  const file = program.getSourceFile(path.join(FIXTURES, fixture));
  assert.ok(file, `${fixture} was loaded by the compiler`);
  return program.getSemanticDiagnostics(file);
}

function messagesFor(fixture: string): string[] {
  return compile(fixture).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

test("a page cannot read the payload off the handle through any public typed API", () => {
  const messages = messagesFor("reads-payload.tsx");

  // Four distinct attempts, each of which must be rejected on its own: the named field, a guessed
  // field, an index access, and reading straight through the value sealRoute returns.
  assert.ok(messages.length >= 4, `expected every access to be rejected, got:\n${messages.join("\n")}`);

  for (const member of ["data", "payload"]) {
    assert.ok(
      messages.some((m) => m.includes(`Property '${member}' does not exist`)),
      `reading .${member} must be a type error; diagnostics were:\n${messages.join("\n")}`,
    );
  }

  assert.ok(
    messages.some((m) => m.includes("data") && /does not exist|no index signature|implicitly has/.test(m)),
    "an index access must be rejected too",
  );
});

test("the supported seal/shell/render-prop shape compiles cleanly", () => {
  const diagnostics = compile("valid-usage.tsx");

  // Without this, the negative fixture proves nothing: a handle that rejected *every* use would pass
  // the test above while making the shell unusable.
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    [],
    "the intended usage must not produce diagnostics",
  );
});
