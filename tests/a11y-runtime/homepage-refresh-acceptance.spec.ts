import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * Positive browser acceptance for the homepage editorial refresh
 * (docs/specs/homepage-editorial-refresh.md §7): every new section rendered from real rows and a
 * complete config, at both representative widths.
 *
 * The shipped `HOMEPAGE_CONFIG` keeps the owner's pending content `null`, so no other fixture can
 * render SPECIAL DEALS, the promo rows or the feedback rail. This spec therefore installs a fixture
 * `HOMEPAGE_CONFIG` -- test-only, clearly marked -- before its own dev server starts, and restores
 * the original file afterwards (and on process exit). There is no production seam for it: the page
 * reads exactly the module it always reads.
 */

const HOST = "127.0.0.1";
const PORT = 3336;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const CONFIG_PATH = resolve(APP_ROOT, "src/content/homepage.config.ts");
const FIXTURE_MARKER = "// HOMEPAGE_REFRESH_ACCEPTANCE_FIXTURE — test-only, restored by the spec";
const SHOP_ID = 920_036;
const runId = `${Date.now()}-${process.pid}`;
const PREFIX = "refresh-acceptance-";
const IMAGE = (name: string) => `https://content.pancake.vn/1/2/3/4/refresh-${name}.jpg`;

const SOURCE = `${PREFIX}source`;
const PROMOS = [`${PREFIX}a1`, `${PREFIX}a2`, `${PREFIX}b1`, `${PREFIX}b2`] as const;
const PROMO_TITLES: Record<string, string> = {
  [PROMOS[0]]: "Acceptance Hè",
  [PROMOS[1]]: "Acceptance Tết",
  [PROMOS[2]]: "Acceptance Tiệc",
  [PROMOS[3]]: "Acceptance Công sở",
};
const FEEDBACK_ALTS = Array.from({ length: 8 }, (_, index) => `Acceptance feedback ${index + 1}`);
/**
 * Natural sizes for the eight fixture photographs: tall full-body, 3:4, square and landscape, as
 * the shipped feedback set mixes them. The `/feedback` gallery is an uncropped masonry, so each
 * box must take exactly its own photograph's ratio.
 */
const FEEDBACK_SIZES = [
  { width: 1366, height: 2048 },
  { width: 1200, height: 2134 },
  { width: 1080, height: 1080 },
  { width: 1600, height: 1200 },
  { width: 960, height: 1280 },
  { width: 1080, height: 1350 },
  { width: 1200, height: 800 },
  { width: 858, height: 1280 },
] as const;

const MOBILE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/* ------------------------------------------------------------- fixture config */

let originalConfig: string | null = null;

function restoreConfig() {
  if (originalConfig !== null) {
    writeFileSync(CONFIG_PATH, originalConfig);
    originalConfig = null;
  }
}

/** Replaces only the exported value; the types above it stay the real, shipped contract. */
function installFixtureConfig() {
  const source = readFileSync(CONFIG_PATH, "utf8");
  if (source.includes(FIXTURE_MARKER)) {
    throw new Error(
      "src/content/homepage.config.ts still holds a previous acceptance fixture; restore it with git before running",
    );
  }
  const start = source.indexOf("export const HOMEPAGE_CONFIG: HomepageConfig = {");
  if (start === -1) throw new Error("HOMEPAGE_CONFIG export not found");

  originalConfig = source;
  process.once("exit", restoreConfig);

  const slot = (collectionSlug: string, image: string) =>
    `{ collectionSlug: "${collectionSlug}", imageSrc: "${IMAGE(image)}", ctaLabel: "Khám phá" }`;
  const fixture = `${FIXTURE_MARKER}
export const HOMEPAGE_CONFIG: HomepageConfig = {
  specialDeals: {
    supportingCopy: null,
    sourceCollectionSlug: "${SOURCE}",
    ctaLabel: "Xem thêm",
  },
  promoRows: [
    [${slot(PROMOS[0], "promo-a1")}, ${slot(PROMOS[1], "promo-a2")}],
    [${slot(PROMOS[2], "promo-b1")}, ${slot(PROMOS[3], "promo-b2")}],
  ],
  categoryDiscovery: {
    title: "YOUR NEXT FAVOURITE",
    description: null,
  },
  feedback: {
    title: "Acceptance feedback",
    ctaLabel: "Xem thêm",
    metadataTitle: "Acceptance feedback title",
    metadataDescription: "Acceptance feedback description.",
    images: [
${FEEDBACK_ALTS.map(
  (alt, index) =>
    `      { src: "${IMAGE(`feedback-${index + 1}`)}", alt: "${alt}", width: ${FEEDBACK_SIZES[index]!.width}, height: ${FEEDBACK_SIZES[index]!.height} },`,
).join("\n")}
    ],
  },
};
`;
  writeFileSync(CONFIG_PATH, `${source.slice(0, start)}${fixture}`);
}

