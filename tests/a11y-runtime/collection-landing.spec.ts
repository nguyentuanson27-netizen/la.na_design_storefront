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
const PORT = 3214;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_014;
const syncedAt = new Date("2026-08-20T00:00:00.000Z");
const suffix = `${process.pid}`;
const publishedSlug = `runtime-city-${suffix}`;
const pagedSlug = `runtime-paged-${suffix}`;
const draftSlug = `runtime-draft-${suffix}`;
const emptySlug = `runtime-empty-${suffix}`;
const operationalCategoryId = 987_654_321;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js collection server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for collection server\n${serverOutput}`);
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

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { in: [publishedSlug, pagedSlug, draftSlug, emptySlug] } },
  });
}

async function seedProduct(
  key: string,
  name: string,
  collections: string[],
  size: string,
) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `collection-${key}-${suffix}`,
      slug: `collection-${key}-${suffix}`,
      name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: `Editorial ${key}`,
          collectionSlugs: collections,
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `collection-${key}-variant-${suffix}`,
      productId: product.id,
      color: "Ink",
      size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 900_000,
      pancakeRetailPriceAfterDiscount: 900_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `collection-${key}-warehouse-${suffix}`,
      quantity: 2,
      syncedAt,
    },
  });
}

test.beforeAll(async () => {
  await cleanup();
  await prisma.collectionDefinition.createMany({
    data: [
      {
        slug: publishedSlug,
        title: "Runtime City Uniform",
        description: "Visible collection copy for a published editorial landing.",
        seoTitle: "Runtime City Uniform | LA Clothing",
        seoDescription: "Published collection runtime proof.",
        isPublished: true,
        pancakeCategoryIds: [operationalCategoryId],
      },
      {
        slug: pagedSlug,
        title: "Runtime Paged Collection",
        description: "Published collection used to prove filter pagination reset.",
        isPublished: true,
      },
      {
        slug: draftSlug,
        title: "Runtime Draft Collection",
        description: "Draft copy must never become public.",
        isPublished: false,
      },
      {
        slug: emptySlug,
        title: "Runtime Empty Collection",
        description: "A published collection may intentionally be empty.",
        isPublished: true,
      },
    ],
  });
  await seedProduct("zulu", `Zulu Runtime Jacket ${suffix}`, [publishedSlug], "M");
  await seedProduct("alpha", `Alpha Runtime Shirt ${suffix}`, [publishedSlug], "S");
  await seedProduct("outsider", `Outsider Runtime Trouser ${suffix}`, [], "XL");

  for (let index = 1; index <= 25; index += 1) {
    const number = String(index).padStart(2, "0");
    await seedProduct(
      `paged-${number}`,
      `Paged Runtime Product ${number} ${suffix}`,
      [pagedSlug],
      index === 1 ? "S" : "M",
    );
  }

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/collection-landing",
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

test("published collection exposes visible copy and deterministic website-owned membership", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/collections/${publishedSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime City Uniform" })).toBeVisible();
  await expect(page.getByText("Visible collection copy for a published editorial landing.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Bộ sưu tập", exact: true })).toBeVisible();
  // C — rendered check. The brand half comes from Brand Config, not from a literal.
  await expect(
    page.getByText(`${BRAND.identity.name} / Bộ sưu tập`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Khám phá các sản phẩm trong bộ sưu tập này. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.",
      { exact: true },
    ),
  ).toBeVisible();

  const productHeadings = page.locator("article h2");
  await expect(productHeadings).toHaveCount(2);
  expect(await productHeadings.allTextContents()).toEqual([
    `Alpha Runtime Shirt ${suffix}`,
    `Zulu Runtime Jacket ${suffix}`,
  ]);
  await expect(page.getByText(`Outsider Runtime Trouser ${suffix}`)).toHaveCount(0);
  expect((await page.content()).includes(String(operationalCategoryId))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U3 collection controls emit route-local canonical hrefs and ignore forged collection query identity", async ({
  page,
}) => {
  const forgedResponse = await page.goto(
    `${BASE_URL}/collections/${publishedSlug}?collection=${draftSlug}`,
    { waitUntil: "networkidle" },
  );
  expect(forgedResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime City Uniform" })).toBeVisible();
  await expect(page.getByText("Runtime Draft Collection")).toHaveCount(0);

  const sort = page.getByRole("navigation", { name: "Sắp xếp bộ sưu tập" });
  await expect(sort).toBeVisible();
  await expect(sort.getByRole("link", { name: "Tên A–Z", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}`,
  );
  await expect(sort.getByRole("link", { name: "Giá cao → thấp", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?sort=price-desc`,
  );

  const sizes = page.getByRole("navigation", { name: "Lọc theo kích cỡ" });
  await expect(sizes).toBeVisible();
  await expect(sizes.getByRole("link", { name: "S", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?size=S`,
  );
  await expect(sizes.getByRole("link", { name: "M", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?size=M`,
  );
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);

  await page.goto(`${BASE_URL}/collections/${publishedSlug}?size=M&sort=price-desc`, {
    waitUntil: "networkidle",
  });
  const combinedSort = page.getByRole("navigation", { name: "Sắp xếp bộ sưu tập" });
  const combinedSizes = page.getByRole("navigation", { name: "Lọc theo kích cỡ" });
  await expect(combinedSort.getByRole("link", { name: "Tên A–Z", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?size=M`,
  );
  await expect(combinedSizes.getByRole("link", { name: "Tất cả kích cỡ", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?sort=price-desc`,
  );
  await expect(combinedSizes.getByRole("link", { name: "S", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?size=S&sort=price-desc`,
  );
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U3 changing Size from page 2 resets pagination and does not carry a stale page into 404", async ({
  page,
}) => {
  const pageTwo = await page.goto(`${BASE_URL}/collections/${pagedSlug}?page=2`, {
    waitUntil: "networkidle",
  });
  expect(pageTwo?.status()).toBe(200);
  await expect(page.getByText("25 sản phẩm · Trang 2/2", { exact: true })).toBeVisible();

  const sizes = page.getByRole("navigation", { name: "Lọc theo kích cỡ" });
  const small = sizes.getByRole("link", { name: "S", exact: true });
  await expect(small).toHaveAttribute("href", `/collections/${pagedSlug}?size=S`);

  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${pagedSlug}?size=S`),
    small.click(),
  ]);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime Paged Collection" })).toBeVisible();
  await expect(page.getByText("1 sản phẩm · Trang 1/1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: `Paged Runtime Product 01 ${suffix}` })).toBeVisible();
  expect(page.url()).not.toContain("page=");
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);
});

test("draft and unknown collections are not public", async ({ page }) => {
  const draft = await page.goto(`${BASE_URL}/collections/${draftSlug}`, { waitUntil: "networkidle" });
  expect(draft?.status()).toBe(404);
  const unknown = await page.goto(`${BASE_URL}/collections/runtime-unknown-${suffix}`, { waitUntil: "networkidle" });
  expect(unknown?.status()).toBe(404);
});

test("published empty collection renders an intentional empty state", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/collections/${emptySlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime Empty Collection" })).toBeVisible();
  await expect(page.getByText("Bộ sưu tập hiện tại", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Bộ sưu tập này chưa có sản phẩm." })).toBeVisible();
  await expect(
    page.getByText("Sản phẩm sẽ xuất hiện tại đây khi được thêm vào bộ sưu tập.", { exact: true }),
  ).toBeVisible();
});
