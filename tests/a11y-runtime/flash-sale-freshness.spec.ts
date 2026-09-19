/** U17 / P7b — real-browser Sale representative UI, refresh loop, resume hooks and Axe. */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3227;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_027;
const runId = `${Date.now()}-${process.pid}`;
const productExternalId = `u17-browser-product-${runId}`;
const regularVariationId = `u17-browser-regular-${runId}`;
const flashVariationId = `u17-browser-flash-${runId}`;
const campaignId = `u17-browser-campaign-${runId}`;
const targetId = `u17-browser-target-${runId}`;
const productName = `U17 Browser Flash Shirt ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js Sale server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sale`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes("Sale")) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Sale server\n${serverOutput}`);
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
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "id" = ${targetId}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" = ${campaignId}`;
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: productExternalId } });
}

test.beforeAll(async () => {
  await cleanup();
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60 * 60_000);
  const endsAt = new Date(now.getTime() + 2 * 60 * 60_000);

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug: `u17-browser-flash-${runId}`,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  const regular = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: regularVariationId,
      productId: product.id,
      color: "Đen",
      size: "S",
      pancakeRetailPrice: 300_000,
      pancakeRetailPriceAfterDiscount: 300_000,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  const flash = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: flashVariationId,
      productId: product.id,
      color: "Đen",
      size: "M",
      pancakeRetailPrice: 500_000,
      pancakeRetailPriceAfterDiscount: 500_000,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  await prisma.warehouseStock.createMany({
    data: [
      {
        variantId: regular.id,
        pancakeWarehouseId: `u17-browser-wh-regular-${runId}`,
        quantity: 5,
        syncedAt: now,
      },
      {
        variantId: flash.id,
        pancakeWarehouseId: `u17-browser-wh-flash-${runId}`,
        quantity: 5,
        syncedAt: now,
      },
    ],
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","percentageValue","startsAt","endsAt",
        "isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'FLASH_SALE'::"PromotionCampaignKind",$2,
       'PERCENTAGE'::"PromotionDiscountType",20,$3,$4,true,$5,$5,$5)`,
    campaignId,
    `U17 browser freshness ${runId}`,
    startsAt,
    endsAt,
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","variantId","createdAt")
     VALUES ($1,$2,$3,$4)`,
    targetId,
    campaignId,
    flash.id,
    now,
  );

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/flash-sale-freshness",
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

test("U17 renders the Sale representative and self-rearms/resumes without browser time authority", async ({ page }) => {
  await page.clock.install();

  let refreshRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/sale" && (url.searchParams.has("_rsc") || request.headers()["rsc"] === "1")) {
      refreshRequests += 1;
    }
  });

  await page.goto(`${BASE_URL}/sale`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Sale" })).toBeVisible();
  await expect(page.getByRole("link", { name: `Xem ${productName}` })).toBeVisible();
  await expect(page.getByText("FLASH SALE", { exact: true })).toBeVisible();
  await expect(page.getByText(/500\.000/)).toBeVisible();
  await expect(page.getByText(/Sale từ .*400\.000/)).toBeVisible();
  await expect(page.getByText(/Còn .*giờ/)).toBeVisible();
  await expect(page.getByText(/300\.000/)).toHaveCount(0);

  await delay(500);

  const beforeFirstTimer = refreshRequests;
  await page.clock.fastForward(60_000);
  await expect
    .poll(() => refreshRequests, { timeout: 3_000, message: "first timer refresh" })
    .toBeGreaterThan(beforeFirstTimer);

  const beforeSecondTimer = refreshRequests;
  await page.clock.fastForward(60_000);
  await expect
    .poll(() => refreshRequests, { timeout: 3_000, message: "second self-rearmed timer refresh" })
    .toBeGreaterThan(beforeSecondTimer);

  const beforeVisible = refreshRequests;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(() => refreshRequests, { timeout: 3_000, message: "visibility resume refresh" })
    .toBeGreaterThan(beforeVisible);

  const beforePageShow = refreshRequests;
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expect
    .poll(() => refreshRequests, { timeout: 3_000, message: "BFCache resume refresh" })
    .toBeGreaterThan(beforePageShow);

  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});
