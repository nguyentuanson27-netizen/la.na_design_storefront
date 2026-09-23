import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { SIZE_GUIDE } from "../../src/brand/size-guide.config.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

const HOST = "127.0.0.1";
const PORT = 3330;
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
const smallFormProductExternalId = `commerce-runtime-small-form-product-${runId}`;
const smallFormProductSlug = `commerce-runtime-small-form-product-${runId}`;
const smallFormProductName = `Commerce Runtime Small Form Dress ${runId}`;
const smallFormVariantExternalId = `commerce-runtime-small-form-variant-${runId}`;
const smallFormWarehouseExternalId = `commerce-runtime-small-form-warehouse-${runId}`;
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

async function expectSizeGuideArtworkFits(
  page: Page,
  dialog: Locator,
  expectedSrc: string,
  expectedChartTitle: string,
  expectedSmallChest: string,
) {
  const image = dialog.locator("img");
  await expect(image).toHaveCount(1);
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", expectedSrc);
  await expect(image).toHaveAttribute("alt", "");

  const semanticTable = dialog.getByRole("table", {
    name: `Dữ liệu bảng size ${expectedChartTitle}`,
    exact: true,
  });
  await expect(semanticTable).toHaveCount(1);
  await expect(semanticTable.getByRole("columnheader", { name: "S", exact: true })).toHaveCount(1);
  await expect(
    semanticTable.getByRole("rowheader", { name: "Ngực (cm)", exact: true }),
  ).toHaveCount(1);
  await expect(semanticTable.getByRole("cell", { name: expectedSmallChest, exact: true })).toHaveCount(
    1,
  );

  const metrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.scrollWidth, "size-guide dialog must not scroll horizontally").toBeLessThanOrEqual(
    metrics.clientWidth + 1,
  );
  expect(metrics.scrollHeight, "size-guide dialog must not scroll vertically").toBeLessThanOrEqual(
    metrics.clientHeight + 1,
  );

  const imageBox = await image.boundingBox();
  const dialogBox = await dialog.boundingBox();
  if (!imageBox || !dialogBox) throw new Error("Expected size-guide artwork and dialog to be laid out");

  expect(imageBox.x).toBeGreaterThanOrEqual(dialogBox.x - 1);
  expect(imageBox.y).toBeGreaterThanOrEqual(dialogBox.y - 1);
  expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
  expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
  expect(imageBox.x).toBeGreaterThanOrEqual(-1);
  expect(imageBox.y).toBeGreaterThanOrEqual(-1);
  expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
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

  // The scans in this file run after a Server Action has revalidated the page, and the root
  // layout's `generateMetadata` awaits `connection()`, so React unmounts and remounts the hoisted
  // <title> across that head swap. Axe landing in the gap reports `document-title` against a page
  // whose title is fine. `document-title-watch.ts` already carries this fix for the admin and
  // checkout specs; this one was still scanning straight after the click.
  await expectSettledDocumentTitle(page);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

// The watch has to be observing before the transient, so it is installed before any navigation
// rather than when a scan wants to read it. `expectSettledDocumentTitle` refuses to answer without
// it, so a forgotten install fails loudly instead of silently restoring the flake.
test.beforeEach(async ({ page }) => {
  await watchDocumentTitle(page);
});

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

  const smallFormProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: smallFormProductExternalId,
      slug: smallFormProductSlug,
      name: smallFormProductName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Small-form storefront size-guide regression product.",
          sizeGuide: "set-vay-form-nho",
        },
      },
    },
  });
  const smallFormVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: smallFormVariantExternalId,
      productId: smallFormProduct.id,
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 720_000,
      pancakeRetailPriceAfterDiscount: 720_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: smallFormVariant.id,
      pancakeWarehouseId: smallFormWarehouseExternalId,
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
      { productId: smallFormProduct.id, categoryKey: "vayDam" },
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

