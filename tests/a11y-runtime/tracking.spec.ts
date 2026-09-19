import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3215;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TRUSTED_CLIENT_IP = "203.0.113.55";
const runId = `${Date.now()}-${process.pid}`;
const publicCode = `LA-tracking-${runId}`;
const preorderOnlyCode = `LA-tracking-preorder-${runId}`;
const readyOnlyCode = `LA-tracking-ready-${runId}`;
const legacyCode = `LA-tracking-legacy-${runId}`;
const guestPhone = "0901234567";
const confirmedAt = new Date("2026-09-18T04:30:00.000Z");
const preorderReadyAt = new Date("2026-10-03T04:30:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";
let historicalProductId = "";
let historicalVariantId = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js tracking server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/track-order`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which requests Better Auth's catch-all route
      // as soon as it hydrates. A page-only readiness probe can win the race against a freshly
      // started `next dev` and let Playwright navigate while that route still answers a transient
      // 404, which the browser's clean-console guard then correctly records. Declare the fixture
      // ready only once the page and the route it immediately depends on are both live; the
      // assertion itself stays strict.
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for tracking server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    once(server, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  if (!(await waitForServerExit(5_000))) {
    server.kill("SIGKILL");
    await waitForServerExit(5_000);
  }
  server = undefined;
}

async function cleanup() {
  // I6b — reservations reference their order and variant with `onDelete: Restrict` (ADR 0014 §13),
  // deliberately: cascading them away would silently free capacity that is still counting. Now that
  // a real checkout takes a hold, a fixture that deletes orders or products has to clear the ledger
  // first, or the delete is refused.
  await prisma.variantCapacityReservation.deleteMany({});
  const immutableHistory = await prisma.orderPreorderSnapshot.findFirst({
    where: { order: { publicCode } },
    select: { id: true },
  });
  if (!immutableHistory) {
    await prisma.orderMirror.deleteMany({ where: { publicCode } });
  }
  await prisma.rateLimit.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "order-track-client:" } },
        { id: { startsWith: "order-track-code:" } },
      ],
    },
  });
}

test.beforeAll(async () => {
  await cleanup();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: 920_007,
      pancakeProductId: `tracking-f8c-product-${runId}`,
      slug: `tracking-f8c-product-${runId}`,
      name: "Tracking F8c Product",
      isPresent: true,
      isActive: true,
      syncedAt: confirmedAt,
      sellingPolicy: {
        create: { sellingMode: "PREORDER", negativeStockLimit: -20 },
      },
      variants: {
        create: {
          pancakeVariationId: `tracking-f8c-variant-${runId}`,
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt: confirmedAt,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `tracking-f8c-warehouse-${runId}`,
              quantity: 0,
              syncedAt: confirmedAt,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  historicalProductId = product.id;
  historicalVariantId = product.variants[0]!.id;

  await prisma.orderMirror.create({
    data: {
      publicCode,
      state: "CONFIRMED",
      guestName: "Tracking Sensitive Name",
      guestPhone,
      provinceRef: "tracking-province",
      districtRef: "tracking-district",
      communeRef: "tracking-commune",
      addressDetail: "99 Tracking Sensitive Street",
      note: "tracking-sensitive-note",
      pancakeShopId: 920_007,
      pancakeOrderId: `tracking-pancake-${runId}`,
      pancakeSystemId: "123456",
      pancakeStatus: 6,
      pancakeStatusUpdatedAt: "2026-08-13T00:00:00Z",
      checkoutSnapshottedAt: new Date("2026-08-13T00:00:00Z"),
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      lines: {
        create: [
          {
            variantId: historicalVariantId,
            pancakeVariationId: `tracking-f8c-variant-${runId}`,
            productName: "Tracking F8c Preorder",
            size: "M",
            quantity: 1,
            unitPriceVnd: BigInt(300_000),
            lineTotalVnd: BigInt(300_000),
          },
          {
            variantId: `tracking-f8c-ready-${runId}`,
            pancakeVariationId: `tracking-f8c-ready-${runId}`,
            productName: "Tracking F8c Ready",
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
          preorderReadyAt,
          shippingInnerCityMinDays: 1,
          shippingInnerCityMaxDays: 3,
          shippingOtherProvinceMinDays: 3,
          shippingOtherProvinceMaxDays: 10,
          lines: {
            create: [
              {
                variantId: historicalVariantId,
                quantity: 1,
                state: "PREORDER",
                preorderReadyAt,
              },
              {
                variantId: `tracking-f8c-ready-${runId}`,
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
      publicCode: preorderOnlyCode,
      state: "CONFIRMED",
      guestPhone,
      checkoutSnapshottedAt: confirmedAt,
      merchandiseSubtotalVnd: BigInt(300_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(330_000),
      lines: {
        create: {
          variantId: `tracking-preorder-only-${runId}`,
          pancakeVariationId: `tracking-preorder-only-${runId}`,
          productName: "Tracking Preorder Only",
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(300_000),
          lineTotalVnd: BigInt(300_000),
        },
      },
      preorderSnapshot: {
        create: {
          confirmedAt,
          preorderReadyAt,
          shippingInnerCityMinDays: 1,
          shippingInnerCityMaxDays: 3,
          shippingOtherProvinceMinDays: 3,
          shippingOtherProvinceMaxDays: 10,
          lines: {
            create: {
              variantId: `tracking-preorder-only-${runId}`,
              quantity: 1,
              state: "PREORDER",
              preorderReadyAt,
            },
          },
        },
      },
    },
  });

  await prisma.orderMirror.create({
    data: {
      publicCode: readyOnlyCode,
      state: "CONFIRMED",
      guestPhone,
      checkoutSnapshottedAt: confirmedAt,
      merchandiseSubtotalVnd: BigInt(200_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(230_000),
      lines: {
        create: {
          variantId: `tracking-ready-only-${runId}`,
          pancakeVariationId: `tracking-ready-only-${runId}`,
          productName: "Tracking Ready Only",
          size: "S",
          quantity: 1,
          unitPriceVnd: BigInt(200_000),
          lineTotalVnd: BigInt(200_000),
        },
      },
      preorderSnapshot: {
        create: {
          confirmedAt,
          preorderReadyAt: null,
          lines: {
            create: {
              variantId: `tracking-ready-only-${runId}`,
              quantity: 1,
              state: "READY",
              preorderReadyAt: null,
            },
          },
        },
      },
    },
  });

  await prisma.orderMirror.create({
    data: {
      publicCode: legacyCode,
      state: "CONFIRMED",
      guestPhone,
      checkoutSnapshottedAt: confirmedAt,
      merchandiseSubtotalVnd: BigInt(200_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(230_000),
      lines: {
        create: {
          variantId: `tracking-legacy-${runId}`,
          pancakeVariationId: `tracking-legacy-${runId}`,
          productName: "Tracking Legacy",
          size: "S",
          quantity: 1,
          unitPriceVnd: BigInt(200_000),
          lineTotalVnd: BigInt(200_000),
        },
      },
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/tracking",
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
  await prisma.orderMirror.deleteMany({ where: { publicCode: legacyCode } });
  if (historicalProductId) {
    await prisma.productMirror.deleteMany({ where: { id: historicalProductId } });
  }
  await prisma.$disconnect();
});

test("best-practice Axe gate catches duplicate main landmarks", async ({ page }) => {
  await page.setContent(`
    <main id="main-content">Primary content</main>
    <main>Duplicate content</main>
  `);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();

  expect(accessibilityScan.violations.map(({ id }) => id)).toContain(
    "landmark-no-duplicate-main",
  );
});

test("account password help satisfies buyer Axe contrast", async ({ page }) => {
  await page.goto(`${BASE_URL}/account`, { waitUntil: "networkidle" });
  await expect(page.getByText("Từ 8 đến 128 ký tự.", { exact: true })).toBeVisible();

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();

  expect(accessibilityScan.violations.filter(({ id }) => id === "color-contrast")).toEqual([]);
});

test("guest tracking hides order existence on wrong proof and exposes only safe confirmed summary", async ({
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

  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "TRA CỨU ĐƠN HÀNG" })).toBeVisible();

  await page.getByLabel("Mã đơn hàng").fill(publicCode);
  await page.getByLabel("Số điện thoại").fill("0900000000");
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
  await expect(page.getByText("Không tìm thấy đơn hàng khớp với thông tin đã nhập.")).toBeVisible();

  // React form Actions reset uncontrolled fields after a completed Action, including
  // our safe NOT_FOUND result. A corrected attempt therefore resubmits the full proof.
  await expect(page.getByLabel("Mã đơn hàng")).toHaveValue("");
  await expect(page.getByLabel("Số điện thoại")).toHaveValue("");
  await page.getByLabel("Mã đơn hàng").fill(publicCode);
  await page.getByLabel("Số điện thoại").fill(guestPhone);
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
  const status = page.getByRole("status").filter({ hasText: "Đã tiếp nhận" });
  await expect(status).toContainText(publicCode);
  await expect(status).toContainText("530.000 ₫");

  const pageText = await page.locator("body").innerText();
  for (const sensitive of [
    "Tracking Sensitive Name",
    "Tracking Sensitive Street",
    "tracking-sensitive-note",
    "tracking-pancake-",
    "123456",
  ]) {
    expect(pageText.includes(sensitive)).toBe(false);
  }

  const rateLimitRows = await prisma.rateLimit.findMany({
    where: {
      OR: [
        { id: { startsWith: "order-track-client:" } },
        { id: { startsWith: "order-track-code:" } },
      ],
    },
    select: { id: true, count: true },
    orderBy: { id: "asc" },
  });
  expect(rateLimitRows.length).toBe(2);
  expect(rateLimitRows.map(({ count }) => count).sort((left, right) => left - right)).toEqual([2, 2]);
  for (const { id } of rateLimitRows) {
    expect(id.includes(publicCode)).toBe(false);
    expect(id.includes(guestPhone)).toBe(false);
    expect(id.includes(TRUSTED_CLIENT_IP)).toBe(false);
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("F8c browser surfaces distinguish ready, preorder, mixed and legacy confirmed history", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": "203.0.113.86" });

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(readyOnlyCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveCount(0);

  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(preorderOnlyCode)}`, {
    waitUntil: "networkidle",
  });
  const preorderOnly = page.locator('[data-historical-preorder="true"]');
  await expect(preorderOnly).toContainText("Đặt trước");
  await expect(preorderOnly).toContainText("03/10/2026");
  await expect(preorderOnly.locator('[data-preorder-mixed="true"]')).toHaveCount(0);

  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(publicCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator('[data-preorder-mixed="true"]')).toContainText("giao cùng nhau");

  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(legacyCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByText("Cảm ơn bạn đã đặt hàng.")).toBeVisible();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await page.getByLabel("Mã đơn hàng").fill(legacyCode);
  await page.getByLabel("Số điện thoại").fill(guestPhone);
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã tiếp nhận" })).toBeVisible();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("F8c confirmation and tracking keep immutable preorder history after live catalog mutations", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": "203.0.113.87" });
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
  await expect(confirmation).toContainText("3–10 ngày");
  await expect(confirmation).toContainText("không phải cam kết");
  await expect(confirmation).toContainText("giao cùng nhau");
  const before = await confirmation.innerText();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await page.getByLabel("Mã đơn hàng").fill(publicCode);
  await page.getByLabel("Số điện thoại").fill(guestPhone);
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveText(before);

  await prisma.productSellingPolicy.update({
    where: { productId: historicalProductId },
    data: { sellingMode: "OVERSELL", negativeStockLimit: -7 },
  });
  await prisma.warehouseStock.updateMany({
    where: { variantId: historicalVariantId },
    data: { quantity: 25 },
  });
  await prisma.variantAvailabilityCycle.upsert({
    where: { variantId: historicalVariantId },
    create: {
      variantId: historicalVariantId,
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
    where: { id: historicalProductId },
    data: { isPresent: false, isActive: false },
  });
  await prisma.variantMirror.update({
    where: { id: historicalVariantId },
    data: { isPresent: false, isActive: false },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/checkout/success?order=${encodeURIComponent(publicCode)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveText(before);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/track-order`, { waitUntil: "networkidle" });
  await page.getByLabel("Mã đơn hàng").fill(publicCode);
  await page.getByLabel("Số điện thoại").fill(guestPhone);
  await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();
  await expect(page.locator('[data-historical-preorder="true"]')).toHaveText(before);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
