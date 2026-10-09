import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

/**
 * The rendered contract of the reviewed GTM container, with no database fixtures.
 *
 * `src/tracking/reviewed-gtm-version.json` names GTM-PRZT92JR as the one container whose saved
 * version was exported, audited and recorded. The loader obeys that record AND the tracking mode, and
 * the CSP obeys the record, so the same container id must behave differently across modes:
 *
 *   - mode `preview`: the loader renders, `gtm.js` is requested once for exactly that container, and
 *     the dataLayer carries the tracking mode before the container starts.
 *   - mode absent (`disabled`): the container id is configured, the CSP admits Google, and still
 *     nothing loads and no dataLayer is published -- the case that used to bypass the interlock.
 *
 * The container request is aborted in the browser, so the run stays hermetic. A synthetic or
 * otherwise unreviewed container is covered by commerce-events.spec.ts (U18).
 */

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

const HOST = "127.0.0.1";
const REVIEWED_CONTAINER = "GTM-PRZT92JR";
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const VENDOR_ORIGINS = /googletagmanager|google-analytics|googleadservices|analytics\.tiktok/;

type RunningServer = { process: ChildProcess; baseUrl: string; output: () => string };

async function startServer(
  port: number,
  distDir: string,
  configure: (environment: NodeJS.ProcessEnv) => void,
): Promise<RunningServer> {
  const baseUrl = `http://${HOST}:${port}`;
  let output = "";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    // One server per build directory under Next 16 dev, each guarded by a lock file.
    NEXT_DIST_DIR: distDir,
    BETTER_AUTH_URL: baseUrl,
    APP_DOMAIN: `${HOST}:${port}`,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const name of ["LA_TRACKING_MODE", "LA_GTM_CONTAINER_ID", "NEXT_PUBLIC_GTM_CONTAINER_ID"]) {
    delete environment[name];
  }
  configure(environment);

  const child = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(port)], {
    cwd: APP_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`GTM spec server exited with ${child.exitCode}\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/about`, { redirect: "manual" });
      if (response.status === 200) return { process: child, baseUrl, output: () => output };
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the GTM spec server\n${output}`);
}

async function stopServer(server: RunningServer | undefined) {
  if (!server || server.process.exitCode !== null) return;
  server.process.kill("SIGTERM");
  const exited = await Promise.race([
    once(server.process, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.process.kill("SIGKILL");
    await Promise.race([once(server.process, "exit"), delay(5_000)]);
  }
}

/** Every request to a measurement or ad origin this page makes. The container itself is aborted. */
async function recordVendorRequests(page: Page): Promise<string[]> {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (VENDOR_ORIGINS.test(request.url())) requests.push(request.url());
  });
  await page.route(/googletagmanager\.com/, (route) => route.abort());
  return requests;
}

test.describe("reviewed container, tracking mode preview", () => {
  let server: RunningServer | undefined;

  test.beforeAll(async () => {
    server = await startServer(3340, ".next-test/gtm-reviewed-preview", (environment) => {
      environment.NEXT_PUBLIC_GTM_CONTAINER_ID = REVIEWED_CONTAINER;
      environment.LA_GTM_CONTAINER_ID = REVIEWED_CONTAINER;
      environment.LA_TRACKING_MODE = "preview";
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("loads exactly the reviewed container, after the mode is published, and admits it in the CSP", async ({
    page,
  }) => {
    const vendorRequests = await recordVendorRequests(page);
    const response = await page.goto(`${server!.baseUrl}/about`, { waitUntil: "networkidle" });

    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src[^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/www\.googletagmanager\.com/);

    expect(vendorRequests).toEqual([`https://www.googletagmanager.com/gtm.js?id=${REVIEWED_CONTAINER}`]);
    // The container snippet inserts its own loader element (the request itself is aborted above).
    await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveCount(1);
    await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveAttribute(
      "src",
      `https://www.googletagmanager.com/gtm.js?id=${REVIEWED_CONTAINER}`,
    );
    // Read from the server's own HTML: React keeps `noscript` children out of the hydrated client tree.
    expect(await response!.text()).toContain(`ns.html?id=${REVIEWED_CONTAINER}`);

    // The tracking mode must already be in the dataLayer when the container starts, so a container
    // that reads it sees `preview` rather than nothing.
    const layer = await page.evaluate(() => window.dataLayer ?? []);
    const modeIndex = layer.findIndex((entry) => entry.la_tracking_mode === "preview");
    const startIndex = layer.findIndex((entry) => entry.event === "gtm.js");
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeLessThan(startIndex);
  });
});

test.describe("reviewed container, tracking mode absent", () => {
  let server: RunningServer | undefined;

  test.beforeAll(async () => {
    server = await startServer(3341, ".next-test/gtm-reviewed-disabled", (environment) => {
      // Only the build-time public id is set: the CSP opens, but the tracking mode is `disabled`.
      environment.NEXT_PUBLIC_GTM_CONTAINER_ID = REVIEWED_CONTAINER;
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a configured, reviewed container still loads nothing and publishes no dataLayer", async ({ page }) => {
    const vendorRequests = await recordVendorRequests(page);
    const response = await page.goto(`${server!.baseUrl}/about`, { waitUntil: "networkidle" });

    // The policy is a build-time fact and does not know the mode...
    expect(response?.headers()["content-security-policy"] ?? "").toContain("googletagmanager.com");
    // ...but the loader does, so the container is neither requested nor present.
    expect(vendorRequests).toEqual([]);
    expect(await page.locator('script[src*="googletagmanager.com"]').count()).toBe(0);
    expect(await response!.text()).not.toContain("ns.html?id=GTM");
    expect(await page.evaluate(() => window.dataLayer === undefined)).toBe(true);
  });
});
