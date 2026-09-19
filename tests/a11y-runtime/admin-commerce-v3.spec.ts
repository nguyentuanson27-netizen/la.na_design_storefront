import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags.ts";

const HOST = "127.0.0.1";
const PORT = 3212;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_013;

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-commerce-v3-${runId}@example.invalid`;
const password = "admin-commerce-v3-runtime-password-123";
const ordinaryExternalId = `admin-commerce-v3-ordinary-${runId}`;
const ordinarySlug = `admin-commerce-v3-ordinary-${runId}`;
const ordinaryName = `Admin Commerce Ordinary ${runId}`;
const regressionExternalId = `admin-commerce-v3-regression-${runId}`;
const regressionSlug = `admin-commerce-v3-regression-${runId}`;
const regressionName = `Admin Commerce Regression ${runId}`;
const staleExternalId = `admin-commerce-v3-stale-${runId}`;
const staleSlug = `admin-commerce-v3-stale-${runId}`;
const staleName = `Admin Commerce Stale ${runId}`;
const childExternalId = `admin-commerce-v3-child-${runId}`;
const childSlug = `admin-commerce-v3-child-${runId}`;
const childName = `Admin Commerce Child ${runId}`;
const quickStaleExternalId = `admin-commerce-v3-quick-stale-${runId}`;
const quickStaleSlug = `admin-commerce-v3-quick-stale-${runId}`;
const quickStaleName = `Admin Commerce Quick Stale ${runId}`;
const parentExternalId = `admin-commerce-v3-parent-${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let ordinaryProductId = "";
let regressionProductId = "";
let regressionXlVariantId = "";
let staleProductId = "";
let staleVariantId = "";
let childProductId = "";
let quickStaleProductId = "";
let quickStaleVariantId = "";
let parentVariantId = "";
let stockedVariantIds: string[] = [];
let adminCookies: Array<{ name: string; value: string; url: string }> = [];

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Better Auth returned a malformed Set-Cookie header");
    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: BASE_URL,
    };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js a11y server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Next.js a11y server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    once(server, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  if (await waitForServerExit(5_000)) return;
  server.kill("SIGKILL");
  await waitForServerExit(5_000);
}

async function cleanupDatabase() {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.productMirror.deleteMany({
    where: {
      pancakeProductId: {
        in: [
          ordinaryExternalId,
          regressionExternalId,
          staleExternalId,
          childExternalId,
          quickStaleExternalId,
          parentExternalId,
        ],
      },
    },
  });
}

async function resetProductActivation(productId: string, activeVariantIds: string[] = []) {
  await prisma.$transaction([
    prisma.productMirror.update({
      where: { id: productId },
      data: { isActive: false },
    }),
    prisma.variantMirror.updateMany({
      where: { productId },
      data: { isActive: false },
    }),
  ]);
  if (activeVariantIds.length > 0) {
    await prisma.variantMirror.updateMany({
      where: { productId, id: { in: activeVariantIds } },
      data: { isActive: true },
    });
  }
}

async function expectNoPageOverflow(page: Page) {
  const diagnostics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = Array.from(document.querySelectorAll("body *"))
      .flatMap((element) => {
        if (!(element instanceof HTMLElement)) return [];
        const rect = element.getBoundingClientRect();
        if (rect.left >= -1 && rect.right <= viewportWidth + 1) return [];

        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body) {
          const style = getComputedStyle(ancestor);
          const containsHorizontalScroll =
            (style.overflowX === "auto" || style.overflowX === "scroll") &&
            ancestor.scrollWidth > ancestor.clientWidth;
          if (containsHorizontalScroll) return [];
          ancestor = ancestor.parentElement;
        }

        return [
          {
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: element.className,
            ariaLabel: element.getAttribute("aria-label"),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          },
        ];
      })
      .slice(0, 12);

    return {
      viewportWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });

  expect(
    diagnostics.rootScrollWidth,
    `Page-level horizontal overflow: ${JSON.stringify(diagnostics)}`,
  ).toBeLessThanOrEqual(diagnostics.viewportWidth);
}