/* ---------------------------------------------------------------- server */

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js refresh-acceptance server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      // See homepage-composition.spec.ts: wait for the auth route the page hydrates against too.
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for refresh-acceptance server\n${serverOutput}`);
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

/* -------------------------------------------------------------- database */

type ParkedCollection = { slug: string; isPublished: boolean; homepagePosition: number | null };
let parkedCollections: ParkedCollection[] = [];

/** The hero renders from published, positioned collections this spec does not own. */
async function parkCollections() {
  parkedCollections = await prisma.collectionDefinition.findMany({
    where: {
      OR: [{ isPublished: true }, { homepagePosition: { not: null } }],
      NOT: { slug: { startsWith: PREFIX } },
    },
    select: { slug: true, isPublished: true, homepagePosition: true },
  });
  await prisma.collectionDefinition.updateMany({
    where: { slug: { in: parkedCollections.map((collection) => collection.slug) } },
    data: { isPublished: false, homepagePosition: null },
  });
}

async function restoreCollections() {
  for (const parked of parkedCollections) {
    await prisma.collectionDefinition.update({
      where: { slug: parked.slug },
      data: { isPublished: parked.isPublished, homepagePosition: parked.homepagePosition },
    });
  }
}

const CATEGORY_KEYS = ["aoDai", "vayDam", "setDo", "phuKien"] as const;
type ParkedCategoryMedia = { categoryKey: string; heroImageUrl: string | null; megaMenuImageUrl: string | null };
let parkedCategoryMedia = new Map<string, ParkedCategoryMedia | null>();

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
      update: { heroImageUrl: IMAGE(`category-${categoryKey}`) },
      create: { categoryKey, heroImageUrl: IMAGE(`category-${categoryKey}`) },
    });
  }
}

async function restoreCategoryMedia() {
  for (const [categoryKey, parked] of parkedCategoryMedia) {
    if (parked) {
      await prisma.categoryEditorialMedia.update({
        where: { categoryKey },
        data: { heroImageUrl: parked.heroImageUrl, megaMenuImageUrl: parked.megaMenuImageUrl },
      });
    } else {
      await prisma.categoryEditorialMedia.deleteMany({ where: { categoryKey } });
    }
  }
  parkedCategoryMedia = new Map();
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}

/** Six members of the source collection, named so the listing's name order is p1..p6. */
async function addProduct(index: number) {
  const slug = `${PREFIX}p${index}-${runId}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: slug,
      slug,
      name: `Acceptance Sản phẩm ${index}`,
      primaryImageUrl: IMAGE(`product-${index}`),
      isPresent: true,
      isActive: true,
      syncedAt: new Date("2026-09-20T00:00:00.000Z"),
      content: { create: { status: "PUBLISHED", collectionSlugs: [SOURCE] } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Kem",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt: new Date("2026-09-20T00:00:00.000Z"),
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${slug}-warehouse`,
      quantity: 5,
      syncedAt: new Date("2026-09-20T00:00:00.000Z"),
    },
  });
  return slug;
}

let productSlugs: string[] = [];

/* ----------------------------------------------------------------- hooks */

test.beforeAll(async () => {
  await cleanup();
  await parkCollections();
  productSlugs = [];
  for (let index = 1; index <= 6; index += 1) productSlugs.push(await addProduct(index));

  for (const [slug, title] of [[SOURCE, "Acceptance nguồn"], ...Object.entries(PROMO_TITLES)] as const) {
    await prisma.collectionDefinition.create({
      data: {
        slug,
        title,
        description: `${title} — mô tả bộ sưu tập kiểm thử.`,
        isPublished: true,
        pancakeCategoryIds: [],
        // The collection page pins p5 within its first page; SPECIAL DEALS must do the same.
        featuredProductSlugs: slug === SOURCE ? [productSlugs[4]!] : [],
        // One collection carries hero media, so the unchanged hero renders above the refresh.
        ...(slug === PROMOS[0] ? { heroImageUrl: IMAGE("hero"), homepagePosition: 1 } : {}),
      },
    });
  }
  await parkCategoryMedia();

  installFixtureConfig();

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Own build directory: Next 16 dev locks one server per directory (see the other specs).
      NEXT_DIST_DIR: ".next-test/homepage-refresh-acceptance",
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
  restoreConfig();
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

/* ----------------------------------------------------------------- helpers */

const regionOrder = (page: Page) =>
  page
    .locator("[data-homepage-region]")
    .evaluateAll((regions) => regions.map((region) => region.getAttribute("data-homepage-region")));

/** Distinct rounded row tops of a set of elements, in DOM order. */
const tops = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));

/**
 * Serve each fixture feedback photograph at its own natural ratio, so the browser's intrinsic size
 * -- not only the width/height attributes -- is what the layout has to honour. Registered after the
 * `beforeEach` stub, so it takes precedence for the requests it answers.
 */
const serveFeedbackAtNaturalSize = (page: Page) =>
  page.route("**/_next/image**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("url") ?? "";
    const index = Number(/refresh-feedback-(\d+)\.jpg/.exec(source)?.[1] ?? 0) - 1;
    const size = FEEDBACK_SIZES[index];
    if (!size) {
      route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#d4c7b8"/></svg>`,
    });
  });

