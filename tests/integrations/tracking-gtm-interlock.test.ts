import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("T8 GTM container is delivered strictly through GoogleTagManager; no other source delivers vendor markers", async () => {
  const files = await collectSourceFiles(SOURCE_ROOT);
  assert.ok(files.length > 0, "expected application sources to scan");

  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith("google-tag-manager.tsx")) continue;
    const contents = await readFile(file, "utf8");
    for (const marker of VENDOR_DELIVERY_MARKERS) {
      if (contents.includes(marker)) offenders.push(`${file}: ${marker}`);
    }
  }

  assert.deepEqual(offenders, [], "T8 delivers GTM strictly through GoogleTagManager; no other source delivers vendor markers");
});

type NextConfigLike = {
  headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
};

type ReviewedRecord = {
  containerId: string | null;
  versionId: string | null;
  exportPath: string | null;
  exportSha256: string | null;
  approvedDestinations: object | null;
};

const REVIEWED_RECORD: ReviewedRecord = {
  containerId: "GTM-PRZT92JR",
  versionId: "7",
  exportPath: "docs/gtm/GTM-PRZT92JR-v7.json",
  exportSha256: "a".repeat(64),
  approvedDestinations: { ga4MeasurementIds: [], googleAdsConversions: [], tiktokPixelIds: [] },
};

/**
 * Loads `next.config.mjs`'s CSP. With `record`, the config is copied beside a temporary reviewed
 * record so the "reviewed" branch can be exercised without editing the repository's real record.
 */
async function readCsp(cacheBuster = "", record?: ReviewedRecord): Promise<string> {
  let configPath = resolve("next.config.mjs");
  if (record !== undefined) {
    const dir = await mkdtemp(join(tmpdir(), "reviewed-gtm-"));
    await mkdir(join(dir, "src", "tracking"), { recursive: true });
    await cp(configPath, join(dir, "next.config.mjs"));
    await writeFile(
      join(dir, "src", "tracking", "reviewed-gtm-version.json"),
      JSON.stringify(record),
    );
    configPath = join(dir, "next.config.mjs");
  }
  const configUrl = pathToFileURL(configPath).href + cacheBuster;
  const { default: nextConfig } = (await import(configUrl)) as { default: NextConfigLike };
  assert.equal(typeof nextConfig.headers, "function");
  const rules = await nextConfig.headers!();
  const globalRule = rules.find(({ source }) => source === "/(.*)");
  assert.ok(globalRule);
  const csp = new Map(globalRule.headers.map(({ key, value }) => [key, value])).get(
    "Content-Security-Policy",
  );
  assert.ok(csp);
  return csp;
}

