import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3311;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_013;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-13T02:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js discovery server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop`, { redirect: "manual" }),
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
  throw new Error(`Timed out waiting for discovery server\n${serverOutput}`);
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
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { in: ["city-uniform", "essentials"] } },
  });
}

async function seedProduct(input: {
  key: string;
  name: string;
  collection: string;
  color: string;
  size: string;
  price: number;
  stock: number;
}) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `discovery-${input.key}-${runId}`,
      slug: `discovery-${input.key}-${runId}`,
      name: input.name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: `Editorial ${input.key}`,
          collectionSlugs: [input.collection],
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `discovery-${input.key}-variant-${runId}`,
      productId: product.id,
      color: input.color,
      size: input.size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: input.price,
      pancakeRetailPriceAfterDiscount: input.price,
      syncedAt,
    },
  });
  if (input.stock > 0) {
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `discovery-${input.key}-warehouse-${runId}`,
        quantity: input.stock,
        syncedAt,
      },
    });
  }
}

test.beforeAll(async () => {
  await cleanup();
  await prisma.collectionDefinition.upsert({
    where: { slug: "city-uniform" },
    create: {
      slug: "city-uniform",
      title: "City Uniform",
      description: "City uniform collection.",
      seoTitle: "City Uniform",
      seoDescription: "City uniform",
      isPublished: true,
      pancakeCategoryIds: [],
    },
    update: { isPublished: true, title: "City Uniform" },
  });
  await prisma.collectionDefinition.upsert({
    where: { slug: "essentials" },
    create: {
      slug: "essentials",
      title: "Essentials",
      description: "Essentials collection.",
      seoTitle: "Essentials",
      seoDescription: "Essentials",
      isPublished: true,
      pancakeCategoryIds: [],
    },
    update: { isPublished: true, title: "Essentials" },
  });
  await seedProduct({
    key: "coat",
    name: `Runtime City Coat ${runId}`,
    collection: "city-uniform",
    color: "Ink",
    size: "M",
    price: 1_200_000,
    stock: 2,
  });
  await seedProduct({
    key: "trouser",
    name: `Runtime Stone Trouser ${runId}`,
    collection: "essentials",
    color: "Stone",
    size: "L",
    price: 700_000,
    stock: 0,
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/discovery",
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

test("mobile shop filters catalog through shareable URL state", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Cửa hàng" })).toBeVisible();

  // Mobile keeps one URL-backed form authority across the always-visible search/sort controls and
  // the drawer-only filters. Scope to the form containing the mobile-only drawer trigger because
  // the desktop form remains in the DOM behind responsive CSS.
  const mobileForm = page
    .locator('form[action="/shop"]')
    .filter({ has: page.getByRole("button", { name: /Bộ lọc/ }) });
  await mobileForm.getByLabel("Tìm sản phẩm").fill("Runtime City Coat");
  await mobileForm.getByRole("combobox", { name: "Sắp xếp", exact: true }).selectOption("price-desc");

  const filterTrigger = mobileForm.getByRole("button", { name: /Bộ lọc/ });
  await filterTrigger.click();

  const filterDialog = page.getByRole("dialog", { name: "Bộ lọc" });
  const closeFilterButton = filterDialog.getByRole("button", { name: "Đóng bộ lọc" });
  await expect(filterDialog).toBeVisible();
  await expect(closeFilterButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);
  await expect(filterTrigger).toBeFocused();

  await filterTrigger.click();
  await expect(filterDialog).toBeVisible();
  await filterDialog.getByRole("combobox", { name: "Bộ sưu tập", exact: true }).selectOption("city-uniform");
  await filterDialog.getByRole("combobox", { name: "Màu sắc", exact: true }).selectOption("Ink");
  await filterDialog.getByRole("combobox", { name: "Kích cỡ", exact: true }).selectOption("M");
  await filterDialog.getByLabel("Giá tối thiểu").fill("1000000");
  await filterDialog.getByLabel("Giá tối đa").fill("1300000");
  await filterDialog.getByLabel("Chỉ còn hàng").check();

  await Promise.all([
    page.waitForURL((next) => next.pathname === "/shop" && next.searchParams.get("q") === "Runtime City Coat"),
    filterDialog.getByRole("button", { name: "Áp dụng", exact: true }).click(),
  ]);
  await page.waitForLoadState("networkidle");

  const url = new URL(page.url());
  expect(url.pathname).toBe("/shop");
  expect(url.searchParams.get("q")).toBe("Runtime City Coat");
  expect(url.searchParams.get("sort")).toBe("price-desc");
  expect(url.searchParams.get("collection")).toBe("city-uniform");
  expect(url.searchParams.get("color")).toBe("Ink");
  expect(url.searchParams.get("size")).toBe("M");
  expect(url.searchParams.get("availability")).toBe("in-stock");
  expect(url.searchParams.get("minPrice")).toBe("1000000");
  expect(url.searchParams.get("maxPrice")).toBe("1300000");

  await expect(page.getByRole("heading", { level: 2, name: `Runtime City Coat ${runId}` })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: `Runtime Stone Trouser ${runId}` })).toHaveCount(0);
  // The count sits above the grid and the page number in the pager; a single page has no pager.
  await expect(mobileForm.getByText("1 sản phẩm", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Phân trang sản phẩm" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Xóa tất cả", exact: true })).toHaveAttribute("href", "/shop");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});