/**
 * CTA names carry the destination in visually hidden text; Chromium's accessible-name computation
 * separates that out-of-flow span with a space, so names are matched whitespace-tolerantly.
 */

/** The href of the anchor, if any, under a viewport point. */
const anchorAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href") ?? null,
    { x, y },
  );

/* ------------------------------------------------------------------- tests */

test("the unchanged hero is followed by every refreshed section in the approved order", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toBeVisible();
  expect(await regionOrder(page)).toEqual([
    "special-deals",
    "promo-a",
    "category-discovery",
    "promo-b",
    "feedback",
  ]);
  const heroBeforeSections = await page.evaluate(() => {
    const hero = document.querySelector('[aria-label="Ảnh bìa trang chủ"]');
    const first = document.querySelector("[data-homepage-region]");
    return Boolean(hero && first && hero.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(heroBeforeSections).toBe(true);
});

test("SPECIAL DEALS shows exactly the collection page's first four, 4-across on desktop and 2 × 2 on mobile", async ({
  page,
}) => {
  const cards = '[data-homepage-region="special-deals"] .product-grid > article';

  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const section = page.locator('[data-homepage-region="special-deals"]');
  await expect(section.getByRole("heading", { level: 2, name: "SPECIAL DEALS" })).toBeVisible();
  await expect(page.locator(cards)).toHaveCount(4);

  // The pinned p5 leads, then the listing's own name order -- exactly what /collections/<slug> shows.
  const hrefs = await page
    .locator(`${cards} a[href^="/shop/"]`)
    .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href")))]);
  const expected = [4, 0, 1, 2].map((index) => `/shop/${productSlugs[index]}`);
  expect(hrefs).toEqual(expected);

  const desktopTops = await tops(page, cards);
  expect(new Set(desktopTops).size).toBe(1);

  const more = section.getByRole("link", { name: /^Xem thêm\s*: Acceptance nguồn$/ });
  await expect(more).toHaveAttribute("href", `/collections/${SOURCE}`);

  await page.setViewportSize(MOBILE);
  const mobileTops = await tops(page, cards);
  expect(mobileTops[0]).toBe(mobileTops[1]);
  expect(mobileTops[2]).toBe(mobileTops[3]);
  expect(mobileTops[2]!).toBeGreaterThan(mobileTops[0]!);

  await page.goto(`${BASE_URL}/collections/${SOURCE}`, { waitUntil: "networkidle" });
  const collectionFirstFour = await page
    .locator('main a[href^="/shop/"]')
    .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href")))].slice(0, 4));
  expect(collectionFirstFour).toEqual(expected);
});

test("promo tiles: desktop only the CTA is clickable; the image area is not a link", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  for (const region of ["promo-a", "promo-b"] as const) {
    const tiles = page.locator(`[data-homepage-region="${region}"] .collection-promo`);
    await expect(tiles).toHaveCount(2);
    for (const index of [0, 1]) {
      const tile = tiles.nth(index);
      await tile.scrollIntoViewIfNeeded();
      await expect(tile.locator("a")).toHaveCount(1);
      await expect(tile.locator("a a")).toHaveCount(0);

      const title = (await tile.getByRole("heading", { level: 2 }).textContent())!;
      expect(Object.values(PROMO_TITLES)).toContain(title);
      const cta = tile.getByRole("link", { name: new RegExp(`^Khám phá\\s*: ${title}$`) });
      const href = await cta.getAttribute("href");

      const tileBox = (await tile.boundingBox())!;
      const ctaBox = (await cta.boundingBox())!;
      expect(await anchorAt(page, tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height * 0.3)).toBeNull();
      expect(await anchorAt(page, ctaBox.x + ctaBox.width / 2, ctaBox.y + ctaBox.height / 2)).toBe(href);
    }
  }

  // A real click on the photograph stays on the homepage.
  const first = page.locator('[data-homepage-region="promo-a"] .collection-promo').first();
  const box = (await first.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.3);
  await delay(500);
  expect(new URL(page.url()).pathname).toBe("/");

  // Full-bleed 50/50: the row reaches both viewport edges.
  const edges = await page
    .locator('[data-homepage-region="promo-a"] .collection-promo')
    .evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect()).map((rect) => [rect.left, rect.right]));
  expect(Math.round(edges[0]![0]!)).toBe(0);
  expect(Math.abs(edges[1]![1]! - DESKTOP.width)).toBeLessThanOrEqual(1);
});

