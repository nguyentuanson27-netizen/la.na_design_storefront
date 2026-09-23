import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { createProductCommerceAdminService } from "../../src/commerce/product-commerce-admin.ts";
import { createProductCommerceRepository } from "../../src/commerce/product-commerce-repository.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3331;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_012;
const runId = `${Date.now()}-${process.pid}`;
const parentExternalId = `composite-browser-parent-${runId}`;
const parentSlug = `composite-browser-set-${runId}`;
const parentName = `Composite Browser Set ${runId}`;
const parentVariantExternalId = `composite-browser-parent-variant-${runId}`;
const componentExternalId = `composite-browser-component-${runId}`;
const componentSlug = `composite-browser-shirt-${runId}`;
const componentName = `Child Product X ${runId}`;
const componentVariantExternalId = `composite-browser-component-variant-${runId}`;
const pantsName = `Child Product Y ${runId}`;
const skirtName = `Child Product Z ${runId}`;
const malformedName = `Malformed Child Product ${runId}`;
const syncedAt = new Date("2026-08-23T00:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";
let componentProductId = "";
let componentVariantId = "";
let parentVariantId = "";
let pantsVariantId = "";
let skirtVariantId = "";

const activationSecret = "composite-fixture-confirmation-secret-1234";
const commerceRepository = createProductCommerceRepository(prisma);
// The fixtures drive the same generic activation service the admin editor uses, so a regression
// in the real path shows up here instead of in a service nothing ships.
const commerceService = createProductCommerceAdminService({
  setVariantActivation: commerceRepository.setVariantActivation,
  readCatalogEnableWarningState: commerceRepository.readCatalogEnableWarningState,
  commitCatalogEnable: commerceRepository.commitCatalogEnable,
  disableCatalog: commerceRepository.disableCatalog,
  activateProductAndStockedVariants: commerceRepository.activateProductAndStockedVariants,
  readConfirmationSecret: () => activationSecret,
  nowMs: () => Date.now(),
});
const adminSession = {
  user: { id: "composite-browser-admin", role: "ADMIN" },
  session: { id: "composite-browser-session" },
} as const;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js composite storefront server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop/${parentSlug}`, { redirect: "manual" }),
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
        if (text.includes(parentName)) return;
      }
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for composite storefront server\n${serverOutput}`);
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
  const overflowReport = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(overflowReport.documentWidth).toBeLessThanOrEqual(overflowReport.viewportWidth);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

