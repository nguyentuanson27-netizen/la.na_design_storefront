import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT_LAYOUT = new URL("../../src/app/layout.tsx", import.meta.url);
// Task 36: the site chrome the root layout renders through owns the landmark now. The layout is
// wiring, so the assertions below read the file the markup actually lives in.
const SITE_CHROME = new URL("../../src/routes/site-chrome.tsx", import.meta.url);
const SITE_HEADER = new URL(
  "../../src/components/brand/site-header.tsx",
  import.meta.url,
);
const ROUTE_GROUP_1 = [
  new URL("../../src/app/cart/page.tsx", import.meta.url),
  new URL("../../src/app/checkout/page.tsx", import.meta.url),
  new URL("../../src/app/checkout/success/page.tsx", import.meta.url),
  new URL("../../src/app/collections/[slug]/page.tsx", import.meta.url),
];
const ROUTE_GROUP_2 = [
  new URL("../../src/app/shop/[slug]/page.tsx", import.meta.url),
  new URL("../../src/app/track-order/page.tsx", import.meta.url),
];
const MAIN_OPENING_TAG = /<main(?:\s|>)/g;
const MAIN_CONTENT_ID = /\bid\s*=\s*["']main-content["']/g;
const SKIP_TARGET = /\bhref\s*=\s*["']#main-content["']/g;

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

async function collectLandmarkOffenders(
  routes: URL[],
): Promise<Record<string, { main: number; mainContentId: number }>> {
  const offenders: Record<string, { main: number; mainContentId: number }> = {};

  for (const url of routes) {
    const source = await readFile(url, "utf8");
    const main = countMatches(source, MAIN_OPENING_TAG);
    const mainContentId = countMatches(source, MAIN_CONTENT_ID);

    if (main > 0 || mainContentId > 0) {
      offenders[fileURLToPath(url)] = { main, mainContentId };
    }
  }

  return offenders;
}

test("the site chrome solely owns the main-content page landmark", async () => {
  const source = await readFile(SITE_CHROME, "utf8");

  assert.equal(countMatches(source, MAIN_OPENING_TAG), 1);
  assert.equal(countMatches(source, MAIN_CONTENT_ID), 1);
});

test("the root layout renders the landmark through the chrome rather than declaring its own", async () => {
  // The site-wide landmark is a single one or it is not a landmark. Asserting the layout declares
  // none keeps "exactly one" true across the two files the chrome now spans.
  const source = await readFile(ROOT_LAYOUT, "utf8");

  assert.equal(countMatches(source, MAIN_OPENING_TAG), 0);
  assert.equal(countMatches(source, MAIN_CONTENT_ID), 0);
});

test("U0a route group 1 leaves the page-level main landmark to the site chrome", async () => {
  assert.deepEqual(await collectLandmarkOffenders(ROUTE_GROUP_1), {});
});

test("U0a route group 2 leaves the page-level main landmark to the site chrome", async () => {
  assert.deepEqual(await collectLandmarkOffenders(ROUTE_GROUP_2), {});
});

test("shared skip link points once to the chrome-owned main-content target", async () => {
  const source = await readFile(SITE_HEADER, "utf8");

  assert.equal(countMatches(source, SKIP_TARGET), 1);
});
