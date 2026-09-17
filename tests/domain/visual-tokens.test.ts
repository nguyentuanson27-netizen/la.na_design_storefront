import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BRAND } from "../../src/brand/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Parses a hex color string (#rrggbb or #rgb) to sRGB [r, g, b] in 0..1 range.
 */
function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    return [
      parseInt(clean[0]! + clean[0]!, 16) / 255,
      parseInt(clean[1]! + clean[1]!, 16) / 255,
      parseInt(clean[2]! + clean[2]!, 16) / 255,
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

/**
 * Computes the relative luminance of an sRGB color per WCAG 2.1 specs.
 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const transform = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * transform(r) + 0.7152 * transform(g) + 0.0722 * transform(b);
}

/**
 * Computes the contrast ratio between two luminance values per WCAG 2.1.
 */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test("F1 visual tokens: globals.css declares warm brown and cream palette", () => {
  const css = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");

  // Extract variables from :root
  const inkMatch = css.match(/--ink:\s*(#[0-9a-fA-F]{3,6})/);
  const paperMatch = css.match(/--paper:\s*(#[0-9a-fA-F]{3,6})/);
  const blackMatch = css.match(/--black:\s*(#[0-9a-fA-F]{3,6})/);

  assert.ok(inkMatch, "--ink must be declared as a hex color");
  assert.ok(paperMatch, "--paper must be declared as a hex color");
  assert.ok(blackMatch, "--black must be declared as a hex color");

  // F1 requires warm brown / chocolate and cream palette
  assert.equal(inkMatch[1]!.toLowerCase(), "#3b2219", "--ink must be warm brown / chocolate #3b2219");
  assert.equal(paperMatch[1]!.toLowerCase(), "#faf7f2", "--paper must be cream #faf7f2");

  const inkLuminance = relativeLuminance(parseHexColor(inkMatch[1]!));
  const paperLuminance = relativeLuminance(parseHexColor(paperMatch[1]!));
  const blackLuminance = relativeLuminance(parseHexColor(blackMatch[1]!));

  const inkPaperContrast = contrastRatio(inkLuminance, paperLuminance);
  // WCAG AA requires at least 4.5:1 for normal text; WCAG AAA requires 7.0:1
  assert.ok(
    inkPaperContrast >= 4.5,
    `Contrast between --ink (${inkMatch[1]}) and --paper (${paperMatch[1]}) must be >= 4.5:1 (got ${inkPaperContrast.toFixed(2)})`,
  );
  assert.ok(
    inkPaperContrast >= 7.0,
    `Warm brown on cream should satisfy WCAG AAA (>= 7.0:1, got ${inkPaperContrast.toFixed(2)})`,
  );

  const blackPaperContrast = contrastRatio(blackLuminance, paperLuminance);
  assert.ok(
    blackPaperContrast >= 7.0,
    `Contrast between --black and --paper must satisfy WCAG AAA (got ${blackPaperContrast.toFixed(2)})`,
  );
});

test("F1 typography tokens: serif heading and sans-serif body are declared", () => {
  const css = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");
  const siteDoc = readFileSync(path.join(REPO_ROOT, "src/components/brand/site-document.tsx"), "utf8");

  // Playfair_Display is configured in site-document.tsx as --font-serif
  assert.ok(siteDoc.includes("Playfair_Display"), "site-document.tsx must use Playfair_Display font");
  assert.ok(siteDoc.includes("--font-serif"), "site-document.tsx must map to --font-serif variable");

  // globals.css must bind --font-serif in @theme
  assert.ok(css.includes("--font-serif: var(--font-serif)"), "globals.css must configure --font-serif in theme");
  assert.ok(css.includes("font-family: Arial, Helvetica, sans-serif"), "body font must be clean sans-serif");
});

test("F1 brand assets: distinct roles for master logo, social card, and favicon", () => {
  // Master logo role: approved text wordmark used strictly in header and footer
  assert.equal(BRAND.identity.displayNameUpper, "La.na Design");
  assert.equal(typeof BRAND.identity.displayNameUpper, "string");

  // Social card role: dedicated endpoint / route handler serves 1200x630 OG image
  const socialCardPath = path.join(REPO_ROOT, `src/app/${BRAND.identity.socialCardSlug}.png`);
  assert.ok(existsSync(socialCardPath), `Social card endpoint must exist at ${socialCardPath}`);

  // Favicon role: dedicated svg in src/app
  const faviconPath = path.join(REPO_ROOT, "src/app/icon.svg");
  assert.ok(existsSync(faviconPath), `Favicon asset must exist at ${faviconPath}`);
});

test("F1 contrast ratio: secondary brown #70584B satisfies WCAG AA (>= 4.5:1) on cream #faf7f2", () => {
  const secondaryLuminance = relativeLuminance(parseHexColor("#70584B"));
  const paperLuminance = relativeLuminance(parseHexColor("#faf7f2"));
  const contrast = contrastRatio(secondaryLuminance, paperLuminance);
  assert.ok(
    contrast >= 4.5,
    `Secondary brown #70584B on cream #faf7f2 must have contrast >= 4.5:1 (got ${contrast.toFixed(2)})`,
  );
});