test("the production Content-Security-Policy opens no Google or TikTok origin when unconfigured", async () => {
  const originalGtm = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  const originalLaGtm = process.env.LA_GTM_CONTAINER_ID;
  delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  delete process.env.LA_GTM_CONTAINER_ID;

  try {
    const csp = await readCsp(`?unconfigured-gtm-${Date.now()}`);
    for (const origin of [
      "googletagmanager",
      "google-analytics",
      "googleadservices",
      "googlesyndication",
      "tiktok",
    ]) {
      assert.equal(
        csp.includes(origin),
        false,
        `${origin} must stay closed in the CSP until GTM container ID is configured`,
      );
    }
    assert.doesNotMatch(csp, /'unsafe-eval'/, "production must not carry unsafe-eval");
  } finally {
    if (originalGtm !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalGtm;
    if (originalLaGtm !== undefined) process.env.LA_GTM_CONTAINER_ID = originalLaGtm;
  }
});

test("a configured AND reviewed GTM container opens Google Tag Manager and Analytics origins in the CSP", async () => {
  const originalGtm = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-PRZT92JR";

  try {
    const csp = await readCsp(`?configured-gtm-${Date.now()}`, REVIEWED_RECORD);

    assert.match(csp, /script-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(csp, /img-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/www\.google-analytics\.com/);
    assert.doesNotMatch(csp, /'unsafe-eval'/, "production must not carry unsafe-eval");
    assert.doesNotMatch(csp, /\*/, "production must not carry wildcards");
  } finally {
    if (originalGtm !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalGtm;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  }
});

test("an empty public GTM id does not mask the server id in the CSP", async () => {
  const originalPublic = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  const originalServer = process.env.LA_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "";
  process.env.LA_GTM_CONTAINER_ID = "GTM-PRZT92JR";

  try {
    const csp = await readCsp(`?empty-public-gtm-${Date.now()}`, REVIEWED_RECORD);
    assert.match(csp, /script-src[^;]*https:\/\/www\.googletagmanager\.com/);
  } finally {
    if (originalPublic !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalPublic;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
    if (originalServer !== undefined) process.env.LA_GTM_CONTAINER_ID = originalServer;
    else delete process.env.LA_GTM_CONTAINER_ID;
  }
});

test("conflicting public and server GTM ids fail the config", async () => {
  const originalPublic = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  const originalServer = process.env.LA_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-PRZT92JR";
  process.env.LA_GTM_CONTAINER_ID = "GTM-OTHER123";

  try {
    await assert.rejects(
      readCsp(`?conflicting-gtm-${Date.now()}`, REVIEWED_RECORD),
      /both set and differ/,
    );
  } finally {
    if (originalPublic !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalPublic;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
    if (originalServer !== undefined) process.env.LA_GTM_CONTAINER_ID = originalServer;
    else delete process.env.LA_GTM_CONTAINER_ID;
  }
});

test("a configured but UNREVIEWED GTM container keeps the CSP closed", async () => {
  const originalGtm = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-PRZT92JR";

  try {
    const empty = {
      containerId: null,
      versionId: null,
      exportPath: null,
      exportSha256: null,
      approvedDestinations: null,
    };
    const otherContainer = { ...REVIEWED_RECORD, containerId: "GTM-OTHER123" };
    const noChecksum = { ...REVIEWED_RECORD, exportSha256: null };
    for (const [label, record] of [
      ["no reviewed record", empty],
      ["a different reviewed container", otherContainer],
      ["a record without an export checksum", noChecksum],
    ] as const) {
      const csp = await readCsp(`?unreviewed-${label}-${Date.now()}`, record);
      assert.equal(csp.includes("googletagmanager"), false, `${label} must keep the CSP closed`);
    }
    // The repository's own record reviews GTM-PRZT92JR only, so any other container id is closed on
    // the real config too.
    process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-OTHER123";
    const real = await readCsp(`?unreviewed-real-${Date.now()}`);
    assert.equal(real.includes("googletagmanager"), false);
  } finally {
    if (originalGtm !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalGtm;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  }
});

test("the repository's own reviewed record opens the CSP for GTM-PRZT92JR and nothing else", async () => {
  const originalGtm = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-PRZT92JR";

  try {
    const csp = await readCsp(`?real-reviewed-${Date.now()}`);
    assert.match(csp, /script-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/www\.googletagmanager\.com/);
    // The reviewed TikTok Base loads events.js, which `connect-src` alone would not allow.
    assert.match(csp, /script-src[^;]*https:\/\/analytics\.tiktok\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/analytics\.tiktok\.com/);
    assert.doesNotMatch(csp, /\*/, "no wildcard origin");
    assert.doesNotMatch(csp, /'unsafe-eval'/, "production must not carry unsafe-eval");
  } finally {
    if (originalGtm !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalGtm;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  }
});

test("TikTok's origin follows the reviewed record's TikTok approval, not just the container", async () => {
  const originalGtm = process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = "GTM-PRZT92JR";

  try {
    // A reviewed container with no approved TikTok pixel opens Google but never TikTok.
    const withoutTikTok = await readCsp(`?reviewed-no-tiktok-${Date.now()}`, REVIEWED_RECORD);
    assert.match(withoutTikTok, /script-src[^;]*https:\/\/www\.googletagmanager\.com/);
    assert.equal(withoutTikTok.includes("tiktok"), false);

    const withTikTok = await readCsp(`?reviewed-tiktok-${Date.now()}`, {
      ...REVIEWED_RECORD,
      approvedDestinations: { ga4MeasurementIds: [], googleAdsConversions: [], tiktokPixelIds: ["PIXEL12345"] },
    });
    assert.match(withTikTok, /script-src[^;]*https:\/\/analytics\.tiktok\.com/);
    assert.match(withTikTok, /connect-src[^;]*https:\/\/analytics\.tiktok\.com/);
    // Only what is justified is opened: no TikTok image origin, and nothing for an unreviewed id.
    assert.doesNotMatch(withTikTok, /img-src[^;]*tiktok/);
  } finally {
    if (originalGtm !== undefined) process.env.NEXT_PUBLIC_GTM_CONTAINER_ID = originalGtm;
    else delete process.env.NEXT_PUBLIC_GTM_CONTAINER_ID;
  }
});

test("T3 every requested tracking mode resolves to zero GTM load in tracking config", () => {
  for (const desiredMode of TRACKING_MODES) {
    const runtime = resolveTrackingRuntime({
      desiredMode,
      containerId: desiredMode === "disabled" ? null : "GTM-ABC123",
    });
    assert.equal(runtime.loadsGoogleTagManager, false, `${desiredMode} must not load GTM in tracking config`);
  }
});

test("T8 the site chrome mounts the tracking bootstrap, GTM, and other pixel mounts", async () => {
  const chrome = await readFile(new URL("../../src/routes/site-chrome.tsx", import.meta.url), "utf8");

  const bootstrapIndex = chrome.indexOf("<TrackingBootstrap");
  const gtmIndex = chrome.indexOf("<GoogleTagManager");
  const childrenIndex = chrome.indexOf("{children}");
  const pageViewIndex = chrome.indexOf("<TrackingPageView");

  assert.notEqual(bootstrapIndex, -1, "the tracking bootstrap must be mounted");
  assert.notEqual(gtmIndex, -1, "the Google Tag Manager component must be mounted");
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
  assert.equal(
    chrome.match(/<ChatGptAdsPixel\s*\/>/g)?.length,
    1,
    "the ChatGPT Ads Pixel mount must stay exactly once",
  );
  assert.equal(
    chrome.match(/<ZaloAdsPixel\s*\/>/g)?.length,
    1,
    "the Zalo Ads Pixel mount must stay exactly once",
  );
});

test("T3 the root layout reaches the tracking mounts only through the site chrome", async () => {
  const layout = await readFile(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");

  assert.match(layout, /<SiteChrome\b/, "the layout must render the chrome shell");
  assert.doesNotMatch(
    layout,
    /@\/components\//,
    "the layout must not reach a component directly, chrome or otherwise",
  );
});