test.beforeAll(async () => {
  await cleanupDatabase();
  const syncedAt = new Date();

  const ordinary = await prisma.productMirror.create({
    data: {
      pancakeProductId: ordinaryExternalId,
      slug: ordinarySlug,
      name: ordinaryName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  ordinaryProductId = ordinary.id;

  await prisma.variantMirror.createMany({
    data: Array.from({ length: 245 }, (_, index) => ({
      pancakeVariationId: `admin-commerce-v3-ordinary-${runId}-${index + 1}`,
      productId: ordinary.id,
      sku: `ORD-${String(index + 1).padStart(3, "0")}`,
      size: String(index + 1).padStart(3, "0"),
      isPresent: true,
      isActive: false,
      syncedAt,
    })),
  });
  const ordinaryVariants = await prisma.variantMirror.findMany({
    where: { productId: ordinary.id },
    orderBy: [{ color: "asc" }, { size: "asc" }, { id: "asc" }],
    select: { id: true, sku: true },
  });
  stockedVariantIds = ordinaryVariants.slice(240, 243).map((variant) => variant.id);
  await prisma.warehouseStock.createMany({
    data: stockedVariantIds.map((variantId, index) => ({
      variantId,
      pancakeWarehouseId: `admin-commerce-v3-wh-${index + 1}`,
      quantity: index + 1,
      syncedAt,
    })),
  });

  const regression = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: regressionExternalId,
      slug: regressionSlug,
      name: regressionName,
      isPresent: true,
      isActive: false,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Ordinary inactive stocked-variant regression fixture.",
        },
      },
    },
  });
  regressionProductId = regression.id;
  for (const size of ["L", "M", "XL", "XXL"] as const) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `admin-commerce-v3-regression-${runId}-${size}`,
        productId: regression.id,
        sku: `REG-${size}`,
        size,
        isPresent: true,
        isActive: false,
        pancakeRetailPrice: 790_000,
        pancakeRetailPriceAfterDiscount: 790_000,
        syncedAt,
      },
    });
    if (size === "XL") {
      regressionXlVariantId = variant.id;
      await prisma.warehouseStock.create({
        data: {
          variantId: variant.id,
          pancakeWarehouseId: `admin-commerce-v3-regression-wh-${runId}`,
          quantity: 1,
          syncedAt,
        },
      });
    }
  }

  const parent = await prisma.productMirror.create({
    data: {
      pancakeProductId: parentExternalId,
      slug: `admin-commerce-v3-parent-${runId}`,
      name: `Admin Commerce Parent ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  const parentVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-commerce-v3-parent-variant-${runId}`,
      productId: parent.id,
      sku: "PARENT-M",
      size: "M",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  parentVariantId = parentVariant.id;

  const stale = await prisma.productMirror.create({
    data: {
      pancakeProductId: staleExternalId,
      slug: staleSlug,
      name: staleName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  staleProductId = stale.id;
  const staleVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-commerce-v3-stale-variant-${runId}`,
      productId: stale.id,
      sku: "STALE-M",
      size: "M",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  staleVariantId = staleVariant.id;

  const child = await prisma.productMirror.create({
    data: {
      pancakeProductId: childExternalId,
      slug: childSlug,
      name: childName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  childProductId = child.id;
  const childVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-commerce-v3-child-variant-${runId}`,
      productId: child.id,
      sku: "CHILD-L",
      size: "L",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId,
      componentVariantId: childVariant.id,
      quantity: 1,
      syncedAt,
    },
  });

  const quickStale = await prisma.productMirror.create({
    data: {
      pancakeProductId: quickStaleExternalId,
      slug: quickStaleSlug,
      name: quickStaleName,
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  quickStaleProductId = quickStale.id;
  const quickStaleVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `admin-commerce-v3-quick-stale-variant-${runId}`,
      productId: quickStale.id,
      sku: "QUICK-XL",
      size: "XL",
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });
  quickStaleVariantId = quickStaleVariant.id;
  await prisma.warehouseStock.create({
    data: {
      variantId: quickStaleVariant.id,
      pancakeWarehouseId: `admin-commerce-v3-quick-stale-wh-${runId}`,
      quantity: 2,
      syncedAt,
    },
  });

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.31" }),
    body: {
      name: "Admin Commerce V3 Runtime",
      email: adminEmail,
      password,
    },
  });
  adminCookies = cookiesFrom(headers);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/admin-commerce-v3",
      PANCAKE_SHOP_ID: String(SHOP_ID),
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
  await cleanupDatabase();
  await prisma.$disconnect();
});

