import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { BRAND } from "../../src/brand/index.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

const HOST = "127.0.0.1";
const PORT = 3326;
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
          editorialDescription: Array.from({ length: 16 }, (_, i) => `Dòng mô tả sản phẩm thử nghiệm ${i + 1}.`).join("\n"),
          material: "100% cotton dệt kim mềm mại.",
          sizeGuide: "ao-dai",
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

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      ...nextServerEnv(".next-test/pdp-language"),
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

  // Owner amendment removes the visible PDP breadcrumb entirely; structured breadcrumb/SEO
  // authority remains server-owned outside this presentation.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
  // Owner amendment 2026-09-22 removes the identity eyebrow from the below-`lg` PDP. Keep the
  // localized source string in the shared desktop composition, but it must not be visible here.
  await expect(
    page.getByText(`${BRAND.identity.name} / Sản phẩm`, { exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Hướng dẫn bảo quản", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/máy chủ|hệ thống kiểm tra lại|tồn kho chính xác|Chọn loại × kích cỡ/i),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();
  await expect(page.getByRole("link", { name: /size guide/i })).toHaveCount(0);

  await expect(page.getByText("Shop", { exact: true })).toHaveCount(0);
  await expect(page.getByText("La.na Design / Product", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Hướng dẫn chọn kích cỡ", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Size guide" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Care" })).toHaveCount(0);
  await expect(page.getByText(/phía máy chủ|client/)).toHaveCount(0);

  await assertPageQuality(page);
});

test("PDP description, material, shipping and returns start fully expanded on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const description = page.locator('section[aria-labelledby="pdp-description-title"]');
  const descriptionText = description.locator(".pdp-clamped");
  await expect(descriptionText).toHaveAttribute("data-clamped", "false");
  await expect(descriptionText).not.toHaveClass(/max-h-36/);
  await expect(descriptionText).toContainText("Dòng mô tả sản phẩm thử nghiệm 16.");
  await description.getByRole("button", { name: "Thu gọn" }).click();
  await expect(descriptionText).toHaveAttribute("data-clamped", "true");
  await description.getByRole("button", { name: "Xem thêm" }).click();
  await expect(descriptionText).toHaveAttribute("data-clamped", "false");

  for (const [titleId, title] of [
    ["pdp-material-title", "Chất liệu"],
    ["pdp-shipping-title", "Giao hàng"],
    ["pdp-returns-title", "Đổi trả"],
  ] as const) {
    const section = page.locator(`section[aria-labelledby="${titleId}"]`);
    const toggle = section.getByRole("button", { name: title, exact: true });
    const body = section.locator(":scope > div[id]");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(body).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
  }

  // Only the four requested blocks change; care instructions keep their original default.
  const care = page.locator('section[aria-labelledby="pdp-care-title"]');
  await expect(care.getByRole("button", { name: "Hướng dẫn bảo quản" })).toHaveAttribute("aria-expanded", "false");

  // Desktop still renders every section as static, fully visible content.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(care.locator(":scope > div[id]")).toBeVisible();
  await expect(page.locator('section[aria-labelledby="pdp-material-title"] > div[id]')).toBeVisible();
  await assertPageQuality(page);
});
