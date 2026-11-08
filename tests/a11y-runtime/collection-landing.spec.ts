import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { BRAND } from "../../src/brand/index.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

const HOST = "127.0.0.1";
const PORT = 3309;
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
const heroSlug = `runtime-hero-${suffix}`;
const bstSlug = `runtime-bst-${suffix}`;
const badgeSlugs = ["a", "b", "c", "d", "e"].map((key) => `runtime-badge-${key}-${suffix}`);
const badgeProductSlug = `collection-badges-${suffix}`;
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
    where: { slug: { in: [publishedSlug, pagedSlug, draftSlug, emptySlug, heroSlug, bstSlug, ...badgeSlugs] } },
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
      {
        slug: heroSlug,
        title: "Runtime Hero Collection",
        description: "Published collection with real configured hero media.",
        heroImageUrl: "https://content.pancake.vn/images/1/2/3/collection-hero.jpg",
        heroImageMobileUrl: "https://content.pancake.vn/images/1/2/3/collection-hero-mobile.jpg",
        isPublished: true,
      },
      {
        slug: bstSlug,
        // Stored the way merchandisers name collections in admin; the storefront drops the prefix.
        title: "BST Runtime Diệp Họa",
        description: "A collection whose stored title carries the administrative BST prefix.",
        isPublished: true,
      },
    ],
  });
  // Enough long collection names that the badge row under the product name cannot fit at any width.
  await prisma.collectionDefinition.createMany({
    data: badgeSlugs.map((slug, index) => ({
      slug,
      title: `Runtime Badge Collection Number ${index + 1}`,
      description: "Collection that only exists to give a product many badges.",
      isPublished: true,
    })),
  });
  await seedProduct("badges", `Badge Runtime Dress ${suffix}`, badgeSlugs, "M");
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

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      ...nextServerEnv(".next-test/collection-landing"),
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

/**
 * A collection draws the category listing's filter panel. From `md` its size chips sit inline in the
 * desktop bar; on a phone they live in the "Bộ lọc" drawer. Either way they are plain links named by
 * the size, so the one visible on this viewport is returned.
 */
async function visibleSizeLink(page: Page, size: string) {
  const mobileFilterButton = page.getByRole("button", { name: "Bộ lọc", exact: true });
  if (await mobileFilterButton.isVisible()) {
    await mobileFilterButton.click();
    const dialog = page.getByRole("dialog", { name: "Bộ lọc sản phẩm" });
    await expect(dialog).toBeVisible();
    return dialog.getByRole("link", { name: size, exact: true });
  }
  const link = page.locator("#main-content").getByRole("link", { name: size, exact: true }).first();
  await expect(link).toBeVisible();
  return link;
}

function sortSelect(page: Page) {
  return page.getByRole("combobox", { name: "Sắp xếp sản phẩm" });
}

