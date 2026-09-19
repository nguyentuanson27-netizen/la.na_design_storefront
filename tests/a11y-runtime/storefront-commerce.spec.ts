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
const soldOutVariantExternalId = `commerce-runtime-sold-out-variant-${runId}`;
const soldOutWarehouseExternalId = `commerce-runtime-sold-out-warehouse-${runId}`;
const sizeOnlyProductExternalId = `commerce-runtime-size-only-product-${runId}`;
const sizeOnlyProductSlug = `commerce-runtime-size-only-product-${runId}`;
const sizeOnlyProductName = `Commerce Runtime Size Only Tee ${runId}`;
const sizeOnlyVariantExternalId = `commerce-runtime-size-only-variant-${runId}`;
const sizeOnlyWarehouseExternalId = `commerce-runtime-size-only-warehouse-${runId}`;
const unmappedProductExternalId = `commerce-runtime-unmapped-product-${runId}`;
const unmappedProductSlug = `commerce-runtime-unmapped-product-${runId}`;
const unmappedProductName = `Commerce Runtime Unmapped Dress ${runId}`;
const unmappedVariantExternalId = `commerce-runtime-unmapped-variant-${runId}`;
const unmappedWarehouseExternalId = `commerce-runtime-unmapped-warehouse-${runId}`;
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
          status: "PUBLISHED",
          editorialDescription: "Mobile runtime purchase-path regression product.",
          sizeGuide: "ao-dai",
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

  const soldOutVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: soldOutVariantExternalId,
      productId: product.id,
      color: "Black",
      size: "XL",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 920_000,
      pancakeRetailPriceAfterDiscount: 920_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: soldOutVariant.id,
      pancakeWarehouseId: soldOutWarehouseExternalId,
      quantity: 0,
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
          status: "PUBLISHED",
          editorialDescription: "Size-only storefront regression product.",
          sizeGuide: "set-vay-form-rong",
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

  const unmappedProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: unmappedProductExternalId,
      slug: unmappedProductSlug,
      name: unmappedProductName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Same-category product with no size-guide mapping.",
          sizeGuide: null,
        },
      },
    },
  });
  const unmappedVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: unmappedVariantExternalId,
      productId: unmappedProduct.id,
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 710_000,
      pancakeRetailPriceAfterDiscount: 710_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: unmappedVariant.id,
      pancakeWarehouseId: unmappedWarehouseExternalId,
      quantity: 2,
      syncedAt,
    },
  });

  // All three deliberately share one category. F7c must use only ProductContent.sizeGuide:
  // category membership cannot select or fill in a guide.
  await prisma.productCategoryMembership.createMany({
    data: [
      { productId: product.id, categoryKey: "vayDam" },
      { productId: sizeOnlyProduct.id, categoryKey: "vayDam" },
      { productId: unmappedProduct.id, categoryKey: "vayDam" },
    ],
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

test("mobile required-size flow shares one selection with the sticky purchase bar and adds the selected variant", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  const postRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    if (request.method() === "POST") postRequests.push(request.url());
  });

  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();

  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  const mobileBar = page.getByRole("region", { name: "Mua nhanh" });
  const sizeGroup = purchasePanel.getByRole("group", { name: "Kích cỡ" });
  const mainAdd = purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true });
  const mobileAdd = mobileBar.getByRole("button", {
    name: "Thêm vào giỏ từ thanh mua nhanh",
    exact: true,
  });

  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  await expect(mobileBar).toBeVisible();
  expect(await mobileBar.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  await expect(mobileBar.getByText(/890\.000.*₫/)).toBeVisible();
  await expect(mobileBar.getByText("Chưa chọn size", { exact: true })).toBeVisible();
  await expect(mainAdd).toHaveText("Thêm vào giỏ");
  await expect(mainAdd).toBeEnabled();
  await expect(mobileAdd).toHaveText("Thêm vào giỏ");
  await expect(mobileAdd).toBeEnabled();

  const postCountBeforeValidation = postRequests.length;
  await mobileAdd.click();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toBeVisible();
  await expect(sizeGroup).toBeFocused();
  await expect
    .poll(async () => {
      const [sizeBox, mobileBarBox] = await Promise.all([
        sizeGroup.boundingBox(),
        mobileBar.boundingBox(),
      ]);
      if (!sizeBox || !mobileBarBox) return Number.POSITIVE_INFINITY;
      return sizeBox.y + sizeBox.height - mobileBarBox.y;
    })
    .toBeLessThanOrEqual(1);
  expect(postRequests).toHaveLength(postCountBeforeValidation);
  expect((await page.context().cookies()).some(({ name }) => name === "la_cart")).toBe(false);

  await page.getByText("Black", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Black" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M" })).toBeChecked();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toHaveCount(0);
  await expect(mobileBar.getByText("Size M", { exact: true })).toBeVisible();
  await assertPageQuality(page);

  await mobileAdd.click();
  await expect(purchasePanel.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: productName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("Black / M")).toBeVisible();
  await expect(cartLine.getByText(/890\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

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

  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  const size = page.getByRole("radio", { name: "L" });
  const addToBag = purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true });
  await expect(size).not.toBeChecked();
  await expect(addToBag).toBeEnabled();
  await addToBag.click();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toBeVisible();
  await expect(purchasePanel.getByRole("group", { name: "Kích cỡ" })).toBeFocused();
  await page.getByText("L", { exact: true }).click();
  await expect(size).toBeChecked();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toHaveCount(0);
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

