import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { HOMEPAGE_CONFIG } from "../../src/content/homepage.config.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { seedFeedbackMirror } from "./feedback-mirror-fixture";
import { OPTIMIZED_IMAGE_ROUTE } from "./image-routes";

/**
 * Product page conversion surfaces (owner amendment 2026-10-08, homepage-editorial-refresh §7.6):
 * the customer-photograph rail scoped to the product's own `ANH-FEEDBACK-<code>` photographs, its
 * brand fallback and its ambiguous-code fail-closed rule, the buying facts under the purchase
 * buttons and the size chat links.
 */

const HOST = "127.0.0.1";
const PORT = 3339;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_050;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-10-08T00:00:00.000Z");

const BRAND_1 = HOMEPAGE_CONFIG.feedback.images[0]!.src;
const BRAND_2 = HOMEPAGE_CONFIG.feedback.images[1]!.src;
const OWN_CALIBRATED = HOMEPAGE_CONFIG.feedback.images[2]!.src;
// Not in the dimension registry: the product page must still show it, and the viewer must
// contain it without an invented ratio.
const OWN_UNCALIBRATED = "https://content.pancake.vn/2-2610/2026/10/8/pdp-feedback-uncalibrated.jpg";
// On a variant whose display ID Pancake sent padded; the mirror keeps it untrimmed.
const OWN_PADDED = "https://content.pancake.vn/2-2610/2026/10/8/pdp-feedback-padded-id.jpg";
const SHARED_ONLY = "https://content.pancake.vn/2-2610/2026/10/8/pdp-feedback-shared-code.jpg";

const products = {
  own: { slug: `pdp-feedback-own-${runId}`, name: `PDP Feedback Own ${runId}`, code: "FBOWN1" },
  fallback: { slug: `pdp-feedback-fallback-${runId}`, name: `PDP Feedback Fallback ${runId}`, code: "FBNONE2" },
  sharedA: { slug: `pdp-feedback-shared-a-${runId}`, name: `PDP Feedback Shared A ${runId}`, code: "FBDUP3" },
  sharedB: { slug: `pdp-feedback-shared-b-${runId}`, name: `PDP Feedback Shared B ${runId}`, code: "fbdup3" },
} as const;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js PDP feedback server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${products.own.slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(products.own.name)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for PDP feedback server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(5_000)]);
  }
  server = undefined;
}

async function cleanup() {
  await prisma.cartItem.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP_ID } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function createProduct({ slug, name, code }: { slug: string; name: string; code: string }) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `${slug}-product`,
      slug,
      name,
      productCode: code,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: "Mô tả thử nghiệm.", sizeGuide: "ao-dai" } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Hồng",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${slug}-warehouse`, quantity: 2, syncedAt },
  });
}

/** One tagged feedback variant, on the same inactive holder product the brand rows live on. */
async function tagFeedback(code: string, urls: readonly string[], displayId = `ANH-FEEDBACK-${code}`) {
  const holder = await prisma.productMirror.findFirstOrThrow({
    where: { pancakeShopId: SHOP_ID, name: "ANH FEEDBACK fixture" },
  });
  await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `pdp-feedback-tag-${displayId.replaceAll(" ", "_")}-${runId}`,
      productId: holder.id,
      pancakeDisplayId: displayId,
      pancakeImageUrls: [...urls],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 0,
      pancakeRetailPriceAfterDiscount: 0,
      syncedAt,
    },
  });
}

async function assertPageQuality(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);
}

const rail = (page: Page) => page.locator('[data-pdp-region="feedback"]');

test.beforeAll(async () => {
  await cleanup();
  await seedFeedbackMirror(prisma, { shopId: SHOP_ID, runId, urls: [BRAND_1, BRAND_2] });
  for (const product of Object.values(products)) await createProduct(product);
  await tagFeedback(products.own.code, [OWN_CALIBRATED, OWN_UNCALIBRATED]);
  await tagFeedback(products.own.code, [OWN_PADDED], `ANH-FEEDBACK-${products.own.code} `);
  await tagFeedback("FBDUP3", [SHARED_ONLY]);

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/pdp-feedback",
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

test.beforeEach(async ({ page }) => {
  await page.route(OPTIMIZED_IMAGE_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }),
  );
});

