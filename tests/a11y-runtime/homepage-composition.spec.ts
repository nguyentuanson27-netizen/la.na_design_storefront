import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * The homepage editorial refresh (docs/specs/homepage-editorial-refresh.md) as a shopper gets it
 * from the real database rows and the shipped repository config.
 *
 * YOUR NEXT FAVOURITE is DB-owned (`CategoryEditorialMedia`), so it is exercised here in both its
 * complete and fail-closed states. SPECIAL DEALS, the promo rows and the feedback rail depend on
 * owner content the spec leaves pending, so with the shipped config they must be absent -- even
 * though this fixture writes a real `HomepageFeaturedProduct` selection, which proves the manual
 * authority alone cannot publish SPECIAL DEALS without its configured source collection. Their
 * selection, reachability and ordering rules are pinned by `tests/domain/home-route-model.test.ts`.
 *
 * The fixtures write the real rows rather than stubbing the reads, so the section order asserted
 * here is the order a shopper gets.
 */

const HOST = "127.0.0.1";
const PORT = 3318;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_009;
const runId = `${Date.now()}-${process.pid}`;
const IMAGE = (name: string) => `https://content.pancake.vn/1/2/3/4/${name}.jpg`;

const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js F6b server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/`, { redirect: "manual" }),
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
  throw new Error(`Timed out waiting for F6b server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  }
  server = undefined;
}

type OriginalCollectionState = {
  slug: string;
  isPublished: boolean;
  homepagePosition: number | null;
};

let originalCollectionState: OriginalCollectionState[] = [];

/**
 * Park every real published/positioned collection for the duration of this spec.
 *
 * The hero renders from rows this spec does not own. Leaving them in place would make the asserted
 * page depend on whatever collections happen to exist in the shared database.
 */
async function parkCollections() {
  originalCollectionState = await prisma.collectionDefinition.findMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    select: { slug: true, isPublished: true, homepagePosition: true },
  });

  await prisma.collectionDefinition.updateMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    data: { isPublished: false, homepagePosition: null },
  });
}

async function restoreCollections() {
  for (const state of originalCollectionState) {
    await prisma.collectionDefinition.update({
      where: { slug: state.slug },
      data: { isPublished: state.isPublished, homepagePosition: state.homepagePosition },
    });
  }
}

const CATEGORY_KEYS = ["aoDai", "vayDam", "setDo", "phuKien"] as const;

type ParkedCategoryMedia = {
  categoryKey: string;
  heroImageUrl: string | null;
  megaMenuImageUrl: string | null;
};

/** `null` marks a key that had no row, so restoring it means removing the fixture again. */
let parkedCategoryMedia = new Map<string, ParkedCategoryMedia | null>();

/**
 * Park the category media the way the collections above are parked.
 *
 * `CategoryEditorialMedia` is canonical per `categoryKey` and carries `megaMenuImageUrl` as well
 * as the hero, so deleting a row to make room for a fixture destroys configured content this spec
 * never owned. On CI the database is new every run and there is nothing to lose; against a
 * developer's or a staging database it is the real hero and mega-menu images, gone, with the test
 * still reporting green.
 */
async function parkCategoryMedia() {
  const existing = await prisma.categoryEditorialMedia.findMany({
    where: { categoryKey: { in: [...CATEGORY_KEYS] } },
    select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
  });
  parkedCategoryMedia = new Map(CATEGORY_KEYS.map((key) => [key as string, null]));
  for (const row of existing) parkedCategoryMedia.set(row.categoryKey, row);

  for (const categoryKey of CATEGORY_KEYS) {
    await prisma.categoryEditorialMedia.upsert({
      where: { categoryKey },
      update: { heroImageUrl: IMAGE(`editorial-${categoryKey}`) },
      create: { categoryKey, heroImageUrl: IMAGE(`editorial-${categoryKey}`) },
    });
  }
}

/** Puts back what was there, and removes the fixture where there was nothing. */
async function restoreCategoryMedia() {
  for (const [categoryKey, parked] of parkedCategoryMedia) {
    if (parked) {
      await prisma.categoryEditorialMedia.update({
        where: { categoryKey },
        data: {
          heroImageUrl: parked.heroImageUrl,
          megaMenuImageUrl: parked.megaMenuImageUrl,
        },
      });
    } else {
      await prisma.categoryEditorialMedia.deleteMany({ where: { categoryKey } });
    }
  }
  parkedCategoryMedia = new Map();
}

