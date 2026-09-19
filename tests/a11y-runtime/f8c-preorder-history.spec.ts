import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3235;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TRUSTED_CLIENT_IP = "203.0.113.87";
const runId = `${Date.now()}${process.pid}`;
const publicCode = `LA-f8c-${runId}`;
const legacyCode = `LA-f8c-legacy-${runId}`;
const guestPhone = "0907777788";
const confirmedAt = new Date("2026-09-18T04:30:00.000Z");
const readyAt = new Date("2026-10-03T04:30:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";
let productId = "";
let preorderVariantId = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js F8c server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/track-order`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status === 200 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for F8c server\n${serverOutput}`);
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
    await once(server, "exit");
  }
  server = undefined;
}

async function assertPageQuality(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

async function submitTracking(page: Page, code: string, phone: string) {
  await page.getByLabel("Mã đơn hàng").fill(code);
  await page.getByLabel("Số điện thoại").fill(phone);
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
}

test.beforeAll(async () => {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: 920_208,
      pancakeProductId: `f8c-product-${runId}`,
      slug: `f8c-product-${runId}`,
      name: "F8c historical product",
      isPresent: true,
      isActive: true,
      syncedAt: confirmedAt,
      sellingPolicy: {
        create: { sellingMode: "PREORDER", negativeStockLimit: -20 },
      },
      variants: {
        create: {
          pancakeVariationId: `f8c-preorder-${runId}`,
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: 500_000,
          pancakeRetailPriceAfterDiscount: 500_000,
          syncedAt: confirmedAt,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `f8c-warehouse-${runId}`,
              quantity: 0,
              syncedAt: confirmedAt,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  productId = product.id;
  preorderVariantId = product.variants[0]!.id;

  await prisma.orderMirror.create({
    data: {
      publicCode,
      state: "CONFIRMED",
      guestName: "F8c Browser Fixture",
      guestPhone,
      provinceRef: "101",
      districtRef: "10113",
      communeRef: "1011309",
      addressDetail: "F8c fixture",
      checkoutSnapshottedAt: confirmedAt,
      merchandiseSubtotalVnd: BigInt(700_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(730_000),
      lines: {
        create: [
          {
            variantId: preorderVariantId,
            pancakeVariationId: `f8c-preorder-${runId}`,
            productName: "F8c Preorder",
            size: "M",
            quantity: 1,
            unitPriceVnd: BigInt(500_000),
            lineTotalVnd: BigInt(500_000),
          },
          {
            variantId: `historical-ready-${runId}`,
            pancakeVariationId: `historical-ready-${runId}`,
            productName: "F8c Ready",
            size: "S",
            quantity: 1,
            unitPriceVnd: BigInt(200_000),
            lineTotalVnd: BigInt(200_000),
          },
        ],
      },
      preorderSnapshot: {
        create: {
          confirmedAt,
          preorderReadyAt: readyAt,
          shippingScope: "HANOI",
          shippingEstimateMinDays: 1,
          shippingEstimateMaxDays: 3,
          lines: {
            create: [
              {
                variantId: preorderVariantId,
                quantity: 1,
                state: "PREORDER",
                preorderReadyAt: readyAt,
              },
              {
                variantId: `historical-ready-${runId}`,
                quantity: 1,
                state: "READY",
                preorderReadyAt: null,
              },
            ],
          },
        },
      },
    },
  });

  await prisma.orderMirror.create({
    data: {
      publicCode: legacyCode,
      state: "CONFIRMED",
      guestName: "F8c Legacy Fixture",
      guestPhone,
      provinceRef: "101",
      districtRef: "10113",
      communeRef: "1011309",
      addressDetail: "F8c legacy fixture",
      checkoutSnapshottedAt: confirmedAt,
      merchandiseSubtotalVnd: BigInt(200_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(230_000),
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/f8c-history",
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
  await prisma.$disconnect();
});

test("F8c confirmation and tracking keep identical immutable preorder history after live mutations", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": TRUSTED_CLIENT_IP });
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(publicCode)}`, {
    waitUntil: "networkidle",
  });
  const confirmation = page.locator('[data-historical-preorder="true"]');
  await expect(confirmation).toContainText("Đặt trước");
  await expect(confirmation).toContainText("03/10/2026");
  await expect(confirmation).toContainText("1–3 ngày");
  await expect(confirmation).toContainText("giao cùng nhau");
  const before = await confirmation.innerText();
  await assertPageQuality(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await submitTracking(page, publicCode, guestPhone);
  const tracking = page.locator('[data-historical-preorder="true"]');
  await expect(tracking).toBeVisible();
  expect(await tracking.innerText()).toBe(before);
  await assertPageQuality(page);

  // Mutate every live authority that F8c must ignore after confirmation.
  await prisma.productSellingPolicy.update({
    where: { productId },
    data: { sellingMode: "OVERSELL", negativeStockLimit: -7 },
  });
  await prisma.warehouseStock.updateMany({
    where: { variantId: preorderVariantId },
    data: { quantity: 25 },
  });
  await prisma.variantAvailabilityCycle.upsert({
    where: { variantId: preorderVariantId },
    create: {
      variantId: preorderVariantId,
      cycleStartDate: new Date("2026-09-20T00:00:00.000Z"),
      availabilityDate: new Date("2026-11-20T00:00:00.000Z"),
      lastStockNonPositive: false,
      lastPreorder: false,
    },
    update: {
      availabilityDate: new Date("2026-11-20T00:00:00.000Z"),
      lastStockNonPositive: false,
      lastPreorder: false,
    },
  });
  await prisma.productMirror.update({
    where: { id: productId },
    data: { isPresent: false, isActive: false },
  });
  await prisma.variantMirror.update({
    where: { id: preorderVariantId },
    data: { isPresent: false, isActive: false },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(publicCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveText(before);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await submitTracking(page, publicCode, guestPhone);
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveText(before);
  await assertPageQuality(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("F8c legacy confirmed orders without I7 history keep generic confirmation and tracking", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": "203.0.113.88" });

  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(legacyCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("Cảm ơn bạn đã đặt hàng.")).toBeVisible();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveCount(0);

  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await submitTracking(page, legacyCode, guestPhone);
  await expect(page.getByRole("status").filter({ hasText: "Đã tiếp nhận" })).toBeVisible();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveCount(0);
  await assertPageQuality(page);
});