test.beforeAll(async () => {
  await cleanup();

  const parent = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: parentExternalId,
      slug: parentSlug,
      name: parentName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Composite browser regression parent product.",
        },
      },
    },
  });
  const component = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: componentExternalId,
      slug: componentSlug,
      name: componentName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  const pants = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `composite-browser-pants-${runId}`,
      slug: `composite-browser-pants-${runId}`,
      name: pantsName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  const skirt = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `composite-browser-skirt-${runId}`,
      slug: `composite-browser-skirt-${runId}`,
      name: skirtName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  const malformed = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `composite-browser-malformed-${runId}`,
      slug: `composite-browser-malformed-${runId}`,
      name: malformedName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  componentProductId = component.id;

  const parentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: parentVariantExternalId,
      productId: parent.id,
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 790_000,
      pancakeRetailPriceAfterDiscount: 790_000,
      syncedAt,
    },
  });
  parentVariantId = parentVariant.id;
  const componentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: componentVariantExternalId,
      productId: component.id,
      sku: "AO-001",
      color: null,
      size: "M",
      isPresent: true,
      isActive: false,
      pancakeRetailPrice: 390_000,
      pancakeRetailPriceAfterDiscount: 390_000,
      syncedAt,
    },
  });

  const pantsVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `composite-browser-pants-variant-${runId}`,
      productId: pants.id,
      sku: "QUAN-001",
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 420_000,
      pancakeRetailPriceAfterDiscount: 420_000,
      syncedAt,
    },
  });
  const skirtVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `composite-browser-skirt-variant-${runId}`,
      productId: skirt.id,
      sku: "VAY-001",
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 450_000,
      pancakeRetailPriceAfterDiscount: 450_000,
      syncedAt,
    },
  });
  const malformedVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `composite-browser-malformed-variant-${runId}`,
      productId: malformed.id,
      sku: "AO-QUAN-01",
      color: null,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 100_000,
      pancakeRetailPriceAfterDiscount: 100_000,
      syncedAt,
    },
  });

  componentVariantId = componentVariant.id;
  pantsVariantId = pantsVariant.id;
  skirtVariantId = skirtVariant.id;

  await prisma.warehouseStock.createMany({
    data: [
      {
        variantId: parentVariant.id,
        pancakeWarehouseId: `composite-browser-parent-warehouse-${runId}`,
        quantity: 2,
        syncedAt,
      },
      {
        variantId: componentVariant.id,
        pancakeWarehouseId: `composite-browser-component-warehouse-${runId}`,
        quantity: 2,
        syncedAt,
      },
      {
        variantId: pantsVariant.id,
        pancakeWarehouseId: `composite-browser-pants-warehouse-${runId}`,
        quantity: 2,
        syncedAt,
      },
      {
        variantId: skirtVariant.id,
        pancakeWarehouseId: `composite-browser-skirt-warehouse-${runId}`,
        quantity: 2,
        syncedAt,
      },
      {
        variantId: malformedVariant.id,
        pancakeWarehouseId: `composite-browser-malformed-warehouse-${runId}`,
        quantity: 2,
        syncedAt,
      },
    ],
  });
  await prisma.compositeComponentMirror.createMany({
    data: [
      {
        parentVariantId: parentVariant.id,
        componentVariantId: componentVariant.id,
        quantity: 1,
        syncedAt,
      },
      {
        parentVariantId: parentVariant.id,
        componentVariantId: pantsVariant.id,
        quantity: 1,
        syncedAt,
      },
      {
        parentVariantId: parentVariant.id,
        componentVariantId: skirtVariant.id,
        quantity: 1,
        syncedAt,
      },
      {
        parentVariantId: parentVariant.id,
        componentVariantId: malformedVariant.id,
        quantity: 1,
        syncedAt,
      },
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
      NEXT_DIST_DIR: ".next-test/storefront-composite",
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

test("composite activation opens and closes the real child purchase path while parent schema stays authoritative", async ({
  page,
}) => {
  const directComponent = await page.request.get(`${BASE_URL}/shop/${componentSlug}`);
  expect(directComponent.status()).toBe(404);

  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/shop/${parentSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: parentName })).toBeVisible();
  await expect(page.getByRole("group", { name: "Loại" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "FULL SET" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "ÁO LẺ" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "QUẦN LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "CV LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: componentName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: pantsName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: skirtName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: malformedName })).toHaveCount(0);

  expect(
    await commerceService.setVariantActivation(adminSession, componentProductId, {
      variantIds: [componentVariantId],
      isActive: true,
    }),
  ).toEqual({
    ok: true,
    variantIds: [componentVariantId],
    isActive: true,
  });

  const stillPrivateComponent = await page.request.get(`${BASE_URL}/shop/${componentSlug}`);
  expect(stillPrivateComponent.status()).toBe(404);

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("radio", { name: "FULL SET" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "ÁO LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "QUẦN LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "CV LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: componentName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: pantsName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: skirtName })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: malformedName })).toHaveCount(0);
  /*
   * Refinement spec "Variant UX": the exact approved sentence, and an unresolved size row that
   * does not borrow sold-out presentation.
   *
   * The selection authority is unchanged -- these inputs are still `disabled`, and this test still
   * says so. What must not happen is a shopper reading "this size is gone" from a state that only
   * means "you have not chosen a classification yet".
   */
  const sizeGroup = page.getByRole("group", { name: "Kích cỡ" });
  await expect(
    sizeGroup.getByText("Nàng chọn phân loại trước để xem size còn hàng", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeDisabled();

  const unresolvedSize = sizeGroup.getByText("M", { exact: true });
  const unresolvedStyle = await unresolvedSize.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: style.opacity,
      textDecorationLine: style.textDecorationLine,
      borderStyle: style.borderTopStyle,
    };
  });
  expect(unresolvedStyle.opacity, "unresolved is not dimmed like a sold-out option").toBe("1");
  expect(unresolvedStyle.textDecorationLine, "unresolved is not struck through").toBe("none");
  // ...and it carries a state cue that is not colour alone.
  expect(unresolvedStyle.borderStyle).toBe("dashed");
  await expect(sizeGroup.getByText("Hết hàng")).toHaveCount(0);
  await expect(page.getByText("Chọn loại × kích cỡ")).toHaveCount(0);

  // Choosing the classification resolves it: the sentence goes, the sizes become selectable.
  // Click the visible label the way a shopper does; the radio itself is the sr-only peer input.
  const kindGroup = page.getByRole("group", { name: "Loại", exact: true });
  await kindGroup.getByText("FULL SET", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "FULL SET" })).toBeChecked();
  await expect(kindGroup.locator("legend")).toHaveText("Loại: FULL SET");
  await expect(
    page.getByText("Nàng chọn phân loại trước để xem size còn hàng", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeEnabled();

  // Back to the unresolved state the rest of this test drives from.
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByText("Nàng chọn phân loại trước để xem size còn hàng", { exact: true }),
  ).toBeVisible();

  const structuredDocuments = (await page
    .locator('script[type="application/ld+json"]')
    .allTextContents()).map((value) => JSON.parse(value));
  const productNode = structuredDocuments
    .flatMap((document) => document["@graph"] ?? [])
    .find((node) => node["@type"] === "Product");
  expect(productNode).toBeDefined();
  expect(productNode.offers).toEqual({
    "@type": "Offer",
    url: `${BASE_URL}/shop/${parentSlug}`,
    priceCurrency: "VND",
    price: 790_000,
    availability: "https://schema.org/InStock",
  });

  const addToBag = page.getByRole("button", { name: "Thêm vào giỏ hàng" });
  await expect(addToBag).toBeDisabled();

  async function selectAndAdd(kindLabel: string, variantId: string, keepInCart = false) {
    await page.getByText(kindLabel, { exact: true }).click();
    await expect(page.getByRole("radio", { name: kindLabel })).toBeChecked();
    await expect(page.getByRole("group", { name: "Màu" })).toHaveCount(0);
    await page.getByText("M", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "M" })).toBeChecked();
    await expect(addToBag).toBeEnabled();
    await addToBag.click();
    await expect(page.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");
    expect(await prisma.cartItem.count({ where: { variantId } })).toBe(1);
    if (!keepInCart) {
      await prisma.cartItem.deleteMany({ where: { variantId } });
    }
  }

  await selectAndAdd("FULL SET", parentVariantId);
  await selectAndAdd("QUẦN LẺ", pantsVariantId);
  await selectAndAdd("CV LẺ", skirtVariantId);
  await selectAndAdd("ÁO LẺ", componentVariantId, true);
  await assertPageQuality(page);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const cartLine = page.getByRole("article");
  await expect(cartLine.getByRole("heading", { name: componentName })).toBeVisible();
  await expect(page.getByRole("link", { name: componentName })).toHaveCount(0);
  await expect(cartLine.getByText("M", { exact: true })).toBeVisible();
  await expect(cartLine.getByText(/390\.000.*₫/)).toBeVisible();
  await assertPageQuality(page);

  const checkoutLink = page.getByRole("link", { name: "Tiến hành đặt hàng" });
  await expect(checkoutLink).toBeVisible();
  await checkoutLink.click();
  await expect(page).toHaveURL(`${BASE_URL}/checkout`);
  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
  await assertPageQuality(page);

  expect(
    await commerceService.setVariantActivation(adminSession, componentProductId, {
      variantIds: [componentVariantId],
      isActive: false,
    }),
  ).toEqual({
    ok: true,
    variantIds: [componentVariantId],
    isActive: false,
  });

  await page.goto(`${BASE_URL}/shop/${parentSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("radio", { name: "FULL SET" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "ÁO LẺ" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "QUẦN LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "CV LẺ" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: componentName })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeDisabled();

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