test("collection with configured hero uses the shared full-bleed header overlay without inventing a CTA", async ({
  page,
}) => {
  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
  );
  const desktopHero = "https://content.pancake.vn/images/1/2/3/collection-hero.jpg";
  const mobileHero = "https://content.pancake.vn/images/1/2/3/collection-hero-mobile.jpg";
  const requestedHeroSources: string[] = [];
  await page.route("**/_next/image**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("url");
    if (source === desktopHero || source === mobileHero) {
      requestedHeroSources.push(source);
    }
    route.fulfill({ status: 200, contentType: "image/jpeg", body: tinyJpeg });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/collections/${heroSlug}`, { waitUntil: "networkidle" });

  const hero = page.getByRole("region", { name: "Ảnh bìa bộ sưu tập Runtime Hero Collection" });
  await expect(hero).toHaveAttribute("data-header-overlay-hero", "");
  const box = await hero.boundingBox();
  expect(box?.x).toBe(0);
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(844);
  await expect(page.getByRole("link", { name: "MUA NGAY" })).toHaveCount(0);
  // The cover fills the first screen, so it carries an in-page cue to the products below it.
  const cue = hero.getByRole("link", { name: "Xem sản phẩm", exact: true });
  await expect(cue).toBeInViewport();
  await expect(cue).toHaveAttribute("href", "#san-pham");
  await expect.poll(() => requestedHeroSources.includes(mobileHero)).toBe(true);
  expect(requestedHeroSources.includes(desktopHero)).toBe(false);

  const header = page.locator("header.site-header");
  expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await page.evaluate(() => window.scrollTo(0, 30));
  await expect(header).toHaveAttribute("data-scrolled", "true");
  expect(await header.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);

  requestedHeroSources.length = 0;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => requestedHeroSources.includes(desktopHero)).toBe(true);
  expect(requestedHeroSources.includes(mobileHero)).toBe(false);
});

/**
 * The hero contract and the shared listing chrome are one arrangement, not two.
 *
 * They arrived on separate branches that both rewrote this page's top: one moved the hero out of
 * the container to become the first full-bleed surface the header overlays, the other replaced the
 * page's own heading with the chrome every listing shares. Either change alone reads as correct
 * while quietly undoing the other -- a naive merge puts the hero back under the heading, inside
 * the container, and the overlay stops applying. This asserts the order between them, so that
 * reconciliation is not something a future merge can resolve by dropping one.
 */
test("a collection hero is the first full-bleed surface and the shared listing chrome follows it", async ({
  page,
}) => {
  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
  );
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: tinyJpeg });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/collections/${heroSlug}`, { waitUntil: "networkidle" });

  const hero = page.locator("[data-header-overlay-hero]");
  await expect(hero).toHaveCount(1);

  // The hero is inside the main landmark the overlay selector keys off, and nothing renders
  // before it there -- an image nested in the constrained container would fail both halves.
  expect(
    await hero.evaluate((element) => element.closest("#main-content") !== null),
    "the overlay selector is scoped to #main-content",
  ).toBe(true);
  expect(
    await hero.evaluate((element) => element.closest("[class*='max-w-']") === null),
    "the hero is a full-bleed surface, not a block inside the constrained listing container",
  ).toBe(true);
  const heroBox = await hero.boundingBox();
  expect(heroBox?.x, "the hero starts at the viewport edge").toBe(0);
  expect(Math.round(heroBox?.width ?? 0), "the hero spans the viewport").toBe(390);

  // The shared chrome is present and comes after the hero in document order.
  const heading = page.getByRole("heading", { level: 1, name: "Runtime Hero Collection" });
  await expect(heading).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

  const heroPrecedesChrome = await page.evaluate(() => {
    const heroElement = document.querySelector("[data-header-overlay-hero]");
    const headingElement = document.querySelector("#main-content h1");
    if (!heroElement || !headingElement) return null;
    // DOCUMENT_POSITION_FOLLOWING === 4: the heading follows the hero.
    return Boolean(heroElement.compareDocumentPosition(headingElement) & 4);
  });
  expect(heroPrecedesChrome, "the serif listing heading renders after the hero").toBe(true);

  // And the heading is still the shared chrome's, not a page-local one.
  const headingStyle = await heading.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
  });
  expect(headingStyle.fontFamily.toLowerCase()).toMatch(/josefin/);
  expect(Number(headingStyle.fontWeight)).toBeLessThanOrEqual(400);

});

