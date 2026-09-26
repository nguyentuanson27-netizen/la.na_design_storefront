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

/**
 * Mirrors the DOM the real Pancake script builds (read off a live run): a root pinned at the maximum
 * z-index holding a 60px bubble, and a full-screen chat box whose header carries the close button.
 * Clicking the bubble opens the box (`.pkcp-popup-open`); clicking the close button closes it.
 */
const PANCAKE_STUB = `
  window.__pancakeStubRuns = (window.__pancakeStubRuns || 0) + 1;
  window.PancakeChatPlugin = {};
  var style = document.createElement("style");
  style.textContent =
    ".pkcp-button-circle,.pkcp-button-icon{width:60px;height:60px;display:block;border-radius:50%;background:#334ca1}" +
    ".pkcp-button-icon svg{width:36px;height:36px}" +
    ".pkcp-popup{display:none}" +
    ".pkcp-popup.pkcp-popup-open{display:block;position:fixed;inset:0;z-index:2147483645;background:#fff}" +
    ".set-up-header-x-icon{position:absolute;top:24px;right:24px;width:40px;height:40px}";
  document.head.appendChild(style);
  var root = document.createElement("div");
  root.id = "pancake-chat-plugin-root";
  root.className = "pkcp-parent-container";
  root.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647";
  root.innerHTML =
    '<div><div id="pkcp" class="pkcp">' +
    '<div class="pkcp-popup"><div class="pkcp-popup-setup-header">' +
    '<div class="button-plugin set-up-header-x-icon" role="button" aria-label="Đóng"></div></div></div>' +
    '<div class="pkcp-button-wrapper"><div id="pkcp-button" class="pkcp-button-circle">' +
    '<div class="pkcp-button-icon"><svg viewBox="0 0 24 24"></svg></div></div></div>' +
    "</div></div>";
  document.body.appendChild(root);
  var popup = root.querySelector(".pkcp-popup");
  var wrapper = root.querySelector(".pkcp-button-wrapper");
  root.querySelector("#pkcp-button").addEventListener("click", function () {
    popup.classList.add("pkcp-popup-open");
    wrapper.style.display = "none";
  });
  root.querySelector(".set-up-header-x-icon").addEventListener("click", function () {
    popup.classList.remove("pkcp-popup-open");
    wrapper.style.display = "";
  });
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

test("the Pancake bubble is 48px, and the open chat's close button sits above the sticky masthead", async ({
  page,
  context,
}) => {
  await stubPancake(context);
  await serveAsProduction(context);

  await page.goto(`${PRODUCTION_ORIGIN}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.getElementById("pancake-chat-plugin-root") !== null);

  // Closed: the bubble is the storefront's 48px, not Pancake's 60px.
  const bubble = page.locator("#pkcp-button");
  const bubbleBox = (await bubble.boundingBox())!;
  expect([Math.round(bubbleBox.width), Math.round(bubbleBox.height)]).toEqual([48, 48]);

  // Open, scrolled so the masthead is stuck over the top of the full-screen chat box: the close
  // button in the box's header must be the element a tap at its centre lands on, and close the chat.
  await page.mouse.wheel(0, 800);
  await bubble.click();
  await expect(page.locator(".pkcp-popup-open")).toHaveCount(1);
  const close = page.locator(".set-up-header-x-icon");
  const closeBox = (await close.boundingBox())!;
  const centre = { x: closeBox.x + closeBox.width / 2, y: closeBox.y + closeBox.height / 2 };
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".set-up-header-x-icon") !== null,
    centre,
  );
  expect(hit, "a tap on the close button reaches it, not the masthead above it").toBe(true);

  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator(".pkcp-popup-open")).toHaveCount(0);
  await expect(bubble).toBeVisible();
});
