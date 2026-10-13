import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page, type Route } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

/**
 * A configured pixel with `LA_META_FIRST_PARTY_COOKIES_ENABLED` off: the production default until
 * the owner switches it on, and the state after switching it back off.
 *
 * Off has to mean off for a browser that still holds an `la_vid` issued while it was on. The proxy
 * only expires that cookie on a storefront page load, so a visitor whose first page is private
 * (here `/login`) and who then moves into the storefront by client-side navigation still carries
 * it. Neither the pixel nor the Conversions API may send it.
 */

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown; queue?: unknown[] };
    __fbqCalls?: unknown[][];
  }
}

const HOST = "127.0.0.1";
const PORT = 3343;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_024;
const PIXEL_ID = "123456789012345";
const STALE_VISITOR_ID = "ab".repeat(32);
test.use({ extraHTTPHeaders: { "x-ci-client-ip": "203.0.113.78" } });
const captureFile = join(mkdtempSync(join(tmpdir(), "la-meta-off-")), "events.jsonl");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js cookies-off server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for cookies-off server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(5_000)]);
  }
  server = undefined;
}

/** Stands in for `fbevents.js`: keeps what the snippet queued, then records every later call. */
const PIXEL_LIBRARY_STUB = `(function(){
  var original = window.fbq;
  window.__fbqCalls = (original && original.queue) ? [].slice.call(original.queue) : [];
  var shim = function(){ window.__fbqCalls.push([].slice.call(arguments)); };
  shim.callMethod = shim; shim.loaded = true; shim.version = '2.0'; shim.queue = [];
  window.fbq = shim; window._fbq = shim;
})();`;

async function installPixelStub(page: Page, blocked = false) {
  await page.route("https://connect.facebook.net/**", (route: Route) =>
    blocked
      ? route.abort()
      : route.fulfill({ status: 200, contentType: "application/javascript", body: PIXEL_LIBRARY_STUB }));
  await page.route("https://www.facebook.com/**", (route: Route) => route.fulfill({ status: 200, body: "" }));
}

function readCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window.__fbqCalls ?? []).map((call) => Array.from(call)));
}

function readServerEvents(): Array<Record<string, unknown>> {
  return existsSync(captureFile)
    ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function readCookie(page: Page, name: string) {
  return (await page.context().cookies(BASE_URL)).find((cookie) => cookie.name === name);
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // One dev server per build directory; see facebook-pixel.spec.ts.
      NEXT_DIST_DIR: ".next-test/facebook-pixel-cookies-off",
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: PIXEL_ID,
      FACEBOOK_CAPI_ACCESS_TOKEN: "synthetic-meta-test-token",
      FACEBOOK_GRAPH_API_VERSION: "v26.0",
      FACEBOOK_CAPI_TEST_EVENT_CODE: "",
      LA_META_FIRST_PARTY_COOKIES_ENABLED: "false",
      META_TEST_CAPTURE_FILE: captureFile,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(resolve(import.meta.dirname, "meta-capi.stub.mjs")).href}`,
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_IP_HEADER: "x-ci-client-ip",
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.beforeEach(async () => {
  await prisma.rateLimit.deleteMany({ where: { id: { startsWith: "meta-signal:" } } });
});

test.afterAll(async () => {
  await stopServer();
  await prisma.$disconnect();
});

test("switched off, an la_vid issued earlier reaches Meta from neither the pixel nor the server", async ({ page, context }) => {
  await context.addCookies([{ name: "la_vid", value: STALE_VISITOR_ID, url: BASE_URL }]);
  await installPixelStub(page);
  const start = readServerEvents().length;

  // A private first page: the proxy leaves cookies alone here, so the stale ID survives it.
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  // Into the storefront by client-side navigation, which is not a page load either.
  await page.locator("header a[href='/']").first().click();
  await expect(page).toHaveURL(`${BASE_URL}/`);
  expect((await readCookie(page, "la_vid"))?.value).toBe(STALE_VISITOR_ID);

  await expect
    .poll(async () => (await readCalls(page)).filter((call) => call[0] === "track" && call[1] === "PageView").length)
    .toBe(1);
  const calls = await readCalls(page);
  expect(calls.filter((call) => call[0] === "init")).toEqual([["init", PIXEL_ID, {}]]);

  const pageView = calls.find((call) => call[0] === "track" && call[1] === "PageView")!;
  const eventId = (pageView[3] as { eventID: string }).eventID;
  await expect.poll(() => readServerEvents().slice(start).filter((event) => event.event_id === eventId).length).toBe(1);
  const twin = readServerEvents().slice(start).find((event) => event.event_id === eventId)!;
  expect(Object.keys(twin.user_data as Record<string, unknown>)).not.toContain("external_id");
  expect(JSON.stringify(readServerEvents().slice(start))).not.toContain(STALE_VISITOR_ID);

  // The first storefront page load expires the stale ID for good.
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  expect(await readCookie(page, "la_vid")).toBeUndefined();
});

test("switched off, the server writes neither cookie, even for an ad click", async ({ page }) => {
  // Blocked: anything Meta-related in the jar could only have come from the server.
  await installPixelStub(page, true);
  await page.goto(`${BASE_URL}/shop?fbclid=OffSwitchClick_1`, { waitUntil: "networkidle" });

  expect(await readCookie(page, "_fbc")).toBeUndefined();
  expect(await readCookie(page, "la_vid")).toBeUndefined();
});
