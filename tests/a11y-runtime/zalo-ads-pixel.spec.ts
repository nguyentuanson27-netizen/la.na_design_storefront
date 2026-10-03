import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Zalo Ads Pixel's privacy boundary, in a browser, with an id configured.
 *
 * ztracker.js reports the live `document.URL` with every beacon (docs/integrations/zalo-ads-pixel.md),
 * so the storefront must keep it off URLs that carry shopper input and cut it off when the URL turns
 * into one. The rest of CI builds without an id, and Zalo's script is unreachable from CI and must
 * not be contacted from a test, so this spec runs its own server and stands in for the tracker with
 * the one behaviour the boundary is about: a page view on load and a frequent heartbeat, each a 1x1
 * image on Zalo's reporting origin carrying the live URL.
 */

const HOST = "127.0.0.1";
const PORT = 3338;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const PIXEL_ID = "7242087840828522496";
const SECRET = "alice@example.com";
const HEARTBEAT_MS = 200;

const TRACKER_STUB = `(function(){
  function beacon(type){
    var image = new Image();
    image.src = 'https://log.adtimaserver.vn/tracklp?type=' + type + '&curl=' + encodeURIComponent(document.URL);
  }
  beacon('pageview');
  setInterval(function(){ beacon('page_heartbeat'); }, ${HEARTBEAT_MS});
})();`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js Zalo pixel server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/contact`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Zalo pixel server\n${serverOutput}`);
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

type Observed = {
  trackerRequests: number;
  /** Beacon URLs that left the page -- a request the CSP blocks never reaches the route. */
  beacons: string[];
  zaloCspViolations: number;
};

async function observeZalo(page: Page): Promise<Observed> {
  const observed: Observed = { trackerRequests: 0, beacons: [], zaloCspViolations: 0 };
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text()) && message.text().includes("log.adtimaserver.vn")) {
      observed.zaloCspViolations += 1;
    }
  });
  await page.route("https://s.zzcdn.me/**", async (route: Route) => {
    observed.trackerRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/javascript", body: TRACKER_STUB });
  });
  await page.route("https://log.adtimaserver.vn/**", async (route: Route) => {
    observed.beacons.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/gif", body: "" });
  });
  return observed;
}

const leaked = (observed: Observed) => observed.beacons.filter((url) => url.includes(encodeURIComponent(SECRET)));
const pixelState = (page: Page) => page.evaluate(() => document.documentElement.dataset.laZaloAdsPixel ?? null);

async function waitForBeacons(observed: Observed, atLeast: number) {
  await expect.poll(() => observed.beacons.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(atLeast);
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // One dev server per build directory; see facebook-pixel.spec.ts.
      NEXT_DIST_DIR: ".next-test/zalo-ads-pixel",
      NEXT_PUBLIC_ZALO_ADS_PIXEL_ID: PIXEL_ID,
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
});

test("a safe landing loads the official tag once and reports", async ({ page }) => {
  const observed = await observeZalo(page);
  await page.goto(`${BASE_URL}/contact?zaclid=abc123&zsrcid=99`, { waitUntil: "load" });

  await waitForBeacons(observed, 2);
  expect(await pixelState(page)).toBe("loaded");
  expect(observed.trackerRequests).toBe(1);
  expect(await page.locator("script#zalo-ads-pixel").getAttribute("src")).toBe(
    `https://s.zzcdn.me/ztr/ztracker.js?id=${PIXEL_ID}`,
  );
  expect(observed.zaloCspViolations).toBe(0);
});

test("safe load, then an unsafe hash mutation: Zalo's reporting origin is blocked", async ({ page }) => {
  const observed = await observeZalo(page);
  await page.goto(`${BASE_URL}/contact`, { waitUntil: "load" });
  await waitForBeacons(observed, 2);

  await page.evaluate((secret) => {
    window.location.hash = secret;
  }, SECRET);
  await expect.poll(() => pixelState(page)).toBe("quarantined");
  await page.waitForTimeout(HEARTBEAT_MS * 6);

  expect(leaked(observed)).toEqual([]);
  expect(observed.zaloCspViolations).toBeGreaterThan(0);
  await expect(page.locator("meta#zalo-ads-pixel-quarantine")).toHaveAttribute("http-equiv", "Content-Security-Policy");
});

test("one of the site's own anchors keeps tracking", async ({ page }) => {
  const observed = await observeZalo(page);
  await page.goto(`${BASE_URL}/contact`, { waitUntil: "load" });
  await waitForBeacons(observed, 2);

  await page.evaluate(() => {
    window.location.hash = "main-content";
  });
  const before = observed.beacons.length;
  await waitForBeacons(observed, before + 2);
  expect(await pixelState(page)).toBe("loaded");
  expect(observed.beacons.at(-1)).toContain(encodeURIComponent(`${BASE_URL}/contact#main-content`));
});

test("a header search after load never reports the search term", async ({ page }) => {
  const observed = await observeZalo(page);
  await page.goto(`${BASE_URL}/contact`, { waitUntil: "load" });
  await waitForBeacons(observed, 2);

  await page.getByRole("button", { name: /tìm kiếm/i }).first().click();
  await page.getByLabel("Nhập từ khóa tìm kiếm").fill(SECRET);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/shop\?q=/);
  await page.waitForTimeout(HEARTBEAT_MS * 6);

  expect(await pixelState(page)).toBe("quarantined");
  expect(leaked(observed)).toEqual([]);
});

test("shopper input in the address or a same-origin referrer keeps the tracker out", async ({ page }) => {
  const observed = await observeZalo(page);

  await page.goto(`${BASE_URL}/shop?q=${encodeURIComponent(SECRET)}`, { waitUntil: "load" });
  await expect.poll(() => pixelState(page)).toBe("blocked");

  await page.goto(`${BASE_URL}/track-order?order=LA-TEST123`, { waitUntil: "load" });
  await expect.poll(() => pixelState(page)).toBe("blocked");

  // Attribution-shaped keys and anchor-shaped fragments do not launder customer identifiers.
  for (const path of ["/contact?utm_term=0900000000", "/contact?zaclid=0900000000", "/contact#0900000000", "/contact#LA-TEST123"]) {
    // A fresh document each time: a hash-only goto would be a same-document navigation.
    await page.goto("about:blank");
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "load" });
    await expect.poll(() => pixelState(page)).toBe("blocked");
  }

  await page.goto(`${BASE_URL}/contact`, {
    waitUntil: "load",
    referer: `${BASE_URL}/shop?q=${encodeURIComponent(SECRET)}`,
  });
  await expect.poll(() => pixelState(page)).toBe("blocked");

  await page.waitForTimeout(HEARTBEAT_MS * 3);
  expect(observed.trackerRequests).toBe(0);
  expect(observed.beacons).toEqual([]);
});