test("the mobile sticky CTA opens the selection sheet, and a confirmed add hands off to the cart", async ({
  page,
}) => {
  /*
   * The mobile spec turned the sticky bar from a scroll shortcut with its own add button into a
   * real selection entry point: incomplete selection opens the sheet, a confirmed add closes the
   * sheet first and only then opens the cart, so exactly one modal owns focus at a time.
   */
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

  const stickyBar = page.getByRole("region", { name: "Mua nhanh" });
  const stickyCta = stickyBar.getByRole("button");
  const sheet = page.getByRole("dialog", { name: "Chọn lựa chọn sản phẩm" });

  // The inline selector stays touch-friendly but no longer spends a full section break between
  // each dimension on a phone. This is the density contract from the owner's Áo yếm tơ reference.
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  for (const groupName of ["Màu", "Kích cỡ"]) {
    const group = purchasePanel.getByRole("group", { name: groupName });
    const marginTop = await group.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).marginTop),
    );
    expect(marginTop, `${groupName} mobile top spacing`).toBeLessThanOrEqual(16);

    const chipBox = await group.locator("label span").first().boundingBox();
    expect(chipBox?.height, `${groupName} touch target height`).toBeGreaterThanOrEqual(44);
  }

  // Nothing chosen yet: the CTA names only the dimensions this product actually has, and says it
  // opens a dialog rather than pretending it can add.
  await expect(stickyBar).toBeVisible();
  expect(await stickyBar.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  await expect(stickyBar.getByText(/890\.000.*₫/)).toBeVisible();
  await expect(stickyCta).toHaveText("Chọn màu / size");
  await expect(stickyCta).toHaveAttribute("aria-haspopup", "dialog");
  await expect(stickyCta).toHaveAttribute("aria-expanded", "false");

  const postCountBeforeSheet = postRequests.length;
  await stickyCta.click();
  await expect(sheet).toBeVisible();
  await expect(stickyCta).toHaveAttribute("aria-expanded", "true");

  // Opening a selection sheet is not a purchase attempt.
  expect(postRequests).toHaveLength(postCountBeforeSheet);
  expect((await page.context().cookies()).some(({ name }) => name === "la_cart")).toBe(false);

  // One modal, and focus inside it.
  expect(
    await sheet.evaluate((element) => element.contains(document.activeElement)),
    "focus moves into the sheet",
  ).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  const confirm = sheet.getByRole("button", { name: /Chọn màu \/ size|Thêm vào giỏ/ });
  await expect(confirm).toBeDisabled();

  await sheet.getByRole("group", { name: "Màu" }).getByText("Black", { exact: true }).click();
  await sheet.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Black" }).first()).toBeChecked();
  await expect(confirm).toHaveText("Thêm vào giỏ");
  await expect(confirm).toBeEnabled();
  await assertPageQuality(page);

  await confirm.click();

  // Server-confirmed success: the sheet is gone before the cart becomes the active modal, so the
  // page never holds two focus traps at once.
  const cartDrawer = page.getByRole("dialog", { name: "Giỏ hàng" });
  await expect(cartDrawer).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect
    .poll(
      () => cartDrawer.evaluate((element) => element.contains(document.activeElement)),
      { message: "focus moves into the cart" },
    )
    .toBe(true);

  // The cart shows the exact selected option, and its quantity controls keep a real touch target.
  await expect(cartDrawer.getByText("Black / M")).toBeVisible();
  for (const label of [
    `Giảm số lượng ${productName}`,
    `Tăng số lượng ${productName}`,
  ]) {
    const control = cartDrawer.getByRole("button", { name: label, exact: true });
    const box = await control.boundingBox();
    expect(box?.width, `${label} width`).toBeGreaterThanOrEqual(44);
    expect(box?.height, `${label} height`).toBeGreaterThanOrEqual(44);
  }
  await expect(
    cartDrawer.getByRole("button", {
      name: `Xóa ${productName} khỏi giỏ hàng`,
      exact: true,
    }),
  ).toBeVisible();

  /*
   * Closing the cart returns focus to a real control. The sheet unmounted before the cart opened,
   * so there was no focused element for the drawer to remember -- without a fallback this lands on
   * the body and a keyboard user is dropped at the top of the document.
   */
  await cartDrawer.getByRole("button", { name: "Đóng giỏ hàng", exact: true }).click();
  await expect(cartDrawer).toBeHidden();
  const restored = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      tagName: active?.tagName ?? "none",
      label: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
    };
  });
  expect(restored.tagName, "focus must not fall back to the document").not.toBe("BODY");
  expect(restored.tagName).toBe("BUTTON");

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(page.getByRole("link", { name: productName, exact: true })).toBeVisible();
  await expect(cartLine.getByText("Black / M")).toBeVisible();
  await expect(cartLine.getByText(/890\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("variant selectors share compact rectangular presentation across panel and quick sheet", async ({
  page,
}) => {
  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

    const panel = page.getByRole("region", { name: "Mua sản phẩm" });
    const colorGroup = panel.getByRole("group", { name: "Màu", exact: true });
    const sizeGroup = panel.getByRole("group", { name: "Kích cỡ", exact: true });
    const blackChip = colorGroup
      .locator("label")
      .filter({ hasText: /^Black$/ })
      .locator("span");
    const mediumChip = sizeGroup
      .locator("label")
      .filter({ hasText: /^M$/ })
      .locator("span");

    for (const [label, group] of [
      ["Màu", colorGroup],
      ["Kích cỡ", sizeGroup],
    ] as const) {
      const marginTop = await group.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).marginTop),
      );
      expect(marginTop, `${viewport.name} ${label} group spacing`).toBeLessThanOrEqual(20);

      const chipBox = await group.locator("label span").first().boundingBox();
      expect(chipBox?.height, `${viewport.name} ${label} option height`).toBeGreaterThanOrEqual(44);
    }

    const defaultChipBackground = await blackChip.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(
      defaultChipBackground,
      `${viewport.name} default chip uses a neutral brand surface`,
    ).not.toBe("rgba(0, 0, 0, 0)");

    await blackChip.click();
    await expect(colorGroup.locator("legend")).toHaveText("Màu: Black");
    await mediumChip.click();
    await expect(sizeGroup.locator("legend")).toHaveText("Kích cỡ: M");

    await expect
      .poll(
        () => blackChip.evaluate((element) => getComputedStyle(element).backgroundColor),
        { message: `${viewport.name} selected chip reaches the brand-filled state`, timeout: 2_000 },
      )
      .toBe("rgb(59, 34, 25)");

    await expect(
      sizeGroup.getByRole("button", { name: "Hướng dẫn chọn size", exact: true }),
    ).toHaveCount(1);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  const sticky = page.getByRole("region", { name: "Mua nhanh" }).getByRole("button");
  await sticky.click();

  const sheet = page.getByRole("dialog", { name: "Chọn lựa chọn sản phẩm" });
  const sheetColor = sheet.getByRole("group", { name: "Màu", exact: true });
  const sheetSize = sheet.getByRole("group", { name: "Kích cỡ", exact: true });
  const sheetBlack = sheetColor
    .locator("label")
    .filter({ hasText: /^Black$/ })
    .locator("span");
  const sheetMedium = sheetSize
    .locator("label")
    .filter({ hasText: /^M$/ })
    .locator("span");

  expect(
    await sheetBlack.evaluate((element) => getComputedStyle(element).backgroundColor),
    "sheet default chip uses the same neutral surface",
  ).not.toBe("rgba(0, 0, 0, 0)");

  await sheetBlack.click();
  await expect(sheetColor.locator("legend")).toHaveText("Màu: Black");
  await sheetMedium.click();
  await expect(sheetSize.locator("legend")).toHaveText("Kích cỡ: M");
  await expect(
    sheetSize.getByRole("button", { name: "Hướng dẫn chọn size", exact: true }),
  ).toHaveCount(1);

  await assertPageQuality(page);
});

