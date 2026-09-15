import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTrackingRuntime, TRACKING_MODES } from "../../src/tracking/config.ts";

const SOURCE_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

const VENDOR_DELIVERY_MARKERS = [
  "googletagmanager.com",
  "google-analytics.com",
  "googleadservices.com",
  "googlesyndication.com",
  "analytics.tiktok.com",
  "gtm.js",
  "gtag/js",
  "ns.html?id=GTM",
] as const;

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      files.push(...(await collectSourceFiles(path)));
      continue;
    }
    if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("T3 no application source delivers a GTM or vendor measurement script", async () => {
  const files = await collectSourceFiles(SOURCE_ROOT);
  assert.ok(files.length > 0, "expected application sources to scan");

  const offenders: string[] = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const marker of VENDOR_DELIVERY_MARKERS) {
      if (contents.includes(marker)) offenders.push(`${file}: ${marker}`);
    }
  }

  assert.deepEqual(offenders, [], "PR-A prepares the dataLayer only; T8 owns the first GTM load");
});

test("T3 the production Content-Security-Policy opens no Google or TikTok origin", async () => {
  const config = await readFile(new URL("../../next.config.mjs", import.meta.url), "utf8");

  for (const origin of [
    "googletagmanager",
    "google-analytics",
    "googleadservices",
    "googlesyndication",
    "tiktok",
  ]) {
    assert.equal(
      config.includes(origin),
      false,
      `${origin} must stay closed in the CSP until the reviewed GTM integration needs it`,
    );
  }
  assert.equal(
    /unsafe-eval/.test(config.replace(/isDevelopment \? " 'unsafe-eval'" : ""/, "")),
    false,
    "production must not carry a convenience unsafe-eval allowance",
  );
});

test("T3 every requested tracking mode resolves to zero GTM load", () => {
  for (const desiredMode of TRACKING_MODES) {
    const runtime = resolveTrackingRuntime({
      desiredMode,
      containerId: desiredMode === "disabled" ? null : "GTM-ABC123",
    });
    assert.equal(runtime.loadsGoogleTagManager, false, `${desiredMode} must not load GTM`);
  }
});

test("T3 the site chrome mounts the tracking bootstrap before content and keeps one direct Meta mount", async () => {
  // Task 36 moved these mounts out of the root layout and into the chrome shell, which places them
  // unconditionally. The file changed; what is asserted about it did not.
  const chrome = await readFile(new URL("../../src/routes/site-chrome.tsx", import.meta.url), "utf8");

  const bootstrapIndex = chrome.indexOf("<TrackingBootstrap");
  const childrenIndex = chrome.indexOf("{children}");
  const pageViewIndex = chrome.indexOf("<TrackingPageView");

  assert.notEqual(bootstrapIndex, -1, "the tracking bootstrap must be mounted");
  assert.notEqual(pageViewIndex, -1, "the canonical page-view authority must be mounted");
  assert.ok(
    bootstrapIndex < childrenIndex,
    "the dataLayer and consent defaults must be established before page content",
  );

  assert.equal(
    chrome.match(/<FacebookPixel\s*\/>/g)?.length,
    1,
    "the direct Meta mount must stay exactly once",
  );
});

test("T3 the root layout reaches the tracking mounts only through the site chrome", async () => {
  // The mounts above are site-wide because the layout renders the chrome and nothing else. A layout
  // that reached past it -- rendering the brand document or the masthead directly -- would ship a
  // storefront with no dataLayer and no page-view authority, and every assertion above would still
  // pass. This is what stops that.
  const layout = await readFile(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");

  assert.match(layout, /<SiteChrome\b/, "the layout must render the chrome shell");
  assert.doesNotMatch(
    layout,
    /@\/components\//,
    "the layout must not reach a component directly, chrome or otherwise",
  );
});
