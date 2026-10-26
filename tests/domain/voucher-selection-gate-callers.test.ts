import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

/**
 * Voucher v1 (spec 4.1.4 / 7.3, review of 54cb476): every way to SAVE a voucher choice passes the consent gate (the quote under the
 * cart lock, the gift loss, the total that rises). The selection service's writers take the gate as an optional hook, so the only
 * safe call sites are the two in `voucher-draft-commit.ts`. A GET marketing link once called `applyCode` directly and skipped the gate.
 * This test fails if any other file under src/ calls those writers.
 */

const SRC = resolve(import.meta.dirname, "../../src");
const ALLOWED = new Set(["commerce/voucher-selection-service.ts", "commerce/voucher-draft-commit.ts"]);
const WRITERS = /\.(applyCode|applyBoth|setGroup)\s*\(/;

function* files(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { if (name !== "generated") yield* files(path); } else if (/\.(ts|tsx)$/.test(name)) yield path;
  }
}

test("no file outside the consent gate calls the selection service's writers", () => {
  const offenders = [...files(SRC)]
    .map((path) => relative(SRC, path))
    .filter((path) => !ALLOWED.has(path) && WRITERS.test(readFileSync(join(SRC, path), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the guard sees the call sites it exists for", () => {
  const gate = readFileSync(join(SRC, "commerce/voucher-draft-commit.ts"), "utf8");
  assert.match(gate, /\.applyBoth\s*\(/);
  assert.match(gate, /\.applyCode\s*\(/);
});
