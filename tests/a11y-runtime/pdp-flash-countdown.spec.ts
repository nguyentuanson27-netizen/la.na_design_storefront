/**
 * PDP Flash Sale countdown in a real browser: it counts down the price on screen and nothing else,
 * and a server refresh restarts its clock from the new snapshot rather than subtracting the time
 * already spent twice.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3344;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_051;
const runId = `${Date.now()}-${process.pid}`;
const productExternalId = `pdp-flash-product-${runId}`;
const slug = `pdp-flash-${runId}`;
const promotionId = `pdp-flash-promotion-${runId}`;
const flashId = `pdp-flash-campaign-${runId}`;
const HOUR = 60 * 60_000;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js PDP server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${slug}`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for PDP server\n${serverOutput}`);
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
  if (!exited) server.kill("SIGKILL");
  server = undefined;
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "campaignId" IN (${promotionId}, ${flashId})`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" IN (${promotionId}, ${flashId})`;
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: productExternalId } });
}

function isPdpRscRequest(request: Request) {
  const url = new URL(request.url());
  return url.pathname === `/shop/${slug}` && (url.searchParams.has("_rsc") || request.headers()["rsc"] === "1");
}

/** Seconds left on the panel's countdown, read from its digits. */
async function countdownSeconds(page: Page): Promise<number> {
  const digits = await page.locator("[data-pdp-flash] .pdp-flash-strip__digits b").allInnerTexts();
  const [hours, minutes, seconds] = digits.slice(-3).map(Number);
  return hours! * 3600 + minutes! * 60 + seconds!;
}

async function chooseSize(page: Page, size: string) {
  await page
    .getByRole("region", { name: "Mua sản phẩm" })
    .locator("label")
    .filter({ hasText: new RegExp(`^${size}$`) })
    .click();
}

test.beforeAll(async () => {
  await cleanup();
  const now = new Date();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug,
      name: `PDP Flash Set ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  const variant = (size: string) =>
    prisma.variantMirror.create({
      data: {
        pancakeVariationId: `pdp-flash-${size}-${runId}`,
        productId: product.id,
        color: null,
        size,
        pancakeRetailPrice: 300_000,
        pancakeRetailPriceAfterDiscount: 300_000,
        isPresent: true,
        isActive: true,
        syncedAt: now,
      },
    });
  const small = await variant("S");
  const medium = await variant("M");
  await prisma.warehouseStock.createMany({
    data: [small, medium].map((row) => ({
      variantId: row.id,
      pancakeWarehouseId: `pdp-flash-wh-${row.size}-${runId}`,
      quantity: 5,
      syncedAt: now,
    })),
  });

  // S is cheaper through an ordinary promotion; only M is on Flash Sale, ending in two hours.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","fixedPriceVnd","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'FIXED_PRICE'::"PromotionDiscountType",30000,true,$3,$3,$3)`,
    promotionId,
    `PDP promotion ${runId}`,
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","fixedPriceVnd","startsAt","endsAt",
        "isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'FLASH_SALE'::"PromotionCampaignKind",$2,'FIXED_PRICE'::"PromotionDiscountType",50000,$3,$4,true,$5,$5,$5)`,
    flashId,
    `PDP flash ${runId}`,
    new Date(now.getTime() - HOUR),
    new Date(now.getTime() + 2 * HOUR),
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","variantId","createdAt")
     VALUES ($1,$2,$3,$5), ($6,$4,$7,$5)`,
    `${promotionId}-target`,
    promotionId,
    small.id,
    flashId,
    now,
    `${flashId}-target`,
    medium.id,
  );

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/pdp-flash-countdown",
      PANCAKE_SHOP_ID: String(SHOP_ID),
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
  await cleanup();
  await prisma.$disconnect();
});

test("the countdown speaks only for a Flash price on screen", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${slug}`, { waitUntil: "networkidle" });
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const strip = page.locator("[data-pdp-flash]");

  // Before a choice the panel quotes S's 30.000 ₫ ordinary promotion: no Flash countdown, no Flash copy.
  await expect(panel.getByText(/30\.000/)).toBeVisible();
  await expect(strip).toHaveCount(0);
  await expect(panel.getByText("Giá Flash Sale", { exact: false })).toHaveCount(0);

  await chooseSize(page, "M");
  await expect(strip).toBeVisible();
  await expect(panel.getByText(/50\.000/)).toBeVisible();
  await expect(panel.getByText("Giá Flash Sale", { exact: false })).toHaveCount(1);

  await chooseSize(page, "S");
  await expect(strip).toHaveCount(0);
  await expect(panel.getByText("Giá Flash Sale", { exact: false })).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("a server refresh restarts the countdown from the new snapshot", async ({ page }) => {
  await page.clock.install();
  let refreshes = 0;
  page.on("response", (response) => {
    if (isPdpRscRequest(response.request())) refreshes += 1;
  });

  await page.goto(`${BASE_URL}/shop/${slug}`, { waitUntil: "networkidle" });
  await chooseSize(page, "M");
  await expect(page.locator("[data-pdp-flash]")).toBeVisible();
  const atLoad = await countdownSeconds(page);

  // The browser's clock moves a minute; the refresher's fallback timer fires `router.refresh()`.
  const beforeTimer = refreshes;
  await page.clock.fastForward(60_000);
  await expect.poll(() => refreshes, { timeout: 10_000, message: "timer refresh" }).toBeGreaterThan(beforeTimer);
  await page.clock.runFor(1_000);

  // The server's clock barely moved, so its new snapshot still has about `atLoad` left. Counting
  // from the mount would show a minute less: the minute the fake clock spent, subtracted again.
  await expect
    .poll(async () => atLoad - (await countdownSeconds(page)), { timeout: 10_000, message: "after timer refresh" })
    .toBeLessThan(30);

  // Coming back to the tab refreshes too, and the same rule holds.
  await page.clock.fastForward(45_000);
  const beforeVisible = refreshes;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => refreshes, { timeout: 10_000, message: "visibility refresh" }).toBeGreaterThan(beforeVisible);
  await page.clock.runFor(1_000);
  await expect
    .poll(async () => atLoad - (await countdownSeconds(page)), { timeout: 10_000, message: "after visibility refresh" })
    .toBeLessThan(30);

  // Still M: the selection survived the refresh, and so did the countdown it follows.
  await expect(page.getByRole("region", { name: "Mua sản phẩm" }).getByText(/50\.000/)).toBeVisible();
});
