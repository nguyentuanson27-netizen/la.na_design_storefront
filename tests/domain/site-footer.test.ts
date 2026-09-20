import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * The mobile footer disclosures. `tests/a11y-runtime/footer-support.spec.ts` drives them in a real
 * browser at both viewports; this is the fast gate over the two decisions that spec cannot see the
 * reason for -- that which control is in play is a stylesheet decision rather than a measured one,
 * and that the desktop footer is never the one collapsing.
 */
test("F9a mobile footer: link columns collapse behind a disclosure, and only on mobile", () => {
  const group = read("src/components/brand/footer-nav-group.tsx");
  const footer = read("src/components/brand/site-footer.tsx");
  const css = read("src/app/globals.css");

  // Every link column goes through the one component, so none of them can drift back to an
  // always-expanded list.
  assert.equal(
    (footer.match(/<FooterNavGroup/g) ?? []).length,
    3,
    "Mua sắm, Hỗ trợ khách hàng and Thông tin & chính sách are the three collapsible columns",
  );
  assert.ok(
    !/<h2 className="footer-heading">/.test(footer),
    "a hand-rolled link column would bypass the disclosure entirely",
  );

  // React owns the open state and nothing else: no viewport measurement, which would render the
  // expanded desktop column on every phone and then collapse it once hydration lands.
  assert.match(group, /data-open=\{isOpen\}/);
  assert.match(group, /aria-expanded=\{isOpen\}/);
  assert.match(group, /aria-controls=\{panelId\}/);
  assert.doesNotMatch(
    group,
    /matchMedia\s*\(/,
    "which control is in play is a stylesheet decision, not a measured one",
  );

  // Both controls ship; the stylesheet shows exactly one, so the panel's visibility and
  // `aria-expanded` cannot disagree and no dead button sits in the desktop tab order.
  assert.match(css, /\.footer-disclosure \{[^}]*display:\s*none;/);
  assert.match(
    css,
    /@media \(max-width: 640px\) \{[\s\S]*?\.footer-heading__static \{\s*display:\s*none;\s*\}/,
    "the static heading gives way to the disclosure only on the single-column footer",
  );
  assert.match(
    css,
    /@media \(max-width: 640px\) \{[\s\S]*?\.footer-group\[data-open="false"\] \.footer-panel \{\s*display:\s*none;\s*\}/,
    "a closed group hides its panel, and only below the single-column breakpoint",
  );
});

/**
 * The disclosure is a React button, so scripting disabled means it can never open. §33 guarantees
 * such a visitor keeps every link, which is the half the browser tests could not see until one of
 * them ran with JavaScript off -- and the half a later edit to the mobile rules can silently drop,
 * because nothing else in the stylesheet refers to it.
 */
test("F9a mobile footer: a visitor without JavaScript keeps every link and no dead disclosure", () => {
  const footer = read("src/components/brand/site-footer.tsx");
  const css = read("src/app/globals.css");

  const noscript = footer.match(/<noscript>[\s\S]*?<\/noscript>/);
  assert.ok(noscript, "the footer must ship a <noscript> fallback for the collapsed groups");
  assert.match(
    footer,
    /const NO_SCRIPT_FOOTER_CSS = `[\s\S]*?`;/,
    "the fallback stylesheet is a code-authored constant, not assembled at render time",
  );

  const fallback = footer.match(/const NO_SCRIPT_FOOTER_CSS = `([\s\S]*?)`;/)?.[1] ?? "";
  assert.match(fallback, /@media \(max-width: 640px\)/, "the fallback is scoped to the same breakpoint");

  // Each rule the mobile block applies has to be reversed, or a no-JS visitor is left with either a
  // hidden panel or a button that does nothing.
  for (const [rule, reversal] of [
    ["\\.footer-heading__static \\{\\s*display:\\s*none;", /\.footer-heading__static \{ display: inline; \}/],
    ["\\.footer-disclosure \\{\\s*display:\\s*inline-flex;", /\.footer-disclosure \{ display: none; \}/],
    [
      "\\.footer-group\\[data-open=\"false\"\\] \\.footer-panel \\{\\s*display:\\s*none;",
      /\.footer-group\[data-open=false\] \.footer-panel \{ display: block; \}/,
    ],
  ] as const) {
    assert.match(
      css,
      new RegExp(`@media \\(max-width: 640px\\) \\{[\\s\\S]*?${rule}`),
      `globals.css must still apply the rule the fallback reverses: ${rule}`,
    );
    assert.match(fallback, reversal, `the <noscript> fallback must reverse ${rule}`);
  }

  // The reversal has to win on specificity rather than on where the browser puts this stylesheet.
  assert.ok(
    fallback
      .split("\n")
      .filter((line) => line.includes("{") && !line.includes("@media"))
      .every((line) => line.trim().startsWith(":root ")),
    "every fallback rule must carry the :root prefix that outranks the rule it reverses",
  );

  // Escaping the attribute value would leave the selector matching nothing.
  assert.ok(
    !fallback.includes('data-open="false"'),
    "the fallback's attribute value stays unquoted so it survives HTML escaping",
  );
});