test("promo tiles: on mobile the whole tile taps through to the same collection as its CTA", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const tiles = page.locator(".collection-promo");
  await expect(tiles).toHaveCount(4);
  for (const index of [0, 1, 2, 3]) {
    const tile = tiles.nth(index);
    await tile.scrollIntoViewIfNeeded();
    const href = await tile.locator(".collection-promo__cta").getAttribute("href");
    const box = (await tile.boundingBox())!;
    expect(await anchorAt(page, box.x + box.width / 2, box.y + box.height * 0.3)).toBe(href);
    await expect(tile.locator("a")).toHaveCount(1);
  }

  const tile = page.locator('[data-homepage-region="promo-b"] .collection-promo').first();
  await tile.scrollIntoViewIfNeeded();
  const box = (await tile.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.3);
  await page.waitForURL(`**/collections/${PROMOS[2]}`);
  await expect(page.getByRole("heading", { level: 1, name: PROMO_TITLES[PROMOS[2]] })).toBeVisible();
});

test("the feedback rail scrolls horizontally, is keyboard operable and leads to the full gallery", async ({
  page,
}) => {
  for (const viewport of [MOBILE, DESKTOP]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const section = page.locator('[data-homepage-region="feedback"]');
    await expect(section.getByRole("heading", { level: 2, name: "Acceptance feedback" })).toBeVisible();
    // The title is a heading, not a link; the photographs are images only.
    await expect(section.locator("h2 a, a h2")).toHaveCount(0);
    expect(await section.locator(".feedback-rail__item img").evaluateAll((images) =>
      images.map((image) => image.getAttribute("alt")),
    )).toEqual(FEEDBACK_ALTS);
    await expect(section.locator(".feedback-rail__track a")).toHaveCount(0);

    const rail = section.getByRole("group", { name: "Acceptance feedback" });
    const metrics = await rail.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    // Reached by Tab from the SPECIAL DEALS/promo links before it, and scrolled by the arrow keys.
    await section.getByRole("heading", { level: 2 }).scrollIntoViewIfNeeded();
    await rail.focus();
    await expect(rail).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    // Every photograph is a zoom button in order, and the one after the last is `Xem thêm`.
    const zoomButtons = section.locator(".feedback-rail__item button.feedback-zoom");
    await expect(zoomButtons).toHaveCount(FEEDBACK_ALTS.length);
    await page.keyboard.press("Tab");
    await expect(zoomButtons.first()).toBeFocused();
    await zoomButtons.last().focus();
    await page.keyboard.press("Tab");
    await expect(section.getByRole("link", { name: /^Xem thêm\s*: Acceptance feedback$/ })).toBeFocused();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }

  await page.locator('[data-homepage-region="feedback"]').getByRole("link", { name: /^Xem thêm/ }).click();
  await page.waitForURL("**/feedback");
  await expect(page.getByRole("heading", { level: 1, name: "Acceptance feedback" })).toBeVisible();
  await expect(page).toHaveTitle(/^Acceptance feedback title/);
  expect(await page.locator(".feedback-gallery img").evaluateAll((images) =>
    images.map((image) => image.getAttribute("alt")),
  )).toEqual(FEEDBACK_ALTS);
});

