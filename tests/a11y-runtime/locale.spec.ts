/**
 * The English storefront under `/en` as a shopper's browser sees it.
 *
 * What a unit test cannot prove: that the proxy rewrite reaches the real route tree, that the page
 * says which language it is in, that the language switch keeps the shopper's filters, that an
 * in-site link stays in the language, and that analytics reports the two languages' URLs apart --
 * `page_path` is `/shop` on one and `/en/shop` on the other, once each.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

const HOST = "127.0.0.1";
const PORT = 3322;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_033;
const runId = `${Date.now()}-${process.pid}`;
const product = {
  externalId: `locale-dress-${runId}`,
  slug: `locale-dress-${runId}`,
  name: `Đầm thử ngôn ngữ ${runId}`,
  englishName: `Language test dress ${runId}`,
  variation: `locale-dress-m-${runId}`,
};
const syncedAt = new Date("2026-11-09T00:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Locale server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${product.slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(product.name)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the locale server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
  server = undefined;
}

async function cleanup() {
  // ProductTranslation rows go with their product (ON DELETE CASCADE).
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function pageViews(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const layer = (window as { dataLayer?: unknown[] }).dataLayer ?? [];
    return layer
      .filter((entry): entry is { event: string; page_path: string } =>
        typeof entry === "object" && entry !== null && (entry as { event?: unknown }).event === "page_view")
      .map((entry) => entry.page_path);
  });
}

test.beforeAll(async () => {
  await cleanup();
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: product.externalId,
      slug: product.slug,
      name: product.name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { editorialDescription: "Locale regression product." } },
      translations: { create: { locale: "en", name: product.englishName } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: product.variation,
      productId: created.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 500_000,
      pancakeRetailPriceAfterDiscount: 500_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${product.variation}-wh`, quantity: 5, syncedAt },
  });

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/locale"),
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
      // Publishes the dataLayer without loading any container.
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-TESTONLY",
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

test("each language says which it is, and the English pages are the real routes", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");

  for (const path of ["/en", "/en/shop", `/en/shop/${product.slug}`]) {
    const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("html"), path).toHaveAttribute("lang", "en");
  }

  // The translated name is shown in English, the Vietnamese one stays on the Vietnamese URL.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(product.englishName);
  await page.goto(`${BASE_URL}/shop/${product.slug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(product.name);

  const missing = await page.goto(`${BASE_URL}/en/shop/does-not-exist-${runId}`);
  expect(missing?.status()).toBe(404);

  // A browser does not choose the language by header: the Vietnamese URL stays Vietnamese.
  const forged = await fetch(`${BASE_URL}/shop`, {
    headers: { "x-la-locale": "en", "x-la-locale-carry": "guess" },
  });
  expect(await forged.text()).toContain('lang="vi"');
});

test("page_view reports the URL that was seen: /shop and /en/shop apart, once each", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  expect(await pageViews(page)).toEqual(["/shop"]);

  await page.goto(`${BASE_URL}/en/shop`, { waitUntil: "networkidle" });
  expect(await pageViews(page)).toEqual(["/en/shop"]);

  // A re-render that changes nothing about the URL must not report it again.
  await page.getByRole("button", { name: /search/i }).first().click();
  await page.keyboard.press("Escape");
  await delay(500);
  expect(await pageViews(page)).toEqual(["/en/shop"]);
});

test("English pages show dollars at the fixed rate; Vietnamese pages and structured data stay in dong", async ({ page }) => {
  // 500.000 dong at 26,000 dong to the dollar.
  await page.goto(`${BASE_URL}/shop/${product.slug}`, { waitUntil: "networkidle" });
  const vietnamese = page.locator("#main-content");
  await expect(vietnamese).toContainText("500.000");
  await expect(vietnamese).not.toContainText("$");

  for (const path of [`/en/shop/${product.slug}`, "/en/shop"]) {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
    const main = page.locator("#main-content");
    await expect(main, path).toContainText("$19.23");
    await expect(main, path).not.toContainText("₫");
  }

  // The offer that search engines read is the real price, in the real currency, on both languages.
  await page.goto(`${BASE_URL}/en/shop/${product.slug}`, { waitUntil: "networkidle" });
  const structured = (await page.locator('script[type="application/ld+json"]').allTextContents()).join("\n");
  expect(structured).toContain('"priceCurrency":"VND"');
  expect(structured).not.toContain("USD");
});

test("the language switch keeps the filters, and in-site links stay in the language", async ({ page }) => {
  await page.goto(`${BASE_URL}/en/shop?sort=price-asc`, { waitUntil: "networkidle" });
  const toVietnamese = page.locator(".language-switcher--footer a");
  await expect(toVietnamese).toHaveAttribute("href", "/shop?sort=price-asc");

  await page.goto(`${BASE_URL}/shop?sort=price-asc`, { waitUntil: "networkidle" });
  await expect(page.locator(".language-switcher--footer a")).toHaveAttribute("href", "/en/shop?sort=price-asc");

  // Opening a product from the English listing stays under /en.
  await page.goto(`${BASE_URL}/en/shop`, { waitUntil: "networkidle" });
  await page.locator(`a[href$="/shop/${product.slug}"]`).first().click();
  await expect(page).toHaveURL(`${BASE_URL}/en/shop/${product.slug}`);
});
