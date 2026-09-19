/** U15 / P6 — promotional PDP pricing and accessibility in a real browser. */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3226;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_026;
const runId = `${Date.now()}-${process.pid}`;
const slug = `u15-browser-promotion-${runId}`;
const productExternalId = `u15b-product-${runId}`;
const variationExternalId = `u15b-variant-${runId}`;
const campaignId = `u15b-campaign-${runId}`;
const targetId = `u15b-target-${runId}`;
const productName = `U15 Browser Promotion Shirt ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js promotion PDP server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(productName)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for promotion PDP server\n${serverOutput}`);
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
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      content: { create: { editorialDescription: "Promotion PDP browser regression." } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: variationExternalId,
      productId: product.id,
      color: null,
      size: "M",
      pancakeRetailPrice: 500_000,
      // Deliberately different: the old equality gate would make this option unpriceable.
      pancakeRetailPriceAfterDiscount: 420_000,
      isPresent: true,
      isActive: true,
      syncedAt: now,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `u15b-wh-${runId}`,
      quantity: 5,
      syncedAt: now,
    },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","percentageValue","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'PERCENTAGE'::"PromotionDiscountType",10,true,$3,$3,$3)`,
    campaignId,
    `U15 browser campaign ${runId}`,
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","productId","createdAt") VALUES ($1,$2,$3,$4)`,
    targetId,
    campaignId,
    product.id,
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
      NEXT_DIST_DIR: ".next-test/pdp-promotion",
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

test("U15 promoted deep link renders the central quote with accessible base/sale labels", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(`${BASE_URL}/shop/${slug}?variant=${variationExternalId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchasePanel.getByText(/500\.000/)).toBeVisible();
  await expect(purchasePanel.getByText(/450\.000/)).toBeVisible();
  await expect(purchasePanel.getByText("Giá gốc", { exact: false })).toBeAttached();
  await expect(purchasePanel.getByText("Giá khuyến mãi", { exact: false })).toBeAttached();
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();

  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});
