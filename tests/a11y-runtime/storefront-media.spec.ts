import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3219;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_019;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-13T04:00:00.000Z");

const multiSlug = `media-multi-product-${runId}`;
const multiName = `Multi Media Jacket ${runId}`;
const singleSlug = `media-single-product-${runId}`;
const singleName = `Single Media Tee ${runId}`;
const fallbackSlug = `media-fallback-product-${runId}`;
const fallbackName = `Fallback Product ${runId}`;

// 1x1 transparent/dummy JPEG image payload for offline-safe fixture responses
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const TINY_JPEG_BUFFER = Buffer.from(TINY_JPEG_BASE64, "base64");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js media test server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for storefront media server\n${serverOutput}`);
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
  const overflowReport = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className,
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        };
      })
      .filter(({ left, right }) => left < -0.5 || right > viewportWidth + 0.5)
      .slice(0, 12);

    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  expect(
    overflowReport.offenders,
    `horizontal overflow report: ${JSON.stringify(overflowReport)}`,
  ).toEqual([]);
  expect(
    overflowReport.documentWidth,
    `horizontal overflow report: ${JSON.stringify(overflowReport)}`,
  ).toBeLessThanOrEqual(overflowReport.viewportWidth + 1);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

test.beforeAll(async () => {
  await cleanup();

  // 1. Multi-image product: primary + 2 variant images
  const multiProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-multi-${runId}`,
      slug: multiSlug,
      name: multiName,
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Multi-image storefront media test jacket.",
        },
      },
    },
  });
  const multiVariant1 = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-multi-var-1-${runId}`,
      productId: multiProduct.id,
      color: "Black",
      size: "M",
      pancakeImageUrls: [
        "https://content.pancake.vn/images/1/2/3/primary.jpg",
        "https://content.pancake.vn/images/1/2/3/angle-front.jpg",
      ],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_250_000,
      pancakeRetailPriceAfterDiscount: 1_250_000,
      syncedAt,
    },
  });
  const multiVariant2 = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-multi-var-2-${runId}`,
      productId: multiProduct.id,
      color: "Olive",
      size: "L",
      pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/detail-fabric.jpg"],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_250_000,
      pancakeRetailPriceAfterDiscount: 1_250_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.createMany({
    data: [
      { variantId: multiVariant1.id, pancakeWarehouseId: `wh-1-${runId}`, quantity: 5, syncedAt },
      { variantId: multiVariant2.id, pancakeWarehouseId: `wh-2-${runId}`, quantity: 3, syncedAt },
    ],
  });

  // 2. Single-image product: primary image only, no variant images
  const singleProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-single-${runId}`,
      slug: singleSlug,
      name: singleName,
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/single-tee.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Single-image storefront media test tee.",
        },
      },
    },
  });
  const singleVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-single-var-${runId}`,
      productId: singleProduct.id,
      color: "Stone",
      size: "M",
      pancakeImageUrls: [],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 450_000,
      pancakeRetailPriceAfterDiscount: 450_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: singleVariant.id, pancakeWarehouseId: `wh-3-${runId}`, quantity: 4, syncedAt },
  });

  // 3. Fallback product: untrusted and unreviewed media (fails closed)
  const fallbackProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-fallback-${runId}`,
      slug: fallbackSlug,
      name: fallbackName,
      primaryImageUrl: "http://insecure-http.com/images/1/2/3/photo.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Fallback product with untrusted media.",
        },
      },
    },
  });
  const fallbackVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-fallback-var-${runId}`,
      productId: fallbackProduct.id,
      color: "Ink",
      size: "S",
      pancakeImageUrls: ["https://content.pancake.vn/arbitrary/path.png"],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 350_000,
      pancakeRetailPriceAfterDiscount: 350_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: fallbackVariant.id, pancakeWarehouseId: `wh-4-${runId}`, quantity: 2, syncedAt },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
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

