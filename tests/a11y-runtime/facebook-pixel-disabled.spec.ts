import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

/**
 * The default configuration: no pixel id anywhere.
 *
 * Callers fire tracking events unconditionally — the product panel on mount, the checkout and
 * confirmation pages on render — so "no pixel configured" has to be a genuine no-op rather than a
 * queue nothing will ever drain. This spec exists because that is the shape every deployment
 * without tracking runs in, including this repository's own CI.
 */

declare global {
  interface Window {
    fbq?: unknown;
    /** Installed by this spec only, to observe timers the page schedules. */
    __timers?: { created: Array<{ id: number; delay: number }>; cleared: number[] };
  }
}

const HOST = "127.0.0.1";
const PORT = 3223;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_023;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-29T04:00:00.000Z");
const productSlug = `no-pixel-shirt-${runId}`;

/** Matches the client's poll cadence; nothing else in the app schedules one. */
const PIXEL_POLL_INTERVAL_MS = 250;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js no-pixel server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for no-pixel server\n${serverOutput}`);
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

async function cleanup() {
  await prisma.cartItem.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP_ID } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/** Records timers so a test can prove the page left none of ours running. */
async function recordTimers(page: Page) {
  await page.addInitScript(() => {
    const created: Array<{ id: number; delay: number }> = [];
    const cleared: number[] = [];
    window.__timers = { created, cleared };

    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, timeout, ...args) as unknown as number;
      created.push({ id, delay: timeout ?? 0 });
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) cleared.push(id);
      return nativeClearInterval(id);
    }) as typeof window.clearInterval;
  });
}

function readLivePixelPolls(page: Page): Promise<number[]> {
  return page.evaluate((pollDelay) => {
    const timers = window.__timers ?? { created: [], cleared: [] };
    return timers.created
      .filter((timer) => timer.delay === pollDelay && !timers.cleared.includes(timer.id))
      .map((timer) => timer.id);
  }, PIXEL_POLL_INTERVAL_MS);
}

test.beforeAll(async () => {
  await cleanup();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `no-pixel-product-${runId}`,
      slug: productSlug,
      name: `No Pixel Shirt ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", collectionSlugs: [] } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `no-pixel-variant-${runId}`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 449_000,
      pancakeRetailPriceAfterDiscount: 449_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `no-pixel-warehouse-${runId}`,
      quantity: 5,
      syncedAt,
    },
  });

  // Deliberately no NEXT_PUBLIC_FACEBOOK_PIXEL_ID: this is the untracked default.
  // Next 16 dev permits one server per build directory and guards it with a lock file
  // there. Every spec drives this one project, so they share that lock unless each gets
  // its own directory -- and a server that has to be SIGKILLed leaves the lock behind,
  // which makes the next spec's server refuse to start entirely.
  const environment = { ...process.env, NEXT_DIST_DIR: ".next-test/facebook-pixel-disabled" };
  delete environment.NEXT_PUBLIC_FACEBOOK_PIXEL_ID;
  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...environment,
      PANCAKE_SHOP_ID: String(SHOP_ID),
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
  await cleanup();
  await prisma.$disconnect();
});

test("an untracked build ships no pixel script and no Facebook origin in its policy", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });

  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).not.toContain("facebook");
  expect(await page.content()).not.toContain("connect.facebook.net");
  expect(await page.evaluate(() => typeof window.fbq)).toBe("undefined");
});

test("a page that reports events leaves no queue or timer behind when there is no pixel", async ({
  page,
}) => {
  await recordTimers(page);

  // The product page reports ViewContent the moment the purchase panel mounts, and AddToCart once
  // the server confirms a line. Both run on this document, so the recorder sees the timers they
  // would schedule; navigating away first would reset it and prove nothing.
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await delay(2_000);
  expect(await readLivePixelPolls(page)).toEqual([]);

  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();
  await delay(2_000);

  // Nothing consumes a queued event here, so nothing may be held waiting for one.
  expect(await readLivePixelPolls(page)).toEqual([]);
});
