import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The collection promo tile's link contract (docs/specs/homepage-editorial-refresh.md §7.3):
 *
 * - desktop: the image/tile is not a link, only the CTA is clickable;
 * - mobile: the whole tile taps through to the same destination;
 * - one canonical anchor per tile, never nested links.
 *
 * Both breakpoints share one element -- the CTA -- and only its hit area changes, so the contract is
 * a property of the markup plus one media-scoped rule. It is pinned here at source level because the
 * shipped config maps no promo slot yet, so no runtime fixture can render a row; the browser
 * verification recorded on the PR exercises the same contract with elementFromPoint.
 */

const COMPONENT = new URL("../../src/components/brand/collection-promo-row.tsx", import.meta.url);
const STYLESHEET = new URL("../../src/app/globals.css", import.meta.url);

/** Every top-level `@media (...) { ... }` block, with its condition. */
function mediaBlocks(css: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  const pattern = /@media\s*([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (depth > 0 && index < css.length) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push({ condition: match[1]!.trim(), body: css.slice(pattern.lastIndex, index - 1) });
    pattern.lastIndex = index;
  }
  return blocks;
}

function withoutMediaBlocks(css: string): string {
  let result = css;
  for (const block of mediaBlocks(css)) result = result.replace(block.body, "");
  return result;
}

test("each promo tile has exactly one anchor, the CTA, and the image is not inside it", async () => {
  const source = await readFile(COMPONENT, "utf8");

  assert.equal(source.match(/<Link\b/g)?.length, 1, "one Link per tile");
  assert.equal(/<a\b/.test(source), false, "no raw anchors beside the Link");
  assert.match(source, /<Link className="collection-promo__cta" href=\{tile\.href\}>/);

  // The image is rendered before, and outside, the only anchor.
  const linkStart = source.indexOf("<Link");
  const linkEnd = source.indexOf("</Link>");
  const imageAt = source.indexOf("<Image");
  assert.ok(imageAt !== -1 && (imageAt < linkStart || imageAt > linkEnd), "the image is not a link");
  assert.equal(source.slice(linkStart, linkEnd).includes("<Link", 1), false, "no nested link");
});

test("the CTA's accessible name carries the collection's canonical title", async () => {
  const source = await readFile(COMPONENT, "utf8");
  assert.match(source, /\{tile\.ctaLabel\}\s*<span className="sr-only">: \{tile\.title\}<\/span>/);
});

test("the stretched whole-tile hit area exists only at the mobile breakpoint", async () => {
  const css = await readFile(STYLESHEET, "utf8");

  const stretched = mediaBlocks(css).filter((block) =>
    block.body.includes(".collection-promo__cta::after"),
  );
  assert.equal(stretched.length, 1, "exactly one place stretches the CTA");
  assert.equal(stretched[0]!.condition, "(max-width: 900px)");
  assert.match(stretched[0]!.body, /\.collection-promo__cta::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/);

  // Nowhere else -- in particular not at desktop width -- may the CTA be stretched over the tile.
  assert.equal(withoutMediaBlocks(css).includes(".collection-promo__cta::after"), false);

  // The tile is the stretched area's containing block, and the copy box is not positioned (an
  // absolutely positioned copy box would capture the stretch and shrink it to the caption).
  assert.match(css, /\.collection-promo\s*\{[^}]*position:\s*relative;/);
  const copyRule = css.match(/\.collection-promo__copy\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.equal(/position:/.test(copyRule), false);
});
