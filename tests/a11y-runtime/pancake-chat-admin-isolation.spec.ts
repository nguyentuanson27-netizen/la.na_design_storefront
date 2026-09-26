/**
 * The Pancake chat widget's two boundaries, in a real browser (PR review on the widget):
 *
 * - host: it loads only when the page is actually served on the production host. The app is served
 *   here under both 127.0.0.1 and, through a request proxy, `https://www.lanadesign.vn`; only the
 *   second may request Pancake's script.
 * - admin: third-party code that has run cannot be unloaded, so a client-side navigation back into
 *   admin from a storefront page where Pancake ran must land in a fresh document with no Pancake DOM,
 *   script or runtime.
 *
 * Pancake itself is stubbed: the stub script does what the real one does to the page -- defines
 * `window.PancakeChatPlugin` and appends `#pancake-chat-plugin-root` to `<body>` -- and counts its
 * own requests.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { OFFICIAL_PRODUCTION_STOREFRONT_HOST } from "../../src/commerce/storefront-origin.ts";
import { prisma } from "../../src/db/prisma.ts";

const HOST = "127.0.0.1";
const PORT = 3337;
const BASE_URL = `http://${HOST}:${PORT}`;
const PRODUCTION_ORIGIN = `https://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `pancake-chat-isolation-${runId}@example.invalid`;
const password = "pancake-chat-isolation-runtime-password-123";

const PANCAKE_STUB = `
  window.__pancakeStubRuns = (window.__pancakeStubRuns || 0) + 1;
  window.PancakeChatPlugin = {};
  var root = document.createElement("div");
  root.id = "pancake-chat-plugin-root";
  root.style.cssText = "position:fixed;right:20px;bottom:20px;width:60px;height:60px;z-index:2147483647";
  document.body.appendChild(root);
`;

let server: ChildProcess | undefined;
let serverOutput = "";
let sessionCookies: Array<{ name: string; value: string }> = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // still compiling
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
}

/** Counts every request for Pancake's script and answers it with the stub. */
async function stubPancake(context: BrowserContext) {
  const requests: string[] = [];
  await context.route("https://chat-plugin.pancake.vn/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/javascript", body: PANCAKE_STUB });
  });
  return requests;
}

/**
 * Serves the app under the production origin: every request the browser makes to it is answered by
 * the local server, so the page's `location.hostname` is the production host.
 */
async function serveAsProduction(context: BrowserContext) {
  await context.route(`${PRODUCTION_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const headers = { ...request.headers(), host: `${HOST}:${PORT}` };
    if (headers.origin) headers.origin = BASE_URL;
    if (headers.referer) headers.referer = headers.referer.replace(PRODUCTION_ORIGIN, BASE_URL);
    const response = await route.fetch({
      url: request.url().replace(PRODUCTION_ORIGIN, BASE_URL),
      headers,
      maxRedirects: 0,
    });
    const location = response.headers().location;
    await route.fulfill({
      response,
      headers: location
        ? { ...response.headers(), location: location.replace(BASE_URL, PRODUCTION_ORIGIN) }
        : response.headers(),
    });
  });

  // The dev client hydrates only once its HMR socket connects, so that socket is bridged too.
  await context.routeWebSocket(`wss://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}/**`, (socket) => {
    const upstream = new WebSocket(socket.url().replace(`wss://${OFFICIAL_PRODUCTION_STOREFRONT_HOST}`, `ws://${HOST}:${PORT}`));
    upstream.binaryType = "arraybuffer";
    const queued: Array<string | Buffer> = [];
    upstream.addEventListener("open", () => {
      for (const message of queued.splice(0)) upstream.send(message);
    });
    upstream.addEventListener("message", (event) => {
      socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
    });
    upstream.addEventListener("close", () => void socket.close());
    socket.onMessage((message) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else queued.push(message);
    });
    socket.onClose(() => upstream.close());
  });
}

function pancakeFootprint(page: Page) {
  return page.evaluate(() => ({
    root: document.getElementById("pancake-chat-plugin-root") !== null,
    script: document.getElementById("pancake-chat-plugin") !== null,
    runtime: "PancakeChatPlugin" in window,
  }));
}

const NO_PANCAKE = { root: false, script: false, runtime: false };

test.beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.45" }),
    body: { name: "Pancake Chat Isolation Runtime", email: adminEmail, password },
  });
  sessionCookies = headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
  });
  expect(sessionCookies.length).toBeGreaterThan(0);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/pancake-chat-isolation",
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
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.$disconnect();
});

test("off the production host the storefront keeps the Messenger button and never requests Pancake", async ({
  page,
  context,
}) => {
  const pancakeRequests = await stubPancake(context);

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await expect(page.getByRole("link", { name: /qua Messenger$/ })).toBeVisible();
  await delay(1_500);

  expect(await pancakeFootprint(page)).toEqual(NO_PANCAKE);
  expect(pancakeRequests).toEqual([]);
});

test("on the production host Pancake loads, and a client-side return to admin lands in a document without it", async ({
  page,
  context,
}) => {
  const pancakeRequests = await stubPancake(context);
  await serveAsProduction(context);
  await context.addCookies(sessionCookies.map((cookie) => ({ ...cookie, url: PRODUCTION_ORIGIN })));

  // Admin, fresh document: no chat of any kind.
  await page.goto(`${PRODUCTION_ORIGIN}/admin`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Biên tập catalog" })).toBeVisible();
  await delay(1_500);
  expect(await pancakeFootprint(page)).toEqual(NO_PANCAKE);
  await expect(page.locator(".messenger-fab")).toHaveCount(0);
  expect(pancakeRequests).toEqual([]);

  // Client-side navigation to the storefront: Pancake loads there, in place of the Messenger button.
  await page.locator("a.brand-mark").click();
  await page.waitForURL(`${PRODUCTION_ORIGIN}/`);
  await page.waitForFunction(() => document.getElementById("pancake-chat-plugin-root") !== null);
  expect(await pancakeFootprint(page)).toEqual({ root: true, script: true, runtime: true });
  await expect(page.locator(".messenger-fab")).toHaveCount(0);
  expect(pancakeRequests).toHaveLength(1);

  // Back into admin through the client router. The document Pancake ran in must not survive it.
  await page.evaluate(() => {
    (window as unknown as { __documentBeforeAdmin?: boolean }).__documentBeforeAdmin = true;
  });
  await page.goBack();
  await page.waitForURL(`${PRODUCTION_ORIGIN}/admin`);
  // The marker lives on the old document's window: it is gone only if admin arrived by a reload.
  await page.waitForFunction(
    () => !(window as unknown as { __documentBeforeAdmin?: boolean }).__documentBeforeAdmin,
    undefined,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("heading", { level: 1, name: "Biên tập catalog" })).toBeVisible();
  await delay(1_500);

  expect(await pancakeFootprint(page)).toEqual(NO_PANCAKE);
  expect(pancakeRequests).toHaveLength(1);
});
