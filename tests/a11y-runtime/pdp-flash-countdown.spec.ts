/**
 * PDP Flash Sale countdown and "Còn x" in a real browser: they speak only for the price and the
 * kind on screen, and a server refresh restarts the clock from the new snapshot rather than
 * subtracting the time already spent twice.
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
const setSlug = `pdp-flash-set-${runId}`;
const setFlashId = `pdp-flash-set-campaign-${runId}`;
const topPromotionId = `pdp-flash-top-promotion-${runId}`;
const campaignIds = [promotionId, flashId, setFlashId, topPromotionId];
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
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "campaignId" = ANY(${campaignIds})`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" = ANY(${campaignIds})`;
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/**
 * A FULL SET on Flash Sale whose top is also sold alone ("ÁO LẺ") through an ordinary promotion.
 * Each size is assembled from its own pieces, so the set's sizes add up: one set of each is left.
 */
async function seedCompositeSet(now: Date) {
  const product = (externalId: string, productSlug: string, name: string, isActive: boolean) =>
    prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP_ID,
        pancakeProductId: externalId,
        slug: productSlug,
        name,
        isPresent: true,
        isActive,
        syncedAt: now,
      },
    });
  const set = await product(`pdp-flash-set-${runId}`, setSlug, `PDP Flash Full Set ${runId}`, true);
  const top = await product(`pdp-flash-top-${runId}`, `pdp-flash-top-${runId}`, `PDP Top ${runId}`, false);
  const pants = await product(`pdp-flash-pants-${runId}`, `pdp-flash-pants-${runId}`, `PDP Pants ${runId}`, false);

  const variant = (productId: string, size: string, price: number, sku: string | null, stock: number) =>
    prisma.variantMirror
      .create({
        data: {
          pancakeVariationId: `pdp-flash-${sku ?? "set"}-${size}-${runId}`,
          productId,
          sku,
          color: null,
          size,
          pancakeRetailPrice: price,
          pancakeRetailPriceAfterDiscount: price,
          isPresent: true,
          isActive: true,
          syncedAt: now,
        },
      })
      .then(async (row) => {
        await prisma.warehouseStock.create({
          data: { variantId: row.id, pancakeWarehouseId: `pdp-flash-wh-${row.id}`, quantity: stock, syncedAt: now },
        });
        return row;
      });

  for (const size of ["S", "M"]) {
    const setVariant = await variant(set.id, size, 300_000, null, 0);
    const topVariant = await variant(top.id, size, 200_000, `AO-${size}`, 1);
    const pantsVariant = await variant(pants.id, size, 150_000, `QUAN-${size}`, 5);
    await prisma.compositeComponentMirror.createMany({
      data: [topVariant, pantsVariant].map((component) => ({
        parentVariantId: setVariant.id,
        componentVariantId: component.id,
        quantity: 1,
        syncedAt: now,
      })),
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PromotionTarget" ("id","campaignId","variantId","createdAt") VALUES ($1,$2,$3,$4)`,
      `${topPromotionId}-${size}`,
      topPromotionId,
      topVariant.id,
      now,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","productId","createdAt") VALUES ($1,$2,$3,$4)`,
    `${setFlashId}-target`,
    setFlashId,
    set.id,
    now,
  );
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
    .getByRole("group", { name: /^Kích cỡ/ })
    .getByText(size, { exact: true })
    .click();
}

async function chooseKind(page: Page, kind: string) {
  await page
    .getByRole("region", { name: "Mua sản phẩm" })
    .getByRole("group", { name: "Loại", exact: true })
    .getByText(kind, { exact: true })
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
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","fixedPriceVnd","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'FIXED_PRICE'::"PromotionDiscountType",30000,true,$3,$3,$3)`,
    topPromotionId,
    `PDP top promotion ${runId}`,
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","fixedPriceVnd","startsAt","endsAt",
        "isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'FLASH_SALE'::"PromotionCampaignKind",$2,'FIXED_PRICE'::"PromotionDiscountType",49000,$3,$4,true,$5,$5,$5)`,
    setFlashId,
    `PDP set flash ${runId}`,
    new Date(now.getTime() - HOUR),
    new Date(now.getTime() + 2 * HOUR),
    now,
  );
  await seedCompositeSet(now);
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

test("a composite's other kinds never carry the set's countdown or stock", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${setSlug}`, { waitUntil: "networkidle" });
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const strip = page.locator("[data-pdp-flash]");
  const lowStock = panel.locator("[data-pdp-low-stock]");
  // The phone bar is hidden while the panel's buttons are in view, but it is rendered: read its text.
  const barCountdown = page.locator("[data-mobile-purchase-bar]").getByText(/Còn \d\d:\d\d:\d\d/);

  // No kind yet: the panel quotes the set's Flash price, one set of each size left.
  await expect(panel.getByText(/49\.000/)).toBeVisible();
  await expect(strip).toBeVisible();
  await expect(barCountdown).toHaveCount(1);
  await expect(lowStock).toHaveText("Chỉ còn 2 sản phẩm");

  // "ÁO LẺ", no size: its own 30.000 ₫ promotion is quoted, and none of the set's facts remain.
  await chooseKind(page, "ÁO LẺ");
  await expect(panel.getByText(/30\.000/)).toBeVisible();
  await expect(strip).toHaveCount(0);
  await expect(barCountdown).toHaveCount(0);
  await expect(panel.getByText("Giá Flash Sale", { exact: false })).toHaveCount(0);
  await expect(lowStock).toHaveCount(0);

  // A size of "ÁO LẺ" is a child variant: still not the set's.
  await chooseSize(page, "S");
  await expect(strip).toHaveCount(0);
  await expect(barCountdown).toHaveCount(0);
  await expect(lowStock).toHaveCount(0);

  // Back to FULL SET, then a size: the set's countdown and that size's own count return.
  await chooseKind(page, "FULL SET");
  await expect(strip).toBeVisible();
  await chooseSize(page, "M");
  await expect(strip).toBeVisible();
  await expect(panel.getByText(/49\.000/)).toBeVisible();
  await expect(lowStock).toHaveText("Size M chỉ còn 1 sản phẩm");
});
