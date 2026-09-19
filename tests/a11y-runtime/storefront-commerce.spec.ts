import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3218;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_010;
const runId = `${Date.now()}-${process.pid}`;
const productExternalId = `commerce-runtime-product-${runId}`;
const productSlug = `commerce-runtime-product-${runId}`;
const productName = `Commerce Runtime Overshirt ${runId}`;
const variantExternalId = `commerce-runtime-variant-${runId}`;
const warehouseExternalId = `commerce-runtime-warehouse-${runId}`;
const sizeOnlyProductExternalId = `commerce-runtime-size-only-product-${runId}`;
const sizeOnlyProductSlug = `commerce-runtime-size-only-product-${runId}`;
const sizeOnlyProductName = `Commerce Runtime Size Only Tee ${runId}`;
const sizeOnlyVariantExternalId = `commerce-runtime-size-only-variant-${runId}`;
const sizeOnlyWarehouseExternalId = `commerce-runtime-size-only-warehouse-${runId}`;
const syncedAt = new Date("2026-08-13T03:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js storefront commerce server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop/${productSlug}`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which requests Better Auth's catch-all route
      // as soon as it hydrates. A page-only readiness probe can win the race against a freshly
      // started `next dev` and let Playwright navigate while that route still answers a transient
      // 404, which the browser's clean-console guard then correctly records. Declare the fixture
      // ready only once the page and the route it immediately depends on are both live; the
      // assertion itself stays strict.
      if (pageResponse.status === 200 && authResponse.status === 200) {
        const text = await pageResponse.text();
        if (text.includes(productName)) return;
      }
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for storefront commerce server\n${serverOutput}`);
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
  ).toBeLessThanOrEqual(overflowReport.viewportWidth);

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
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Mobile runtime purchase-path regression product.",
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: variantExternalId,
      productId: product.id,
      color: "Black",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 890_000,
      pancakeRetailPriceAfterDiscount: 890_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: warehouseExternalId,
      quantity: 2,
      syncedAt,
    },
  });

  const sizeOnlyProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: sizeOnlyProductExternalId,
      slug: sizeOnlyProductSlug,
      name: sizeOnlyProductName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Size-only storefront regression product.",
        },
      },
    },
  });
  const sizeOnlyVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: sizeOnlyVariantExternalId,
      productId: sizeOnlyProduct.id,
      color: null,
      size: "L",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 690_000,
      pancakeRetailPriceAfterDiscount: 690_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: sizeOnlyVariant.id,
      pancakeWarehouseId: sizeOnlyWarehouseExternalId,
      quantity: 2,
      syncedAt,
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
      NEXT_DIST_DIR: ".next-test/storefront-commerce",
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

test("mobile shopper selects Color × Size, adds to bag, updates cart and reaches checkout", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByText("Chọn màu × kích cỡ", { exact: true })).toBeVisible();
  await assertPageQuality(page);

  const addToBag = page.getByRole("button", { name: "Thêm vào giỏ hàng" });
  await expect(addToBag).toBeDisabled();
  await page.getByText("Black", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Black" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M" })).toBeChecked();
  await expect(addToBag).toBeEnabled();
  await addToBag.click();
  await expect(page.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");

  const cartCookie = (await page.context().cookies()).find(({ name }) => name === "la_cart");
  expect(cartCookie?.httpOnly).toBe(true);
  expect(cartCookie?.sameSite).toBe("Lax");

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: productName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("Black / M")).toBeVisible();
  await expect(cartLine.getByText(/890\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

  const quantity = page.getByRole("spinbutton", { name: "Số lượng" });
  await expect(quantity).toHaveValue("1");
  await quantity.fill("2");
  await page.getByRole("button", { name: "Cập nhật" }).click();
  await expect(page.getByRole("status")).toContainText("Đã cập nhật số lượng.");
  await expect(quantity).toHaveValue("2");

  const checkoutLink = page.getByRole("link", { name: "Tiến hành đặt hàng" });
  await expect(checkoutLink).toBeVisible();
  await checkoutLink.click();
  await expect(page).toHaveURL(`${BASE_URL}/checkout`);
  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
  await assertPageQuality(page);

  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("size-only product hides Color and becomes purchasable after selecting Size", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/shop/${sizeOnlyProductSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: sizeOnlyProductName })).toBeVisible();
  await expect(page.getByRole("group", { name: "Màu" })).toHaveCount(0);
  await expect(page.getByText("Chọn kích cỡ", { exact: true })).toBeVisible();

  const size = page.getByRole("radio", { name: "L" });
  const addToBag = page.getByRole("button", { name: "Thêm vào giỏ hàng" });
  await expect(addToBag).toBeDisabled();
  await page.getByText("L", { exact: true }).click();
  await expect(size).toBeChecked();
  await expect(addToBag).toBeEnabled();
  await assertPageQuality(page);

  await addToBag.click();
  await expect(page.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: sizeOnlyProductName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("L", { exact: true })).toBeVisible();
  await expect(cartLine.getByText(/690\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("desktop shopper (1440px) selects Color × Size, adds to bag, updates cart, and reaches checkout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  // 1. PDP selection at 1440px
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByText("Chọn màu × kích cỡ", { exact: true })).toBeVisible();
  await assertPageQuality(page);

  const addToBag = page.getByRole("button", { name: "Thêm vào giỏ hàng" });
  await expect(addToBag).toBeDisabled();
  await page.getByText("Black", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Black" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M" })).toBeChecked();
  await expect(addToBag).toBeEnabled();
  await addToBag.click();
  await expect(page.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");

  // 2. Cart page & quantity update at 1440px
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: productName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("Black / M")).toBeVisible();
  await expect(cartLine.getByText(/890\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

  const quantity = page.getByRole("spinbutton", { name: "Số lượng" });
  await expect(quantity).toHaveValue("1");
  await quantity.fill("2");
  await page.getByRole("button", { name: "Cập nhật" }).click();
  await expect(page.getByRole("status")).toContainText("Đã cập nhật số lượng.");
  await expect(quantity).toHaveValue("2");

  // 3. Checkout page at 1440px
  const checkoutLink = page.getByRole("link", { name: "Tiến hành đặt hàng" });
  await expect(checkoutLink).toBeVisible();
  await checkoutLink.click();
  await expect(page).toHaveURL(`${BASE_URL}/checkout`);
  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
  await assertPageQuality(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
