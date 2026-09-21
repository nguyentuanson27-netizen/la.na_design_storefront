import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

/**
 * F6b — the homepage in the fixed order master spec §16 approves, with every content-dependent
 * block present.
 *
 * `editorial.spec.ts` covers the absent half: with no category media and no manual Featured
 * selection, those blocks omit themselves. This spec covers the other half, because "renders when
 * the admin has configured it" and "omits itself when they have not" are different failures and a
 * page that never renders a block passes the absence test perfectly.
 *
 * The fixtures write the real rows -- `CategoryEditorialMedia`, `HomepageFeaturedProduct` -- rather
 * than stubbing the reads, so the section order asserted here is the order a shopper gets.
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
 * The collection rail is not one of the sections §16 orders, and it renders from rows this spec
 * does not own. Leaving them in place would make the asserted section order depend on whatever
 * collections happen to exist in the shared database.
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

const CATEGORY_KEYS = ["aoDai", "setDo", "vayDam"] as const;

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

/**
 * One sellable product, with `createdAt` set explicitly so the `Hàng mới về` ordering has something
 * to be right or wrong about rather than depending on insertion timing.
 */
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

test.beforeAll(async () => {
  await cleanup();
  await parkCollections();

  // Deliberately inserted oldest-first, so a page that simply echoed insertion order would fail.
  const oldest = await addProduct(1, new Date("2026-01-01T00:00:00.000Z"));
  await addProduct(2, new Date("2026-05-01T00:00:00.000Z"));
  await addProduct(3, new Date("2026-09-01T00:00:00.000Z"));

  // §20: Featured is a manual, admin-ordered selection. Pinning the *oldest* product proves the
  // section is read from this table rather than sharing the new-arrivals read.
  await prisma.homepageFeaturedProduct.create({ data: { productId: oldest.id, position: 1 } });

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

test("F6b renders every approved section in the master spec §16 order", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  // No collection publishes hero media or a homepage position here, so the hero and the collection
  // rail are absent; everything §16 lists that has content is present, in order.
  expect(await regionOrder(page)).toEqual([
    "new-arrivals",
    "lead-category",
    "featured",
    "category-editorial",
    "service",
    "trust-support",
  ]);
});

test("F6b Hàng mới về is ordered by recency, not by name or insertion order", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const grid = page.locator('[data-homepage-region="new-arrivals"]');
  await expect(grid.getByRole("heading", { level: 2, name: "Hàng mới về" })).toBeVisible();

  // Read the slug rather than the card's text: the card renders name and price in one link, so
  // matching on text would assert about formatting instead of about order.
  const hrefs = await grid
    .getByRole("link")
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => href.includes("/shop/f6b-product-")),
    );
  const ordered = hrefs.map((href) => href.split("/shop/f6b-product-")[1]?.split("-")[0]);
  expect(ordered).toEqual(["3", "2", "1"]);
});

test("F6b Featured renders the manual selection, not a repeat of new arrivals", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const featured = page.locator('[data-homepage-region="featured"]');
  await expect(featured.getByRole("heading", { level: 2, name: "Sản phẩm nổi bật" })).toBeVisible();

  // Exactly the one pinned product -- the oldest, which new arrivals lists last.
  await expect(featured.getByRole("link", { name: /F6b Sản phẩm/ })).toHaveCount(1);
  await expect(featured.getByRole("link", { name: /F6b Sản phẩm 1/ })).toBeVisible();
});

test("F6b the Áo dài section links to all five subcategories", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const aoDai = page.locator('[data-homepage-region="lead-category"]');
  await expect(aoDai.getByRole("heading", { level: 2, name: "Áo dài La.na Design" })).toBeVisible();
  await expect(aoDai.locator("img")).toBeVisible();

  const hrefs = await aoDai
    .getByRole("navigation", { name: "Áo dài" })
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));

  expect(hrefs).toEqual([
    "/ao-dai/cach-tan",
    "/ao-dai/tet",
    "/ao-dai/cuoi",
    "/ao-dai/4-ta",
    "/ao-dai/6-ta",
  ]);
});

test("F6b the category editorial is exactly Set đồ and Váy, đầm, labelled by category name", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const editorial = page.locator('[data-homepage-region="category-editorial"]');
  const blocks = editorial.locator(".category-editorial__block");
  await expect(blocks).toHaveCount(2);

  await expect(blocks.nth(0)).toHaveAttribute("href", "/set-do");
  await expect(blocks.nth(0)).toContainText("Set đồ");
  await expect(blocks.nth(1)).toHaveAttribute("href", "/vay-dam");
  await expect(blocks.nth(1)).toContainText("Váy, đầm");

  // §21: Phụ kiện is not part of this section.
  await expect(editorial.locator('a[href="/phu-kien"]')).toHaveCount(0);
});

test("F6b one missing category image closes the whole editorial section, not half of it", async ({
  page,
}) => {
  // §21 fixes this section at exactly two blocks, and no placeholder may stand in for a missing
  // one. So a single half-width block is not a degraded state to allow -- it is a layout nobody
  // approved. Removing either image must remove the section.
  await prisma.categoryEditorialMedia.deleteMany({ where: { categoryKey: "vayDam" } });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    await expect(page.locator('[data-homepage-region="category-editorial"]')).toHaveCount(0);
    await expect(page.locator(".category-editorial__block")).toHaveCount(0);

    // The rest of the page is untouched: only this section is fail-closed.
    await expect(page.locator('[data-homepage-region="new-arrivals"]')).toHaveCount(1);
  } finally {
    await prisma.categoryEditorialMedia.create({
      data: { categoryKey: "vayDam", heroImageUrl: IMAGE("editorial-vayDam") },
    });
  }
});

test("F6b an untrusted category image closes the section rather than reaching the page", async ({
  page,
}) => {
  await prisma.categoryEditorialMedia.update({
    where: { categoryKey: "setDo" },
    data: { heroImageUrl: "https://evil.example.com/set-do.jpg" },
  });

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    await expect(page.locator('[data-homepage-region="category-editorial"]')).toHaveCount(0);
    await expect(page.locator('img[src*="evil.example.com"]')).toHaveCount(0);
  } finally {
    await prisma.categoryEditorialMedia.update({
      where: { categoryKey: "setDo" },
      data: { heroImageUrl: IMAGE("editorial-setDo") },
    });
  }
});