test("A4 manages bounded selection, stocked selection, bulk on/off and final-page single activation", async ({
  page,
  context,
}) => {
  await resetProductActivation(ordinaryProductId);
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(ordinaryProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 2, name: "Website commerce" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Biến thể website" })).toBeVisible();
  await expect(page.getByText("1–100 / 245", { exact: true })).toBeVisible();

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
  await expectNoPageOverflow(page);

  const selectAll = page.getByRole("checkbox", { name: "Chọn tất cả biến thể trên trang này" });
  const variantSuccessStatus = page
    .getByRole("status")
    .filter({ hasText: "Đã cập nhật trạng thái biến thể website." });
  await page.getByRole("checkbox", { name: "Chọn biến thể ORD-001" }).check();
  await expect(page.getByText("Đã chọn 1 biến thể", { exact: true })).toBeVisible();
  expect(
    await selectAll.evaluate((element) => (element as HTMLInputElement).indeterminate),
  ).toBe(true);

  await selectAll.check();
  await expect(page.getByText("Đã chọn 100 biến thể", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Kích hoạt đã chọn" }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("variantSaved") === "1",
  );
  await expect(variantSuccessStatus).toBeFocused();
  expect(
    await prisma.variantMirror.count({ where: { productId: ordinaryProductId, isActive: true } }),
  ).toBe(100);

  await page.getByRole("checkbox", { name: "Chọn tất cả biến thể trên trang này" }).check();
  await page.getByRole("button", { name: "Tắt đã chọn" }).click();
  await expect(variantSuccessStatus).toBeFocused();
  await expect
    .poll(() =>
      prisma.variantMirror.count({ where: { productId: ordinaryProductId, isActive: true } }),
    )
    .toBe(0);
  await expect(page.getByText(/Đã chọn \d+ biến thể/)).toHaveCount(0);

  await page.getByRole("button", { name: "Trang biến thể tiếp theo" }).click();
  await expect(page.getByText("101–200 / 245", { exact: true })).toBeVisible();
  await expect(page.getByText(/Đã chọn \d+ biến thể/)).toHaveCount(0);
  await page.getByRole("button", { name: "Trang biến thể tiếp theo" }).click();
  await expect(page.getByText("201–245 / 245", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Chọn biến thể có hàng" }).click();
  await expect(page.getByText("Đã chọn 3 biến thể", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Chọn biến thể ORD-241" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Chọn biến thể ORD-242" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Chọn biến thể ORD-243" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Chọn biến thể ORD-244" })).not.toBeChecked();
  await page.getByRole("button", { name: "Bỏ chọn" }).click();

  await page.getByRole("button", { name: "Kích hoạt biến thể ORD-245" }).click();
  await expect(variantSuccessStatus).toBeFocused();
  await expect
    .poll(async () =>
      (
        await prisma.variantMirror.findFirstOrThrow({
          where: { productId: ordinaryProductId, sku: "ORD-245" },
          select: { isActive: true },
        })
      ).isActive,
    )
    .toBe(true);
});

test("A4 ordinary inactive stocked XL can be activated without publishing the product", async ({
  page,
  context,
}) => {
  await resetProductActivation(regressionProductId);
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(regressionProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 2, name: "Website commerce" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Biến thể website" })).toBeVisible();
  const websiteVariantTable = page.locator(
    '[aria-label="Bảng biến thể website, cuộn ngang khi cần"]',
  );
  const xlRow = websiteVariantTable.getByRole("row").filter({ hasText: "REG-XL" });
  await expect(xlRow.getByRole("cell", { name: "1", exact: true })).toBeVisible();
  await xlRow.getByRole("button", { name: "Kích hoạt biến thể REG-XL" }).click();
  await page.waitForURL(
    (url) => url.pathname === editorPath && url.searchParams.get("variantSaved") === "1",
  );

  const state = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: regressionXlVariantId },
    select: { isActive: true, product: { select: { isActive: true } } },
  });
  expect(state).toEqual({ isActive: true, product: { isActive: false } });
});

test("A5 ordinary quick action publishes stocked variants and storefront converges under existing guards", async ({
  page,
  context,
}) => {
  await resetProductActivation(regressionProductId);
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(regressionProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Bật sản phẩm + kích hoạt biến thể có hàng" }).click();
  await expect(page.getByText(/1 biến thể có hàng/)).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận bật sản phẩm và biến thể có hàng" }).click();
  const success = page
    .getByRole("status")
    .filter({ hasText: "Đã bật sản phẩm và kích hoạt 1 biến thể có hàng." });
  await expect(success).toBeVisible();
  await expect(success).toBeFocused();

  await page.goto(`${BASE_URL}/shop/${regressionSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: regressionName })).toBeVisible();
  const xl = page.getByRole("radio", { name: "XL" });
  await expect(xl).toBeVisible();
  await page.getByText("XL", { exact: true }).click();
  await expect(xl).toBeChecked();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();
});

test("A5 initial composite child catalog enable warns about standalone publication before writes", async ({
  page,
  context,
}) => {
  await prisma.productMirror.update({ where: { id: childProductId }, data: { isActive: false } });
  await prisma.variantMirror.updateMany({
    where: { productId: childProductId },
    data: { isActive: true },
  });
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(childProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(
    page.getByRole("button", { name: "Bật sản phẩm + kích hoạt biến thể có hàng" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Bật catalog" }).click();
  await expect(page.getByText(/thành phần của set\/composite/)).toBeVisible();
  await expect(page.getByText(/mở catalog riêng/)).toBeVisible();
  expect(
    (
      await prisma.productMirror.findUniqueOrThrow({
        where: { id: childProductId },
        select: { isActive: true },
      })
    ).isActive,
  ).toBe(false);
});

test("A5 stale catalog confirmation reconfirms current composite publication risk with zero writes", async ({
  page,
  context,
}) => {
  await prisma.productMirror.update({ where: { id: staleProductId }, data: { isActive: false } });
  await prisma.variantMirror.updateMany({
    where: { productId: staleProductId },
    data: { isActive: true },
  });
  await prisma.compositeComponentMirror.deleteMany({
    where: { parentVariantId, componentVariantId: staleVariantId },
  });
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(staleProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("button", { name: "Bật sản phẩm + kích hoạt biến thể có hàng" })).toBeVisible();
  await page.getByRole("button", { name: "Bật catalog" }).click();
  await expect(page.getByText("Bật catalog không tự kích hoạt biến thể.", { exact: true })).toBeVisible();
  await expect(page.getByText(/thành phần của set\/composite/)).toHaveCount(0);

  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId,
      componentVariantId: staleVariantId,
      quantity: 1,
      syncedAt: new Date(),
    },
  });

  await page.getByRole("button", { name: "Xác nhận bật catalog" }).click();
  const reconfirm = page
    .getByRole("status")
    .filter({ hasText: "Trạng thái cảnh báo đã thay đổi. Vui lòng xác nhận lại." });
  await expect(reconfirm).toBeVisible();
  await expect(reconfirm).toBeFocused();
  await expect(page.getByText(/thành phần của set\/composite/)).toBeVisible();
  expect(
    (
      await prisma.productMirror.findUniqueOrThrow({
        where: { id: staleProductId },
        select: { isActive: true },
      })
    ).isActive,
  ).toBe(false);

  await page.getByRole("button", { name: "Xác nhận bật catalog" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã bật catalog." })).toBeFocused();
  expect(
    (
      await prisma.productMirror.findUniqueOrThrow({
        where: { id: staleProductId },
        select: { isActive: true },
      })
    ).isActive,
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Bật sản phẩm + kích hoạt biến thể có hàng" }),
  ).toHaveCount(0);
});

test("A5 quick action rendered ordinary fails closed if product becomes composite child before submit", async ({
  page,
  context,
}) => {
  await resetProductActivation(quickStaleProductId);
  await prisma.compositeComponentMirror.deleteMany({
    where: { parentVariantId, componentVariantId: quickStaleVariantId },
  });
  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(quickStaleProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Bật sản phẩm + kích hoạt biến thể có hàng" }).click();
  await expect(page.getByText(/1 biến thể có hàng/)).toBeVisible();

  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId,
      componentVariantId: quickStaleVariantId,
      quantity: 1,
      syncedAt: new Date(),
    },
  });

  await page.getByRole("button", { name: "Xác nhận bật sản phẩm và biến thể có hàng" }).click();
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Sản phẩm hiện là thành phần của set/composite" });
  await expect(error).toBeVisible();
  await expect(error).toBeFocused();

  const state = await prisma.productMirror.findUniqueOrThrow({
    where: { id: quickStaleProductId },
    select: {
      isActive: true,
      variants: { where: { id: quickStaleVariantId }, select: { isActive: true } },
    },
  });
  expect(state).toEqual({ isActive: false, variants: [{ isActive: false }] });
});

test("A5 catalog enable and disable remain independent from variant activation", async ({
  page,
  context,
}) => {
  await resetProductActivation(ordinaryProductId, [stockedVariantIds[0]]);
  expect(
    await prisma.variantMirror.count({ where: { productId: ordinaryProductId, isActive: true } }),
  ).toBe(1);

  await context.addCookies(adminCookies);
  const editorPath = `/admin/products/${encodeURIComponent(ordinaryProductId)}`;
  await page.goto(`${BASE_URL}${editorPath}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Bật catalog" }).click();
  await expect(page.getByText("Bật catalog không tự kích hoạt biến thể.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận bật catalog" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã bật catalog." })).toBeFocused();
  expect(
    await prisma.variantMirror.count({ where: { productId: ordinaryProductId, isActive: true } }),
  ).toBe(1);

  await page.getByRole("button", { name: "Tắt catalog" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã tắt catalog." })).toBeFocused();
  expect(
    await prisma.variantMirror.count({ where: { productId: ordinaryProductId, isActive: true } }),
  ).toBe(1);
});