test("pressing a feedback photograph opens it enlarged in a keyboard-operable viewer", async ({ page }) => {
  await serveFeedbackAtNaturalSize(page);
  for (const [path, viewport, list] of [
    ["/", DESKTOP, '[data-homepage-region="feedback"] .feedback-rail__item'],
    ["/feedback", MOBILE, ".feedback-gallery__item"],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });

    const second = page.locator(`${list} button.feedback-zoom`).nth(1);
    await expect(second).toHaveAccessibleName(`Phóng to ảnh: ${FEEDBACK_ALTS[1]}`);
    await expect(page.locator(`${list} a`)).toHaveCount(0);

    await second.click();
    const viewer = page.getByRole("dialog", { name: "Xem ảnh feedback" });
    await expect(viewer).toBeVisible();
    const enlarged = viewer.locator("img");
    await expect(enlarged).toHaveAttribute("alt", FEEDBACK_ALTS[1]!);
    await expect(viewer.getByText(`2 / ${FEEDBACK_ALTS.length}`)).toBeVisible();
    // Uncropped: the enlarged photograph keeps its natural ratio and is not covered to a frame.
    const box = (await enlarged.boundingBox())!;
    const natural = FEEDBACK_SIZES[1]!.width / FEEDBACK_SIZES[1]!.height;
    expect(box.width / box.height).toBeCloseTo(natural, 1);
    expect(await enlarged.evaluate((image) => getComputedStyle(image).objectFit)).not.toBe("cover");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // The page behind stays put while the viewer is open.
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    // Arrow keys and the buttons move through the configured order, wrapping at the ends.
    await page.keyboard.press("ArrowRight");
    await expect(enlarged).toHaveAttribute("alt", FEEDBACK_ALTS[2]!);
    await viewer.getByRole("button", { name: "Ảnh trước" }).click();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(enlarged).toHaveAttribute("alt", FEEDBACK_ALTS[FEEDBACK_ALTS.length - 1]!);
    await viewer.getByRole("button", { name: "Ảnh sau" }).click();
    await expect(enlarged).toHaveAttribute("alt", FEEDBACK_ALTS[0]!);

    // Escape closes it and hands focus back to the photograph that opened it.
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(second).toBeFocused();

    // The close button closes it too.
    await second.press("Enter");
    await expect(viewer).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await viewer.getByRole("button", { name: "Đóng" }).click();
    await expect(viewer).toBeHidden();
    await expect(second).toBeFocused();
  }
});

test("/feedback is an uncropped masonry: natural ratios, 4 columns on desktop and 2 on a phone", async ({
  page,
}) => {
  await serveFeedbackAtNaturalSize(page);

  for (const [viewport, columns] of [
    [DESKTOP, 4],
    [MOBILE, 2],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/feedback`, { waitUntil: "networkidle" });

    const gallery = page.locator(".feedback-gallery");
    await expect(gallery.locator(".feedback-photo-uncropped")).toHaveCount(FEEDBACK_SIZES.length);
    await expect(gallery.locator(".feedback-photo")).toHaveCount(0);

    const boxes = await gallery.locator(".feedback-photo-uncropped").evaluateAll((frames) =>
      frames.map((frame) => {
        const image = frame.querySelector("img")!;
        const frameBox = frame.getBoundingClientRect();
        const imageBox = image.getBoundingClientRect();
        return {
          left: Math.round(frameBox.left),
          frameRatio: frameBox.width / frameBox.height,
          imageRatio: imageBox.width / imageBox.height,
          imageHeight: imageBox.height,
          frameHeight: frameBox.height,
          objectFit: getComputedStyle(image).objectFit,
        };
      }),
    );
    boxes.forEach((box, index) => {
      const natural = FEEDBACK_SIZES[index]!.width / FEEDBACK_SIZES[index]!.height;
      // The frame is the photograph: its ratio is the natural one, and nothing is cropped away.
      expect(box.frameRatio, `${viewport.width}px photo ${index + 1} frame ratio`).toBeCloseTo(natural, 1);
      expect(box.imageRatio, `${viewport.width}px photo ${index + 1} image ratio`).toBeCloseTo(natural, 1);
      expect(Math.abs(box.imageHeight - box.frameHeight), `${viewport.width}px photo ${index + 1} clipped`).toBeLessThanOrEqual(1);
      expect(box.objectFit).not.toBe("cover");
    });

    expect(new Set(boxes.map((box) => box.left)).size, `${viewport.width}px column count`).toBe(columns);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${viewport.width}px horizontal overflow`,
    ).toBe(true);
  }
});

test("the fully populated homepage and /feedback are accessible and overflow-free at both widths", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  for (const viewport of [MOBILE, DESKTOP]) {
    await page.setViewportSize(viewport);
    for (const path of ["/", "/feedback"]) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
      const results = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
      expect(results.violations, `${viewport.width} ${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${viewport.width} ${path} horizontal overflow`,
      ).toBe(true);
    }
  }

  expect(browserErrors).toEqual([]);
});
