import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3324;
const BASE_URL = `http://${HOST}:${PORT}`;
const UNKNOWN_ROUTE = `${BASE_URL}/u30c-this-route-does-not-exist`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`U30c not-found server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/search`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U30c not-found server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) server.kill("SIGKILL");
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/not-found-recovery",
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_URL: BASE_URL,
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

/**
 * U30c / W14a. The HTTP smoke proves the unmatched route answers 404 with the branded markup.
 * What it cannot see is whether that markup is usable: the recovery links have to be reachable
 * and operable from the keyboard, and readable at both the phone and desktop widths the rest of
 * the storefront supports.
 */
test("U30c branded 404 renders and recovers without accessibility violations", async ({ page }) => {
  const response = await page.goto(UNKNOWN_ROUTE, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(404);

  const heading = page.getByRole("heading", { level: 1, name: "Không tìm thấy trang" });
  await expect(heading).toBeVisible();
  await expect(page.getByText("Trang bạn tìm không tồn tại.")).toBeVisible();

  const recovery = page.getByRole("navigation", { name: "Điều hướng thay thế" });
  for (const [name, href] of [
    ["Trang chủ", "/"],
    ["Cửa hàng", "/shop"],
    ["Bộ sưu tập", "/collections"],
    ["Tìm kiếm", "/search"],
  ] as const) {
    const link = recovery.getByRole("link", { name: new RegExp(`^${name}`) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
  }

  const results = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .include("main#main-content")
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("U30c branded 404 recovery links are reachable and operable from the keyboard", async ({ page }) => {
  await page.goto(UNKNOWN_ROUTE, { waitUntil: "networkidle" });

  const shopLink = page
    .getByRole("navigation", { name: "Điều hướng thay thế" })
    .getByRole("link", { name: /^Cửa hàng/ });

  // Tab from the top of the document until focus lands on the recovery link. A link that is only
  // clickable — reachable by pointer but skipped by the tab order — fails here rather than
  // passing on markup alone.
  await page.keyboard.press("Tab");
  for (let step = 0; step < 60; step += 1) {
    if (await shopLink.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(shopLink).toBeFocused();

  await page.keyboard.press("Enter");
  await page.waitForURL(`${BASE_URL}/shop`);
  expect(new URL(page.url()).pathname).toBe("/shop");
});

test("U30c branded 404 stays readable at phone and desktop widths", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(UNKNOWN_ROUTE, { waitUntil: "networkidle" });

    const heading = page.getByRole("heading", { level: 1, name: "Không tìm thấy trang" });
    await expect(heading).toBeVisible();

    // Nothing on the page may push the document wider than the viewport, which is what turns a
    // 404 into a horizontally scrolling dead end on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);

    for (const name of ["Trang chủ", "Cửa hàng", "Bộ sưu tập", "Tìm kiếm"]) {
      await expect(
        page.getByRole("navigation", { name: "Điều hướng thay thế" })
          .getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toBeVisible();
    }
  }
});