test("a collection hero hides the promotion strip at the top and reveals it after scroll", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/collections/${heroSlug}`, { waitUntil: "networkidle" });

    const header = page.locator("header.site-header");
    const promotion = page.locator(".promotion-shell");

    await expect(header).toHaveAttribute("data-scrolled", "false");
    await expect(promotion).toBeHidden();

    await page.evaluate(() => window.scrollTo(0, 240));
    await expect(header).toHaveAttribute("data-scrolled", "true");
    await expect(promotion).toBeVisible();
  }
});

test("published collection exposes visible copy and deterministic website-owned membership", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/collections/${publishedSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime City Uniform" })).toBeVisible();
  // The header is title-only: neither the story line nor the buyer notice is drawn under it.
  await expect(page.getByText("Visible collection copy for a published editorial landing.")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Bộ sưu tập", exact: true })).toBeVisible();
  // The collection detail intentionally omits the visible eyebrow; the masthead and semantic
  // page heading already identify the surface without repeating "Bộ sưu tập" in the body.
  await expect(
    page.locator("#main-content p.eyebrow").filter({ hasText: "Bộ sưu tập" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: `${BRAND.identity.name} — Trang chủ` }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Khám phá các sản phẩm trong bộ sưu tập này. Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.",
      { exact: true },
    ),
  ).toHaveCount(0);

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
  await page.setViewportSize({ width: 1280, height: 900 });
  const forgedResponse = await page.goto(
    `${BASE_URL}/collections/${publishedSlug}?collection=${draftSlug}`,
    { waitUntil: "networkidle" },
  );
  expect(forgedResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime City Uniform" })).toBeVisible();
  await expect(page.getByText("Runtime Draft Collection")).toHaveCount(0);

  // The category listing's sort: the merchandiser's order first, then price and name.
  await expect(sortSelect(page)).toHaveValue("default");
  await expect(sortSelect(page).getByRole("option")).toHaveText([
    "Thứ tự mặc định",
    "Giá: Thấp đến Cao",
    "Giá: Cao đến Thấp",
    "Tên: A đến Z",
    "Tên: Z đến A",
  ]);

  await expect(await visibleSizeLink(page, "S")).toHaveAttribute("href", `/collections/${publishedSlug}?size=S`);
  await expect(await visibleSizeLink(page, "M")).toHaveAttribute("href", `/collections/${publishedSlug}?size=M`);
  await expect(page.getByRole("link", { name: "Còn hàng", exact: true })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?availability=in-stock`,
  );
  // Nothing in this collection is discounted, so the Sale toggle has nothing to find and is not drawn.
  await expect(page.getByRole("link", { name: "Sale", exact: true })).toHaveCount(0);
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);

  await page.goto(`${BASE_URL}/collections/${publishedSlug}?size=M&sort=price-desc`, {
    waitUntil: "networkidle",
  });
  await expect(sortSelect(page)).toHaveValue("price-desc");
  // The chosen size switches itself off and keeps the sort; another size swaps in and keeps it too.
  await expect(await visibleSizeLink(page, "M")).toHaveAttribute("href", `/collections/${publishedSlug}?sort=price-desc`);
  await expect(await visibleSizeLink(page, "S")).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?size=S&sort=price-desc`,
  );
  await expect(page.getByRole("link", { name: "Xóa bộ lọc size M" })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?sort=price-desc`,
  );
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("a collection loads its next page in place, ordered and filtered like the page's own URL", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/collections/${pagedSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByText("25 sản phẩm", { exact: true })).toBeAttached();

  const cards = page.locator("#main-content article h2");
  await expect(cards).toHaveCount(24);
  const more = page.getByRole("button", { name: "Xem thêm (24/25)" });
  await expect(more).toBeVisible();
  await more.click();
  await expect(cards).toHaveCount(25);
  await expect(page.getByRole("button", { name: /Xem thêm/ })).toHaveCount(0);
  // The 25 products are the collection's, each once, and the URL never moved off page one.
  expect(new Set(await cards.allTextContents()).size).toBe(25);
  expect(page.url()).not.toContain("page=");

  // A crawlable page two still opens on its own and lists the one product it holds.
  const pageTwo = await page.goto(`${BASE_URL}/collections/${pagedSlug}?page=2`, { waitUntil: "networkidle" });
  expect(pageTwo?.status()).toBe(200);
  await expect(cards).toHaveCount(1);
});

test("U3 changing Size from page 2 resets pagination and does not carry a stale page into 404", async ({
  page,
}) => {
  const pageTwo = await page.goto(`${BASE_URL}/collections/${pagedSlug}?page=2`, {
    waitUntil: "networkidle",
  });
  expect(pageTwo?.status()).toBe(200);
  await expect(page.getByText("25 sản phẩm", { exact: true })).toBeAttached();

  const small = await visibleSizeLink(page, "S");
  await expect(small).toHaveAttribute("href", `/collections/${pagedSlug}?size=S`);

  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${pagedSlug}?size=S`),
    small.click(),
  ]);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime Paged Collection" })).toBeVisible();
  await expect(page.getByText("1 sản phẩm", { exact: true })).toBeAttached();
  await expect(page.getByRole("heading", { level: 2, name: `Paged Runtime Product 01 ${suffix}` })).toBeVisible();
  await expect(page.getByRole("button", { name: /Xem thêm/ })).toHaveCount(0);
  expect(page.url()).not.toContain("page=");
  await expect(page.locator(`a[href*="collection="]`)).toHaveCount(0);
});

test("a price filter that matches nothing shows the listing's empty state with one way back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/collections/${publishedSlug}`, { waitUntil: "networkidle" });

  await page.getByRole("spinbutton", { name: "Giá tối thiểu" }).first().fill("5000000");
  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${publishedSlug}?minPrice=5000000`),
    page.getByRole("button", { name: "Lọc", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { level: 2, name: "Không tìm thấy sản phẩm phù hợp" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Xóa tất cả bộ lọc" })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}`,
  );
  // The anchor the homepage hero lands on stays the title's; the empty grid does not add a second one.
  await expect(page.locator("#san-pham")).toHaveCount(1);
});

/**
 * Filtering or re-sorting leaves the shopper where they were. By default a client navigation
 * whose page segment starts above the viewport scrolls back to that segment's top, which on a
 * collection read as the page jumping up every time a size was picked.
 *
 * The desktop bar keeps both controls inline, so no drawer and no scroll lock are involved. The
 * link is fired with `dispatchEvent` and the select with `selectOption`, neither of which scrolls
 * the element into view. Two page styles are switched off for the measurement. Smooth scrolling,
 * because a jump back to the top would otherwise still be animating when the position is read.
 * Scroll anchoring, because it is the browser's own correction, not the router's: dropping a
 * product moves every card after it up a slot, and Chromium shifts the page by a row to keep the
 * card it anchored on in view. With both off, any movement can only come from the navigation.
 *
 * Each path starts from a fresh load, so each one proves its own `scroll: false`.
 */
