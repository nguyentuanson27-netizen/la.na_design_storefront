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
