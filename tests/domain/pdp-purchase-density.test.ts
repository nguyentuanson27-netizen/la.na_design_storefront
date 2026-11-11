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

test("Flash Sale keeps the original desktop styles and fills the mobile viewport without wrapping", () => {
  const panel = read("src/components/brand/purchase-panel.tsx");
  const css = read("src/app/globals.css");
  const strip = /\.pdp-flash-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const label = /\.pdp-flash-strip__label\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const digit = /\.pdp-flash-strip__digits b\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  assert.match(strip, /border-radius:\s*0;/);
  assert.match(strip, /min-height:\s*2\.875rem;/);
  assert.match(label, /font-size:\s*0\.8125rem;/);
  assert.match(digit, /background:\s*#ffffff;/);
  assert.match(digit, /color:\s*#b8123f;/);
  assert.match(digit, /font-size:\s*0\.9rem;/);

  const mobile = /@media \(max-width: 63\.999rem\)\s*\{\s*\.pdp-flash-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(mobile, /width:\s*100vw;/);
  assert.match(mobile, /margin-inline-start:\s*calc\(50% - 50vw\);/);
  assert.match(mobile, /flex-wrap:\s*nowrap;/);
  assert.match(mobile, /overflow-x:\s*auto;/);

  assert.match(panel, /className="pdp-flash-strip" data-pdp-flash=""/);
  assert.match(panel, /<span>\{t\("Kết thúc sau"\)\}<\/span>/);
  assert.match(panel, /<b>\{flashClock\.hours\}<\/b>:<b>\{flashClock\.minutes\}<\/b>:<b>\{flashClock\.seconds\}<\/b>/);
  assert.match(panel, /className="sr-only">\{flashClock\.spoken\}/);
  assert.match(panel, /flashClock === null \? "" : "mt-3 lg:mt-4"/);
});
