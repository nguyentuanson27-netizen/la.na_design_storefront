import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relativePath: string) => readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

test("PDP removes collection chips and the unnecessary mobile divider above the purchase panel", () => {
  const page = read("src/app/shop/[slug]/page.tsx");
  const panel = read("src/components/brand/purchase-panel.tsx");
  const css = read("src/app/globals.css");

  assert.doesNotMatch(page, /pdp-collection-row|data\.collections\.map/);
  assert.doesNotMatch(css, /\.pdp-collection-row/);
  // The mobile grid already supplies 24px row gap. For an active Flash Sale, -16px
  // leaves just 8px below the product heading; standard products retain their spacing.
  assert.match(panel, /className=\{flashClock === null \? "mt-3 lg:mt-0" : "-mt-4 lg:mt-0"\}/);
  assert.doesNotMatch(panel, /className="-mt-4 lg:mt-0"/);
  assert.doesNotMatch(panel, /mt-1 border-t border-\[#3B2219\]\/15 pt-6/);
});

test("PDP Flash Sale is one compact row while keeping the live clock and spoken countdown", () => {
  const panel = read("src/components/brand/purchase-panel.tsx");
  const css = read("src/app/globals.css");
  const strip = /\.pdp-flash-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  assert.match(strip, /display:\s*flex;/);
  assert.match(strip, /flex-wrap:\s*wrap;/);
  const digits = /\.pdp-flash-strip__digits\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(digits, /flex-wrap:\s*wrap;/);
  const dayCss = /\.pdp-flash-strip__days\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const timeCss = /\.pdp-flash-strip__time\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(dayCss, /background:\s*#3b2219;/);
  assert.match(timeCss, /background:\s*#3b2219;/);
  assert.match(strip, /min-height:\s*2\.25rem;/);
  assert.match(strip, /padding:\s*0\.25rem 0\.625rem;/);

  assert.match(panel, /flashClock === null \? null : \(\s*<div className="pdp-flash-strip" data-pdp-flash=""/);
  assert.match(panel, /flashClock\.days > 0/);
  assert.match(panel, /\{flashClock\.hours\}:\{flashClock\.minutes\}:\{flashClock\.seconds\}/);
  assert.match(panel, /className="sr-only">\{flashClock\.spoken\}/);
  assert.doesNotMatch(panel, /<span>\{t\("Kết thúc sau"\)\}<\/span>/);
  assert.match(panel, /flashClock === null \? "" : "mt-3"/);
});