async function openCollectionScrolledDown(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/collections/${pagedSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByText("25 sản phẩm", { exact: true })).toBeAttached();
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    document.documentElement.style.overflowAnchor = "none";
    window.scrollTo(0, 800);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800);
}

async function expectScrollKept(page: Page) {
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - 800)).toBeLessThan(50);
}

test("picking a Size on a collection keeps the scroll position", async ({ page }) => {
  await openCollectionScrolledDown(page);

  // M keeps 24 products, so the page stays tall enough to hold the same offset.
  const medium = page.locator("#main-content").getByRole("link", { name: "M", exact: true }).first();
  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${pagedSlug}?size=M`),
    medium.dispatchEvent("click"),
  ]);
  await expect(page.getByText("24 sản phẩm", { exact: true })).toBeAttached();
  await expect(medium).toHaveAttribute("aria-current", "true");
  await expectScrollKept(page);
});

test("changing the sort on a collection keeps the scroll position", async ({ page }) => {
  await openCollectionScrolledDown(page);

  await Promise.all([
    page.waitForURL(`${BASE_URL}/collections/${pagedSlug}?sort=price-desc`),
    sortSelect(page).selectOption({ label: "Giá: Cao đến Thấp" }),
  ]);
  // The select shows the new value as soon as it is picked; the active-sort clear link only appears
  // once the server's page has rendered, and that render is when the router would scroll.
  await expect(page.getByRole("link", { name: "Xóa bộ lọc", exact: true }).first()).toBeAttached();
  await expect(sortSelect(page)).toHaveValue("price-desc");
  await expectScrollKept(page);
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

test("a stored BST-prefixed title is shown without the prefix on the collection page and the index", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/collections/${bstSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Runtime Diệp Họa", exact: true })).toBeVisible();
  await expect(page.locator("main").getByText("BST Runtime Diệp Họa")).toHaveCount(0);

  await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });
  const card = page
    .locator("main article")
    .filter({ has: page.locator(`a[href="/collections/${bstSlug}"]`) });
  await expect(card.getByRole("heading", { level: 2 })).toHaveText("Runtime Diệp Họa");
});

test("on a phone a collection's filters open in the listing drawer, sizes, price and stock together", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/collections/${publishedSlug}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Bộ lọc", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bộ lọc sản phẩm" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "S", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "M", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Chỉ xem sản phẩm còn hàng" })).toHaveAttribute(
    "href",
    `/collections/${publishedSlug}?availability=in-stock`,
  );
  await expect(dialog.getByRole("spinbutton", { name: "Giá tối thiểu" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Xem 2 sản phẩm" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the product page's collection badges stay on one line and fade only while they scroll", async ({ page }) => {
  for (const width of [390, 640, 768, 1023]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE_URL}/shop/${badgeProductSlug}`, { waitUntil: "networkidle" });
    const row = page.locator(".pdp-collection-row");
    await expect(row.getByRole("link")).toHaveCount(badgeSlugs.length);
    const facts = await row.evaluate((element) => {
      const tops = [...element.querySelectorAll("a")].map((link) => Math.round(link.getBoundingClientRect().top));
      return {
        oneLine: new Set(tops).size === 1,
        scrolls: element.scrollWidth > element.clientWidth,
        masked: getComputedStyle(element).maskImage !== "none",
        paddingLeft: parseFloat(getComputedStyle(element).paddingLeft),
      };
    });
    expect(facts.oneLine, `${width}px keeps one line`).toBe(true);
    expect(facts.scrolls, `${width}px scrolls`).toBe(true);
    expect(facts.masked, `${width}px shows the fade while it scrolls`).toBe(true);
    // The fade covers the first 24px, which the row's own padding must hold clear of the first badge.
    expect(facts.paddingLeft, `${width}px clears the fade`).toBeGreaterThanOrEqual(24);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/shop/${badgeProductSlug}`, { waitUntil: "networkidle" });
  const wide = await page.locator(".pdp-collection-row").evaluate((element) => ({
    masked: getComputedStyle(element).maskImage !== "none",
    wraps: getComputedStyle(element).flexWrap === "wrap",
  }));
  expect(wide).toEqual({ masked: false, wraps: true });
});