test("desktop purchase panel is sticky and validates size before add-to-cart", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const browserErrors: string[] = [];
  const postRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") postRequests.push(request.url());
  });

  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  const sizeGroup = purchasePanel.getByRole("group", { name: "Kích cỡ" });
  const addToBag = purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true });
  const buyNow = purchasePanel.getByRole("button", { name: "Mua ngay", exact: true });

  await expect(page.getByRole("region", { name: "Mua nhanh" })).toBeHidden();
  const stickyMetrics = await purchasePanel.evaluate((element) => ({
    position: getComputedStyle(element).position,
    top: Number.parseFloat(getComputedStyle(element).top),
    documentTop: element.getBoundingClientRect().top + window.scrollY,
  }));
  expect(stickyMetrics.position).toBe("sticky");
  await page.evaluate((scrollTop) => window.scrollTo(0, scrollTop), stickyMetrics.documentTop);
  await page.waitForTimeout(50);
  const stuckTop = await purchasePanel.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(stuckTop - stickyMetrics.top)).toBeLessThanOrEqual(2);

  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  await expect(addToBag).toHaveText("Thêm vào giỏ");
  await expect(addToBag).toBeEnabled();
  await expect(buyNow).toHaveText("Mua ngay");
  await expect(buyNow).toBeEnabled();

  const postCountBeforeValidation = postRequests.length;
  await addToBag.click();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toBeVisible();
  await expect(sizeGroup).toBeFocused();
  expect(postRequests).toHaveLength(postCountBeforeValidation);
  expect((await page.context().cookies()).some(({ name }) => name === "la_cart")).toBe(false);

  await buyNow.click();
  await expect(sizeGroup).toBeFocused();
  expect(postRequests).toHaveLength(postCountBeforeValidation);
  await expect(page).toHaveURL(`${BASE_URL}/shop/${productSlug}`);

  const color = page.getByRole("radio", { name: "Black", exact: true });
  await color.focus();
  await page.keyboard.press("Space");
  await expect(color).toBeChecked();
  const size = page.getByRole("radio", { name: "M", exact: true });
  await size.focus();
  await page.keyboard.press("Space");
  await expect(size).toBeChecked();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toHaveCount(0);
  await addToBag.click();
  await expect(purchasePanel.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");
  await assertPageQuality(page);
  expect(browserErrors).toEqual([]);
});

test("Mua ngay reuses canonical cart authority before navigating to checkout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await page.getByText("Black", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await purchasePanel.getByRole("button", { name: "Mua ngay", exact: true }).click();

  await expect(page).toHaveURL(`${BASE_URL}/checkout`);
  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: productName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("Black / M")).toBeVisible();
  await expect(cartLine.getByText(/890\.000.*₫/)).toBeVisible();
});

test("standard sold-out variant remains visible, disabled, and says exact Hết hàng", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${BASE_URL}/shop/${productSlug}?variant=${soldOutVariantExternalId}`,
    { waitUntil: "networkidle" },
  );

  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  const soldOutSize = page.getByRole("radio", { name: "XL", exact: true });
  await expect(soldOutSize).toBeChecked();
  await expect(soldOutSize).toBeDisabled();
  await expect(purchasePanel.getByText("Hết hàng", { exact: true })).toBeVisible();
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeDisabled();
  await expect(purchasePanel.getByRole("button", { name: "Mua ngay", exact: true })).toBeDisabled();
  await assertPageQuality(page);
});


test("F7c mapped size-guide modal uses the exact product mapping and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const trigger = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Hướng dẫn chọn size: Áo dài" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-size-guide-id", "ao-dai");
  await expect(dialog.getByRole("heading", { name: "Áo dài", exact: true })).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: "S", exact: true })).toBeVisible();
  await expect(dialog.getByRole("rowheader", { name: "Ngực (cm)", exact: true })).toBeVisible();

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      "native modal focus must remain inside the dialog",
    ).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await assertPageQuality(page);
});

test("F7c different manual mappings stay product-specific and an unmapped same-category product has no trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`${BASE_URL}/shop/${sizeOnlyProductSlug}`, { waitUntil: "networkidle" });
  const mappedTrigger = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await mappedTrigger.click();
  const mappedDialog = page.getByRole("dialog", {
    name: "Hướng dẫn chọn size: Set/Váy form rộng",
  });
  await expect(mappedDialog).toBeVisible();
  await expect(mappedDialog).toHaveAttribute("data-size-guide-id", "set-vay-form-rong");
  expect(
    await mappedDialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "modal shell must not create horizontal overflow",
  ).toBe(true);
  await page.keyboard.press("Escape");

  await page.goto(`${BASE_URL}/shop/${unmappedProductSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: unmappedProductName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await assertPageQuality(page);
});