test("a product's own tagged photographs show under its own heading, an uncalibrated one included", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.own.slug}`, { waitUntil: "networkidle" });

  const section = rail(page);
  await expect(section.getByRole("heading", { level: 2, name: "Khách hàng diện mẫu này" })).toBeVisible();
  const photos = section.getByRole("button", { name: /^Phóng to ảnh/ });
  // Two from `ANH-FEEDBACK-FBOWN1`, one from the padded `ANH-FEEDBACK-FBOWN1 `.
  await expect(photos).toHaveCount(3);
  await expect(section.getByRole("link", { name: /^Xem thêm/ })).toHaveAttribute("href", "/feedback");

  // The in-panel link names the count and leads to the rail.
  const jump = page.getByRole("link", { name: "Xem 3 ảnh khách hàng diện mẫu này" });
  await expect(jump).toHaveAttribute("href", "#pdp-feedback");

  // The uncalibrated photograph opens contained in the viewer, and closing returns focus to it.
  await photos.nth(1).click();
  const viewer = page.getByRole("dialog", { name: "Xem ảnh feedback" });
  await expect(viewer).toBeVisible();
  const box = await viewer.locator("img").boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(photos.nth(1)).toBeFocused();

  // The buying facts and the size chat links sit inside the purchase panel.
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const facts = panel.getByRole("list", { name: "Cam kết mua hàng" }).getByRole("listitem");
  await expect(facts).toHaveCount(3);
  await expect(facts.nth(0)).toHaveText("Thanh toán khi nhận hàng (COD)");
  await expect(facts.nth(1).getByRole("link")).toHaveAttribute("href", "/returns");
  await expect(facts.nth(2).getByRole("link")).toHaveAttribute("href", "/shipping");
  await expect(panel.getByRole("link", { name: /^Messenger/ })).toHaveAttribute("href", /^https:\/\/m\.me\//);
  await expect(panel.getByRole("link", { name: /^Zalo/ })).toHaveAttribute("href", /^https:\/\/zalo\.me\/0\d{9}$/);

  await assertPageQuality(page);
});

test("a product without its own photographs shows the brand's under the brand title", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.fallback.slug}`, { waitUntil: "networkidle" });

  const section = rail(page);
  await expect(
    section.getByRole("heading", { level: 2, name: HOMEPAGE_CONFIG.feedback.title! }),
  ).toBeVisible();
  // The two brand photographs and the calibrated tagged one, which joins the brand gallery.
  await expect(section.getByRole("button", { name: /^Phóng to ảnh/ })).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Khách hàng diện mẫu này" })).toHaveCount(0);
  await assertPageQuality(page);
});

test("a code two present products share attributes its photographs to neither", async ({ page }) => {
  for (const product of [products.sharedA, products.sharedB]) {
    await page.goto(`${BASE_URL}/shop/${product.slug}`, { waitUntil: "networkidle" });
    await expect(
      rail(page).getByRole("heading", { level: 2, name: HOMEPAGE_CONFIG.feedback.title! }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Khách hàng diện mẫu này" })).toHaveCount(0);
    await expect(page.locator(`img[src*="pdp-feedback-shared-code"]`)).toHaveCount(0);
  }
});

test("the brand gallery stays whole while a tagged photograph is uncalibrated", async ({ page }) => {
  await page.goto(`${BASE_URL}/feedback`, { waitUntil: "networkidle" });
  // Two brand photographs plus the calibrated tagged one; the uncalibrated tagged one is left out
  // instead of closing the page.
  await expect(page.locator(".feedback-gallery__item")).toHaveCount(3);
});
