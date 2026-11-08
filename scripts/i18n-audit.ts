/**
 * English coverage audit.
 *
 *   pnpm i18n:audit            # summary + the files with the most untranslated Vietnamese
 *   pnpm i18n:audit --missing  # every t("...") source with no English entry
 *   pnpm i18n:audit --unwrapped <path>  # Vietnamese literals in a file that are not passed to t()
 *
 * Two different gaps, both reported:
 *   - a *missing* entry: the code asks for `t("Giỏ hàng")` but the catalog has no English for it, so
 *     the English page shows Vietnamese there;
 *   - an *unwrapped* literal: Vietnamese text in a storefront file that never goes through `t`, so
 *     nothing can translate it.
 * The second is a heuristic (a line with Vietnamese letters, outside comments, not inside a `t(`
 * call); it over-reports a little and never under-reports a visible string.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EN_MESSAGES } from "../src/i18n/catalog/en.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/** Out of scope: the admin surface stays Vietnamese, and these hold no storefront copy. */
const SKIPPED = [
  "src/app/admin",
  "src/components/admin",
  "src/generated",
  "src/i18n/catalog",
  "src/brand/messages.en.ts",
];
const SKIPPED_FILE = /(admin|gift-quantity-admin-feedback|voucher-admin-feedback|promotion-admin-feedback|shipping-campaign-admin-feedback)/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const child = path.posix.join(dir, entry.name);
    if (SKIPPED.some((skipped) => child === skipped || child.startsWith(`${skipped}/`))) continue;
    if (entry.isDirectory()) yield* walk(child);
    else if (/\.tsx?$/.test(entry.name) && !SKIPPED_FILE.test(entry.name)) yield child;
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CALL = /\b(?:t|rich)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function literal(raw: string): string {
  const body = raw.slice(1, -1);
  return body.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}

const files = [...walk("src")];
const missing = new Map<string, string[]>();
const unwrapped = new Map<string, number>();
let called = 0;

for (const file of files) {
  const source = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
  for (const match of source.matchAll(CALL)) {
    const key = literal(match[1]!);
    if (!VIETNAMESE.test(key) && !key.includes("{")) continue;
    called += 1;
    if (!Object.hasOwn(EN_MESSAGES, key)) {
      const list = missing.get(key) ?? [];
      list.push(file);
      missing.set(key, list);
    }
  }
  const wrappedRanges: Array<[number, number]> = [];
  for (const match of source.matchAll(CALL)) wrappedRanges.push([match.index!, match.index! + match[0].length + 400]);
  let offset = 0;
  let count = 0;
  for (const line of source.split("\n")) {
    if (VIETNAMESE.test(line) && !/\b(?:t|rich)\(/.test(line)) {
      const inWrapped = wrappedRanges.some(([from, to]) => offset >= from && offset <= to && /["'`]\s*[,)]/.test(line));
      if (!inWrapped) count += 1;
    }
    offset += line.length + 1;
  }
  if (count > 0) unwrapped.set(file, count);
}

const args = process.argv.slice(2);
if (args.includes("--missing")) {
  for (const [key, where] of [...missing].sort()) console.log(`${JSON.stringify(key)}  <- ${[...new Set(where)].join(", ")}`);
  process.exit(missing.size === 0 ? 0 : 1);
}
const unwrappedIndex = args.indexOf("--unwrapped");
if (unwrappedIndex !== -1) {
  const target = args[unwrappedIndex + 1]!;
  const source = stripComments(readFileSync(path.join(ROOT, target), "utf8"));
  source.split("\n").forEach((line, index) => {
    if (VIETNAMESE.test(line) && !/\b(?:t|rich)\(/.test(line)) console.log(`${target}:${index + 1}: ${line.trim()}`);
  });
  process.exit(0);
}

const totalUnwrapped = [...unwrapped.values()].reduce((sum, n) => sum + n, 0);
console.log(`catalog entries:         ${Object.keys(EN_MESSAGES).length}`);
console.log(`t()/rich() sources:      ${called} (${missing.size} distinct with no English entry)`);
console.log(`files with unwrapped vi: ${unwrapped.size} (${totalUnwrapped} lines)`);
console.log("");
console.log("most unwrapped Vietnamese lines:");
for (const [file, count] of [...unwrapped].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}