test("a rejected add keeps the selection sheet open with feedback, and opens no cart", async ({
  page,
}) => {
  /*
   * The sheet may only hand off to the cart on server-confirmed success. A rejected add has to
   * leave the shopper exactly where they were, with their selection intact and something to read.
   */
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const stickyCta = page.getByRole("region", { name: "Mua nhanh" }).getByRole("button");
  await stickyCta.click();

  const sheet = page.getByRole("dialog", { name: "Chọn lựa chọn sản phẩm" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("group", { name: "Màu" }).getByText("Black", { exact: true }).click();
  await sheet.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();

  const confirm = sheet.getByRole("button", { name: "Thêm vào giỏ" });
  await expect(confirm).toBeEnabled();

  // Fail the add on the way to the server, which is the one thing a client cannot talk itself out
  // of: no confirmation, so no handoff.
  await page.route("**/shop/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });

  await confirm.click();

  await expect(sheet, "the sheet stays open on rejection").toBeVisible();
  await expect(sheet.getByRole("status")).toContainText("Không thể thêm vào giỏ hàng lúc này");
  await expect(page.getByRole("dialog", { name: "Giỏ hàng" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  // The selection the shopper made is still theirs.
  await expect(page.getByRole("radio", { name: "M", exact: true }).first()).toBeChecked();
  expect((await page.context().cookies()).some(({ name }) => name === "la_cart")).toBe(false);

  await page.unroute("**/shop/**");
});

test("the size guide suspends the selection sheet and gives focus back to it", async ({ page }) => {
  /*
   * Two modals must never be live at once. Opening the guide from the sheet suspends the sheet and
   * closing the guide restores it with the selection intact.
   */
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const stickyCta = page.getByRole("region", { name: "Mua nhanh" }).getByRole("button");
  await stickyCta.click();

  const sheet = page.getByRole("dialog", { name: "Chọn lựa chọn sản phẩm" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();

  const sheetSizeGuide = sheet.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await sheetSizeGuide.click();

  const guide = page.getByRole("dialog", { name: /^Hướng dẫn chọn size: / });
  await expect(guide).toBeVisible();
  // The sheet stands down rather than stacking behind the guide.
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(guide.getByRole("button", { name: "Đóng", exact: true })).toBeFocused();

  await page.keyboard.press("Escape");

  // ...and comes back, still holding the selection, with focus on the control that left.
  await expect(sheet).toBeVisible();
  await expect(guide).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("radio", { name: "M", exact: true }).first()).toBeChecked();
  await expect(sheetSizeGuide).toBeFocused();
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
  // Refinement spec "Buyer-facing copy": the option axes were spelled out here the way the
  // projection models them. The fieldset legend names the one axis this product has, so the label
  // is gone rather than reworded -- and the axis it named is still announced.
  await expect(page.getByText(/Chọn (loại|màu|kích cỡ)( ×|$)/)).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Kích cỡ" }).getByRole("radio", { name: "L" }),
  ).toBeVisible();

  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  const sizeGroup = purchasePanel.getByRole("group", { name: "Kích cỡ" });
  const size = sizeGroup.getByRole("radio", { name: "L" });
  const addToBag = purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true });
  await expect(size).not.toBeChecked();
  await expect(addToBag).toBeEnabled();
  await addToBag.click();
  await expect(purchasePanel.getByText("Vui lòng chọn size", { exact: true })).toBeVisible();
  await expect(sizeGroup).toBeFocused();
  await sizeGroup.getByText("L", { exact: true }).click();
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

test("desktop purchase panel is not sticky and validates size before add-to-cart", async ({ page }) => {
  // Keep a desktop width but enough vertical scroll budget to scroll the panel out of view.
  await page.setViewportSize({ width: 1440, height: 700 });

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

  /*
   * Refinement spec §3: the desktop panel does not follow the scroll any more.
   *
   * It is asserted by behaviour rather than by the computed `position` alone, because a nested
   * sticky treatment inside it would leave the section itself `static` while still pinning the
   * variant controls over the copy beside them: the panel's top moves with the page, by the full
   * distance scrolled.
   */
  expect(await purchasePanel.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  const panelTopBefore = await purchasePanel.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const maxScrollY = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  const scrollBy = Math.min(240, maxScrollY);
  expect(scrollBy).toBeGreaterThan(24);

  await page.evaluate((scrollTop) => window.scrollTo(0, scrollTop), scrollBy);
  await expect
    .poll(async () => {
      const panelTopAfter = await purchasePanel.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      return Math.round(panelTopBefore - panelTopAfter);
    })
    .toBe(Math.round(scrollBy));
  await page.evaluate(() => window.scrollTo(0, 0));

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
  await purchasePanel.getByRole("group", { name: "Màu" }).getByText("Black", { exact: true }).click();
  await purchasePanel
    .getByRole("group", { name: "Kích cỡ" })
    .getByText("M", { exact: true })
    .click();
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
  const soldOutSizeChip = purchasePanel
    .getByRole("group", { name: "Kích cỡ", exact: true })
    .locator("label")
    .filter({ hasText: /^XL$/ })
    .locator("span");
  await expect(soldOutSize).toBeChecked();
  await expect(soldOutSize).toBeDisabled();
  await expect(soldOutSizeChip).toBeVisible();
  expect(
    await soldOutSizeChip.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
    "genuine sold-out option is visibly subdued",
  ).toBeLessThan(1);
  await expect(purchasePanel.getByText("Hết hàng", { exact: true })).toBeVisible();
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeDisabled();
  await expect(purchasePanel.getByRole("button", { name: "Mua ngay", exact: true })).toBeDisabled();
  await assertPageQuality(page);
});


test("F7c mapped size-guide modal uses the exact product mapping and restores focus", async ({ page }) => {
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
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const trigger = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Hướng dẫn chọn size: Áo dài" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-size-guide-id", "ao-dai");
  await expect(dialog.getByRole("button", { name: "Đóng", exact: true })).toBeFocused();

  // The artwork already contains its own title and guidance. Keep that visible surface clean while
  // preserving the sr-only semantic table asserted by expectSizeGuideArtworkFits().
  await expect(dialog.locator("h2:visible")).toHaveCount(0);
  expect(
    await dialog.locator("p").evaluateAll(
      (elements) => elements.filter((element) => element.closest(".sr-only") === null).length,
    ),
    "size-guide prose exists only in the nonvisual semantic fallback",
  ).toBe(0);

  // Removing duplicate visual prose must not make the guidance disappear for screen-reader users.
  // The image is intentionally decorative (alt=""), so these facts stay in the sr-only semantic
  // fallback alongside the data table.
  const semanticOnly = dialog.locator(".sr-only");
  await expect(semanticOnly).toContainText(SIZE_GUIDE.circumferenceSemanticsNote);
  await expect(semanticOnly).toContainText(SIZE_GUIDE.guidanceNote);
  if (SIZE_GUIDE.tolerance !== null) {
    await expect(semanticOnly).toContainText(SIZE_GUIDE.tolerance.note);
  }

  expect(
    await dialog.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth)),
    "size-guide dialog has no framed chrome",
  ).toBe(0);

  for (const viewport of [
    { width: 320, height: 800 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expectSizeGuideArtworkFits(
      page,
      dialog,
      "/brand/size-guides/ao-dai.webp",
      "Áo dài",
      "86",
    );
  }

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      "native modal focus must remain inside the dialog",
    ).toBe(true);
  }

  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    "reverse tabbing must remain inside the dialog",
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await assertPageQuality(page);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("F7c different manual mappings stay product-specific and an unmapped same-category product has no trigger", async ({
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

  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`${BASE_URL}/shop/${sizeOnlyProductSlug}`, { waitUntil: "networkidle" });
  const mappedTrigger = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await mappedTrigger.click();
  const mappedDialog = page.getByRole("dialog", {
    name: "Hướng dẫn chọn size: Set/Váy form rộng",
  });
  await expect(mappedDialog).toBeVisible();
  await expect(mappedDialog).toHaveAttribute("data-size-guide-id", "set-vay-form-rong");
  await expectSizeGuideArtworkFits(
    page,
    mappedDialog,
    "/brand/size-guides/set-vay-form-rong.webp",
    "Set/Váy form rộng",
    "86",
  );
  await page.keyboard.press("Escape");

  await page.goto(`${BASE_URL}/shop/${smallFormProductSlug}`, { waitUntil: "networkidle" });
  const smallFormTrigger = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });
  await smallFormTrigger.click();
  const smallFormDialog = page.getByRole("dialog", {
    name: "Hướng dẫn chọn size: Set/Váy form nhỏ",
  });
  await expect(smallFormDialog).toBeVisible();
  await expect(smallFormDialog).toHaveAttribute("data-size-guide-id", "set-vay-form-nho");
  await expectSizeGuideArtworkFits(
    page,
    smallFormDialog,
    "/brand/size-guides/set-vay-form-nho.webp",
    "Set/Váy form nhỏ",
    "84",
  );
  await page.keyboard.press("Escape");

  await page.goto(`${BASE_URL}/shop/${unmappedProductSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: unmappedProductName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await assertPageQuality(page);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