test("storefront catalog card renders trusted primary photography and fallback on untrusted media", async ({
  page,
}) => {
  // Mock external image optimization to ensure deterministic offline execution
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await assertPageQuality(page);

  // Card with trusted image: visible in accessibility tree with role="img" and matching name
  const multiCard = page.locator("article").filter({ hasText: multiName });
  await expect(multiCard).toBeVisible();
  const multiImg = multiCard.getByRole("img", { name: multiName });
  await expect(multiImg).toBeVisible();
  await expect(multiCard.locator(".product-visual")).not.toHaveAttribute("aria-hidden", "true");
  // The hover swap shows another photo of the same product, so it carries no name of its own and
  // stays out of the accessibility tree — one card must expose exactly one image to assistive tech.
  await expect(multiCard.getByRole("img")).toHaveCount(1);
  await expect(multiCard.locator("img")).toHaveCount(2);

  // Card with untrusted fallback: decorative fallback wrapper is aria-hidden and has no img role
  const fallbackCard = page.locator("article").filter({ hasText: fallbackName });
  await expect(fallbackCard).toBeVisible();
  await expect(fallbackCard.getByRole("img")).toHaveCount(0);
  await expect(fallbackCard.locator(".product-visual")).toHaveAttribute("aria-hidden", "true");
  await expect(fallbackCard.locator(".garment-silhouette")).toBeVisible();
});

test("PDP with single trusted image renders hero image without redundant thumbnail controls", async ({
  page,
}) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${singleSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: singleName })).toBeVisible();
  await assertPageQuality(page);

  // Hero image is visible
  const heroImg = page.locator(`img[alt="${singleName}"]`);
  await expect(heroImg).toBeVisible();

  // No redundant carousel thumbnail controls
  await expect(page.locator("nav[aria-label^='Danh sách ảnh']")).toHaveCount(0);
});

test("PDP with multiple images renders a one-column mobile editorial grid with every trusted image once", async ({
  page,
}) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: multiName })).toBeVisible();

  const gallery = page.getByLabel(`Bộ sưu tập hình ảnh ${multiName}`);
  const images = gallery.locator("img");
  await expect(images).toHaveCount(3);

  for (let index = 0; index < 3; index += 1) {
    await expect(images.nth(index)).toBeVisible();
  }

  const renderedImages = await images.evaluateAll((elements) =>
    elements.map((element) => ({
      alt: element.getAttribute("alt"),
      src: element.getAttribute("src"),
    })),
  );
  expect(renderedImages.map(({ alt }) => alt)).toEqual([
    `${multiName} - Ảnh 1`,
    `${multiName} - Ảnh 2`,
    `${multiName} - Ảnh 3`,
  ]);
  expect(new Set(renderedImages.map(({ src }) => src)).size).toBe(3);

  const columnCount = await gallery.evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.trim();
    return columns.length === 0 ? 0 : columns.split(/\s+/).length;
  });
  expect(columnCount).toBe(1);
  await expect(gallery.locator("button")).toHaveCount(0);

  await assertPageQuality(page);
});

test("PDP with untrusted media renders intentional fallback without broken image", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/shop/${fallbackSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: fallbackName })).toBeVisible();
  await assertPageQuality(page);

  // Intentional silhouette fallback
  await expect(page.locator(".garment-silhouette")).toBeVisible();
  await expect(page.getByText("Hình ảnh sản phẩm đang được chuẩn hóa cho storefront.")).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
});

test("desktop viewport renders catalog cards and PDP gallery without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await assertPageQuality(page);

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });
  const gallery = page.getByLabel(`Bộ sưu tập hình ảnh ${multiName}`);
  await expect(gallery.locator("img")).toHaveCount(3);
  const columnCount = await gallery.evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.trim();
    return columns.length === 0 ? 0 : columns.split(/\s+/).length;
  });
  expect(columnCount).toBe(2);
  await assertPageQuality(page);
});

test("runtime network and CSP headers enforce Pancake media allowlist and reject unreviewed optimizer requests", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  expect(response).not.toBeNull();
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"];
  expect(csp).toBeDefined();
  expect(csp).toContain("https://content.pancake.vn");

  // Direct optimizer request with unreviewed arbitrary path on trusted host fails closed (HTTP 400)
  const unreviewedRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn/arbitrary/shirt.jpg")}&w=1080&q=75`,
  );
  expect(unreviewedRes.status).toBe(400);

  // Direct optimizer request with custom port on trusted host fails closed (HTTP 400)
  const customPortRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn:8443/images/1/2/3/shirt.jpg")}&w=1080&q=75`,
  );
  expect(customPortRes.status).toBe(400);

  // Direct optimizer request with uppercase .JPG on trusted host fails closed (HTTP 400)
  const uppercaseRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn/images/1/2/3/shirt.JPG")}&w=1080&q=75`,
  );
  expect(uppercaseRes.status).toBe(400);
});