/** Only what this spec created. `SHOP_ID` is its own, so no other fixture's products are in it. */
async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/** One sellable product. */
async function addProduct(index: number, createdAt: Date) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `f6b-product-${index}-${runId}`,
      slug: `f6b-product-${index}-${runId}`,
      name: `F6b Sản phẩm ${index}`,
      primaryImageUrl: IMAGE(`product-${index}`),
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-08-13T00:00:00.000Z"),
      createdAt,
      content: { create: { status: "PUBLISHED", collectionSlugs: [] } },
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `f6b-variant-${index}-${runId}`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_000_000,
      pancakeRetailPriceAfterDiscount: 1_000_000,
      syncedAt: new Date("2026-08-13T00:00:00.000Z"),
    },
  });

  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `f6b-warehouse-${index}-${runId}`,
      quantity: 5,
      syncedAt: new Date("2026-08-13T00:00:00.000Z"),
    },
  });

  return product;
}

const regionOrder = (page: Page) =>
  page
    .locator("[data-homepage-region]")
    .evaluateAll((regions) => regions.map((region) => region.getAttribute("data-homepage-region")));

const RETIRED_REGIONS = [
  "new-arrivals",
  "lead-category",
  "featured",
  "category-editorial",
  "collection-navigation",
  "service",
  "trust-support",
] as const;

test.beforeAll(async () => {
  await cleanup();
  await parkCollections();

  const first = await addProduct(1, new Date("2026-01-01T00:00:00.000Z"));
  await addProduct(2, new Date("2026-05-01T00:00:00.000Z"));
  await addProduct(3, new Date("2026-09-01T00:00:00.000Z"));

  // A real manual selection. With no configured SPECIAL DEALS source collection it must not
  // publish anything -- and the retired Featured grid must not come back to show it.
  await prisma.homepageFeaturedProduct.create({ data: { productId: first.id, position: 1 } });

  await parkCategoryMedia();

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock file
      // there. Every spec drives this one project, so they share that lock unless each gets
      // its own directory -- and a server that has to be SIGKILLed leaves the lock behind,
      // which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/homepage-composition",
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
  await restoreCategoryMedia();
  await restoreCollections();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
});

test("the refreshed homepage renders only real content, and none of the retired sections", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  // Hero absent (no collection hero media); SPECIAL DEALS, both promo rows and the feedback rail
  // absent (pending config); YOUR NEXT FAVOURITE present (all four category images configured).
  expect(await regionOrder(page)).toEqual(["category-discovery"]);
  for (const region of RETIRED_REGIONS) {
    await expect(page.locator(`[data-homepage-region="${region}"]`)).toHaveCount(0);
  }
  await expect(page.getByRole("heading", { level: 2, name: "Hàng mới về" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Sản phẩm nổi bật" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /F6b Sản phẩm/ })).toHaveCount(0);
  await expect(page.locator('a[href="/feedback"]')).toHaveCount(0);
});

test("YOUR NEXT FAVOURITE links the four canonical categories in the approved order", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const section = page.locator('[data-homepage-region="category-discovery"]');
  await expect(section.getByRole("heading", { level: 2, name: "YOUR NEXT FAVOURITE" })).toBeVisible();
  const tiles = section.getByRole("link");
  await expect(tiles).toHaveCount(4);
  expect(await tiles.evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual([
    "/ao-dai",
    "/vay-dam",
    "/set-do",
    "/phu-kien",
  ]);
  for (const [index, name] of ["Áo dài", "Váy, đầm", "Set đồ", "Phụ kiện"].entries()) {
    await expect(tiles.nth(index)).toHaveAccessibleName(name);
    await expect(tiles.nth(index).locator("img")).toHaveCount(1);
  }
});

test("one missing category image closes the whole YOUR NEXT FAVOURITE section, not one tile", async ({
  page,
}) => {
  await prisma.categoryEditorialMedia.update({
    where: { categoryKey: "phuKien" },
    data: { heroImageUrl: null },
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    await expect(page.locator('[data-homepage-region="category-discovery"]')).toHaveCount(0);
    await expect(page.locator(".category-discovery__tile")).toHaveCount(0);
  } finally {
    await prisma.categoryEditorialMedia.update({
      where: { categoryKey: "phuKien" },
      data: { heroImageUrl: IMAGE("editorial-phuKien") },
    });
  }
});

test("an untrusted category image closes the section rather than reaching the page", async ({ page }) => {
  await prisma.categoryEditorialMedia.update({
    where: { categoryKey: "setDo" },
    data: { heroImageUrl: "https://evil.example.com/set-do.jpg" },
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    await expect(page.locator('[data-homepage-region="category-discovery"]')).toHaveCount(0);
    await expect(page.locator('img[src*="evil.example.com"]')).toHaveCount(0);
  } finally {
    await prisma.categoryEditorialMedia.update({
      where: { categoryKey: "setDo" },
      data: { heroImageUrl: IMAGE("editorial-setDo") },
    });
  }
});

test("the refreshed homepage is accessible, keyboard reachable and overflow-free at both widths", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const firstTile = page.locator(".category-discovery__tile").first();
    await firstTile.focus();
    await expect(firstTile).toBeFocused();
  }

  expect(consoleErrors).toEqual([]);
});

test("/feedback is not published while its gallery content is pending", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/feedback`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(404);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});
