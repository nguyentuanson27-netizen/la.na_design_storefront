import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BRAND } from "../../src/brand/index.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3222;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_013;
const runId = `${Date.now()}-${process.pid}`;
const productSlug = `pdp-language-${runId}`;
const productName = `PDP Language Coat ${runId}`;
const syncedAt = new Date("2026-08-25T00:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js PDP language server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${productSlug}`, { redirect: "manual" });
      if (response.status === 200) {
        const text = await response.text();
        if (text.includes(productName)) return;
      }
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for PDP language server\n${serverOutput}`);
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
  await prisma.cartItem.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP_ID } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function assertPageQuality(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

test.beforeAll(async () => {
  await cleanup();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `pdp-language-product-${runId}`,
      slug: productSlug,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Áo khoác thử nghiệm cho PDP language contract.",
          sizeGuide: "Chọn kích cỡ thường mặc; phom thử nghiệm tiêu chuẩn.",
          careInstructions: "Giặt nhẹ và phơi nơi thoáng mát.",
        },
      },
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `pdp-language-variant-${runId}`,
      productId: product.id,
      color: "Đen",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt,
    },
  });

  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `pdp-language-warehouse-${runId}`,
      quantity: 2,
      syncedAt,
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      APP_DOMAIN: `${HOST}:${PORT}`,
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

test("PDP uses Vietnamese buyer-functional copy and keeps truthful availability disclosure", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb.getByRole("link", { name: "Cửa hàng", exact: true })).toHaveAttribute(
    "href",
    "/shop",
  );
  // C — rendered check, and the highest-value one: this is the text a shopper actually sees. The
  // brand half comes from Brand Config so a fork inherits the rule instead of silently losing it.
  await expect(
    page.getByText(`${BRAND.identity.name} / Sản phẩm`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Hướng dẫn chọn kích cỡ" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Bảo quản" })).toBeVisible();
  await expect(
    page.getByText(
      "Tình trạng còn hàng được hệ thống kiểm tra lại khi bạn thêm sản phẩm vào giỏ hàng. Số lượng tồn kho chính xác không được hiển thị trên website.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /size guide/i })).toHaveCount(0);

  await expect(page.getByText("Shop", { exact: true })).toHaveCount(0);
  await expect(page.getByText("La.na Design / Product", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Size guide" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Care" })).toHaveCount(0);
  await expect(page.getByText(/phía máy chủ|client/)).toHaveCount(0);

  await assertPageQuality(page);
});
