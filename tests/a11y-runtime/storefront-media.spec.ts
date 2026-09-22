import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3333;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_019;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-13T04:00:00.000Z");

const multiSlug = `media-multi-product-${runId}`;
const multiName = `Multi Media Jacket ${runId}`;
const singleSlug = `media-single-product-${runId}`;
const singleName = `Single Media Tee ${runId}`;
const fallbackSlug = `media-fallback-product-${runId}`;
const fallbackName = `Fallback Product ${runId}`;

// 1x1 transparent/dummy JPEG image payload for offline-safe fixture responses
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const TINY_JPEG_BUFFER = Buffer.from(TINY_JPEG_BASE64, "base64");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js media test server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for storefront media server\n${serverOutput}`);
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
  ).toBeLessThanOrEqual(overflowReport.viewportWidth + 1);

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

test.beforeAll(async () => {
  await cleanup();

  // 1. Multi-image product: primary + 2 variant images
  const multiProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-multi-${runId}`,
      slug: multiSlug,
      name: multiName,
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/primary.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Multi-image storefront media test jacket.",
        },
      },
    },
  });
  const multiVariant1 = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-multi-var-1-${runId}`,
      productId: multiProduct.id,
      color: "Black",
      size: "M",
      pancakeImageUrls: [
        "https://content.pancake.vn/images/1/2/3/primary.jpg",
        "https://content.pancake.vn/images/1/2/3/angle-front.jpg",
      ],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_250_000,
      pancakeRetailPriceAfterDiscount: 1_250_000,
      syncedAt,
    },
  });
  const multiVariant2 = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-multi-var-2-${runId}`,
      productId: multiProduct.id,
      color: "Olive",
      size: "L",
      pancakeImageUrls: ["https://content.pancake.vn/images/1/2/3/detail-fabric.jpg"],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_250_000,
      pancakeRetailPriceAfterDiscount: 1_250_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.createMany({
    data: [
      { variantId: multiVariant1.id, pancakeWarehouseId: `wh-1-${runId}`, quantity: 5, syncedAt },
      { variantId: multiVariant2.id, pancakeWarehouseId: `wh-2-${runId}`, quantity: 3, syncedAt },
    ],
  });

  // 2. Single-image product: primary image only, no variant images
  const singleProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-single-${runId}`,
      slug: singleSlug,
      name: singleName,
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/single-tee.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Single-image storefront media test tee.",
        },
      },
    },
  });
  const singleVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-single-var-${runId}`,
      productId: singleProduct.id,
      color: "Stone",
      size: "M",
      pancakeImageUrls: [],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 450_000,
      pancakeRetailPriceAfterDiscount: 450_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: singleVariant.id, pancakeWarehouseId: `wh-3-${runId}`, quantity: 4, syncedAt },
  });

  // 3. Fallback product: untrusted and unreviewed media (fails closed)
  const fallbackProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `media-fallback-${runId}`,
      slug: fallbackSlug,
      name: fallbackName,
      primaryImageUrl: "http://insecure-http.com/images/1/2/3/photo.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          editorialDescription: "Fallback product with untrusted media.",
        },
      },
    },
  });
  const fallbackVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `media-fallback-var-${runId}`,
      productId: fallbackProduct.id,
      color: "Ink",
      size: "S",
      pancakeImageUrls: ["https://content.pancake.vn/arbitrary/path.png"],
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 350_000,
      pancakeRetailPriceAfterDiscount: 350_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: fallbackVariant.id, pancakeWarehouseId: `wh-4-${runId}`, quantity: 2, syncedAt },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/storefront-media",
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

test("storefront catalog card renders trusted primary photography and fallback on untrusted media", async ({
  page,
}) => {
  // Mock external image optimization to ensure deterministic offline execution
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await assertPageQuality(page);

  // Card with trusted image: visible in accessibility tree with role="img" and matching name
  const multiCard = page.locator("article").filter({ hasText: multiName });
  await expect(multiCard).toBeVisible();
  const multiImg = multiCard.getByRole("img", { name: multiName });
  await expect(multiImg).toBeVisible();
  await expect(multiCard.locator(".product-visual")).not.toHaveAttribute("aria-hidden", "true");
  // The hover swap shows another photo of the same product, so it carries no name of its own and
  // stays out of the accessibility tree — one card must expose exactly one image to assistive tech.
  await expect(multiCard.getByRole("img")).toHaveCount(1);
  await expect(multiCard.locator("img")).toHaveCount(2);

  // Card with untrusted fallback: decorative fallback wrapper is aria-hidden and has no img role
  const fallbackCard = page.locator("article").filter({ hasText: fallbackName });
  await expect(fallbackCard).toBeVisible();
  await expect(fallbackCard.getByRole("img")).toHaveCount(0);
  await expect(fallbackCard.locator(".product-visual")).toHaveAttribute("aria-hidden", "true");
  await expect(fallbackCard.locator(".garment-silhouette")).toBeVisible();
});

test("PDP with single trusted image renders hero image without redundant thumbnail controls", async ({
  page,
}) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${singleSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: singleName })).toBeVisible();
  await assertPageQuality(page);

  // The canonical first image is the full-bleed hero and the header overlays it at the top.
  const hero = page.getByRole("region", { name: `Ảnh chính của ${singleName}` });
  const heroImg = hero.locator(`img[alt="${singleName}"]`);
  await expect(hero).toHaveAttribute("data-header-overlay-hero", "");
  await expect(heroImg).toBeVisible();
  await expect(page.getByRole("link", { name: "MUA NGAY" })).toHaveCount(0);
  expect(await page.locator("header.site-header").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

  // A one-image product has nothing left to duplicate below the hero.
  await expect(page.getByLabel(`Bộ sưu tập hình ảnh ${singleName}`)).toHaveCount(0);

  // No redundant carousel thumbnail controls
  await expect(page.locator("nav[aria-label^='Danh sách ảnh']")).toHaveCount(0);
});

test("the desktop information row puts the product's own story left and the purchase right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${singleSlug}`, { waitUntil: "networkidle" });

  const heading = page.getByRole("heading", { level: 1, name: singleName });
  await expect(heading).toBeVisible();
  const purchase = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchase).toBeVisible();

  // Refinement spec §3: two columns below the gallery -- identity and editorial on the left,
  // everything the shopper buys with on the right.
  const headingBox = (await heading.boundingBox())!;
  const purchaseBox = (await purchase.boundingBox())!;
  expect(headingBox).not.toBeNull();
  expect(purchaseBox).not.toBeNull();
  expect(headingBox.x + headingBox.width, "identity stays in the left column").toBeLessThanOrEqual(
    1440 / 2,
  );
  expect(purchaseBox.x, "purchase stays in the right column").toBeGreaterThanOrEqual(1440 / 2);

  // ...and the panel no longer follows the scroll, which is what used to put it over that copy.
  expect(
    await purchase.evaluate((element) => getComputedStyle(element).position),
  ).toBe("static");

  // A one-image product has nothing left for the below-`lg` editorial grid to show.
  await expect(page.getByLabel(`Bộ sưu tập hình ảnh ${singleName}`)).toHaveCount(0);
});

test("PDP with multiple images renders a one-column mobile editorial grid with every trusted image once", async ({
  page,
}) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: multiName })).toBeVisible();

  const hero = page.getByRole("region", { name: `Ảnh chính của ${multiName}` });
  await expect(hero.locator(`img[alt="${multiName}"]`)).toHaveCount(1);
  // Below `lg` the stage shows that first image and nothing else.
  await expect(hero.locator("img:visible")).toHaveCount(1);

  const gallery = page.getByLabel(`Bộ sưu tập hình ảnh ${multiName}`);
  const images = gallery.locator("img");
  await expect(images).toHaveCount(2);

  for (let index = 0; index < 2; index += 1) {
    await expect(images.nth(index)).toBeVisible();
  }

  /*
   * Below `lg` the composition is still hero-then-grid, so what a shopper actually sees is the
   * three trusted photographs, once each, in source order.
   *
   * The media stage also carries the later slides in the markup for the `lg` composition, but they
   * have no box at this width -- which is both why they are excluded here and why their lazy
   * images are never fetched on a phone. Asserting over the *visible* images keeps the old
   * guarantee (every trusted image once, no duplicates, the canonical alt text) rather than
   * counting markup the viewport does not render.
   */
  const renderedImages = await page
    .locator(`img[alt^="${multiName}"]`)
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          alt: element.getAttribute("alt"),
          src: element.getAttribute("src"),
        })),
    );
  expect(renderedImages.map(({ alt }) => alt)).toEqual([
    multiName,
    `${multiName} - Ảnh 2`,
    `${multiName} - Ảnh 3`,
  ]);
  expect(new Set(renderedImages.map(({ src }) => src)).size).toBe(3);

  const columnCount = await gallery.evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.trim();
    return columns.length === 0 ? 0 : columns.split(/\s+/).length;
  });
  expect(columnCount).toBe(1);
  await expect(gallery.locator("button")).toHaveCount(0);

  await assertPageQuality(page);
});

test("PDP with untrusted media renders intentional fallback without broken image", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/shop/${fallbackSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: fallbackName })).toBeVisible();
  await assertPageQuality(page);

  // Intentional product-media silhouette fallback. Scope the no-image assertion to the
  // fallback media container so site-wide chrome assets (for example the footer master logo)
  // cannot invalidate this PDP-specific regression check.
  const fallbackMedia = page.locator(".product-visual").filter({
    has: page.locator(".garment-silhouette"),
  });
  await expect(fallbackMedia).toHaveCount(1);
  await expect(fallbackMedia.locator(".garment-silhouette")).toBeVisible();
  await expect(page.getByText("Hình ảnh sản phẩm đang được chuẩn hóa cho storefront.")).toBeVisible();
  await expect(fallbackMedia.locator("img")).toHaveCount(0);
});

test("desktop viewport renders catalog cards and the PDP media stage without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await assertPageQuality(page);

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });
  const stage = page.getByRole("region", { name: `Ảnh chính của ${multiName}` });
  await expect(stage).toBeVisible();

  // Refinement spec §1: a near-viewport media stage that contains the garment rather than
  // cropping it, over the brand's cream rather than black bars.
  const stageBox = (await stage.boundingBox())!;
  expect(stageBox.height, "the stage is approximately one viewport tall").toBeGreaterThan(900 * 0.8);
  expect(
    await stage.locator("img").first().evaluate((element) => getComputedStyle(element).objectFit),
  ).toBe("contain");

  // Slide 1 is image 1 alone at full width; the second slide pairs the remaining two 50/50.
  const slides = stage.locator(".pdp-stage__slide");
  await expect(slides).toHaveCount(2);
  const cellWidths = await slides
    .nth(1)
    .locator(".pdp-stage__cell")
    .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));
  expect(cellWidths).toHaveLength(2);
  expect(Math.abs(cellWidths[0]! - cellWidths[1]!), "a two-image slide splits 50/50").toBeLessThanOrEqual(2);

  // The below-`lg` editorial grid is not part of the desktop composition.
  await expect(page.getByLabel(`Bộ sưu tập hình ảnh ${multiName}`)).toBeHidden();

  await assertPageQuality(page);
});

test("the desktop gallery moves only on deliberate input, clamps at both ends, and leaves the page scroll alone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });

  const stage = page.getByRole("region", { name: `Ảnh chính của ${multiName}` });
  const slides = stage.locator(".pdp-stage__slide");
  const previous = stage.getByRole("button", { name: "Ảnh trước" });
  const next = stage.getByRole("button", { name: "Ảnh tiếp theo" });

  const activeSlide = async () =>
    slides.evaluateAll((elements) =>
      elements.findIndex((element) => element.getAttribute("data-active") === "true"),
    );

  // The canonical first surface, and no way back from it.
  expect(await activeSlide()).toBe(0);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  // Refinement spec §2: the right half advances, the left half goes back.
  await next.click();
  expect(await activeSlide()).toBe(1);

  // The last slide does not loop to the beginning.
  await expect(next).toBeDisabled();
  expect(await activeSlide()).toBe(1);

  await previous.click();
  expect(await activeSlide()).toBe(0);

  // Keyboard reaches the same two controls rather than pointer geometry being the only path.
  await next.focus();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim())).toBe(
    "Ảnh tiếp theo",
  );
  await page.keyboard.press("Enter");
  expect(await activeSlide()).toBe(1);
  await previous.focus();
  await page.keyboard.press("Enter");
  expect(await activeSlide()).toBe(0);

  // A horizontal drag is the third way in, and it must not also fire the half it ended over.
  await page.mouse.move(1000, 450);
  await page.mouse.down();
  await page.mouse.move(820, 455, { steps: 8 });
  await page.mouse.up();
  expect(await activeSlide(), "a leftward drag advances exactly one slide").toBe(1);

  await page.mouse.move(400, 450);
  await page.mouse.down();
  await page.mouse.move(600, 445, { steps: 8 });
  await page.mouse.up();
  expect(await activeSlide(), "a rightward drag goes back exactly one slide").toBe(0);

  /*
   * §2's hard rule, asserted where it matters: a vertical wheel over the gallery scrolls the
   * document and changes nothing about the gallery.
   */
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => window.scrollY > 200);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  expect(await activeSlide(), "a vertical wheel is not gallery input").toBe(0);
});

test("only the current slide's photographs are exposed to assistive technology", async ({
  page,
}) => {
  /*
   * A slide that is merely transparent is still in the accessibility tree, so a screen reader
   * could reach photographs from a slide the stage was reporting as not current. Asserted through
   * role queries, which resolve against the accessibility tree rather than the DOM, so a slide
   * hidden only by `opacity` would still be matched here and fail.
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });

  await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });

  const stage = page.getByRole("region", { name: `Ảnh chính của ${multiName}` });
  const previous = stage.getByRole("button", { name: "Ảnh trước" });
  const next = stage.getByRole("button", { name: "Ảnh tiếp theo" });
  const exposedPhotographs = () =>
    stage.getByRole("img").evaluateAll((elements) => elements.map((element) => element.getAttribute("alt")));

  // Slide 1 is image 1 alone, and it is the only photograph assistive technology can reach.
  await expect.poll(exposedPhotographs).toEqual([multiName]);
  await expect(stage.getByRole("status")).toHaveText("Trang ảnh 1 / 2");
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();

  // Advancing moves what can be reached, not just what is painted.
  await expect
    .poll(exposedPhotographs)
    .toEqual([`${multiName} - Ảnh 2`, `${multiName} - Ảnh 3`]);
  await expect(stage.getByRole("status")).toHaveText("Trang ảnh 2 / 2");
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  await previous.click();
  await expect.poll(exposedPhotographs).toEqual([multiName]);

  // The Axe buyer gate still passes over the whole page with the stage in this state.
  await assertPageQuality(page);
});

test("each trusted photograph is fetched once, whichever composition the viewport renders", async ({
  page,
}) => {
  /*
   * The media stage and the below-`lg` editorial grid both carry images 2..n, because one of them
   * is always `display: none` and a phone and a desktop want different compositions. That only
   * stays honest if the hidden copy never downloads: an element with no layout box is never near
   * the viewport, so its `loading="lazy"` image is never requested.
   *
   * Asserted as "at most once per photograph" rather than "exactly once" because a lazy image is
   * fetched when it approaches the viewport, which is a timing the test scrolls to reach rather
   * than one it should pin.
   */
  const fetched: string[] = [];
  await page.route("**/_next/image**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("url") ?? "";
    fetched.push(source);
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });

  const photographs = ["primary.jpg", "angle-front.jpg", "detail-fabric.jpg"];
  const countsFor = (name: string) => fetched.filter((source) => source.includes(name)).length;

  for (const viewport of [
    { label: "mobile", width: 390, height: 844 },
    { label: "desktop", width: 1440, height: 900 },
  ]) {
    // Blank first: resizing a loaded page swaps the composition under it, and those fetches would
    // be counted against the next load rather than against the one being measured.
    await page.goto("about:blank");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    fetched.length = 0;
    await page.goto(`${BASE_URL}/shop/${multiSlug}`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState("networkidle");

    for (const photograph of photographs) {
      expect(
        countsFor(photograph),
        `${viewport.label}: ${photograph} must not be downloaded twice (${JSON.stringify(fetched)})`,
      ).toBeLessThanOrEqual(1);
    }
    // The canonical first image is the one surface that is always on screen, so it always loads.
    expect(countsFor("primary.jpg"), `${viewport.label}: canonical first image`).toBe(1);
    // ...and the composition this viewport renders really did show the rest.
    expect(
      photographs.slice(1).every((photograph) => countsFor(photograph) === 1),
      `${viewport.label}: every later photograph loads exactly once (${JSON.stringify(fetched)})`,
    ).toBe(true);
  }
});

test("runtime network and CSP headers enforce Pancake media allowlist and reject unreviewed optimizer requests", async ({
  page,
}) => {
  const response = await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  expect(response).not.toBeNull();
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"];
  expect(csp).toBeDefined();
  expect(csp).toContain("https://content.pancake.vn");

  // Direct optimizer request with unreviewed arbitrary path on trusted host fails closed (HTTP 400)
  const unreviewedRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn/arbitrary/shirt.jpg")}&w=1080&q=75`,
  );
  expect(unreviewedRes.status).toBe(400);

  // Direct optimizer request with custom port on trusted host fails closed (HTTP 400)
  const customPortRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn:8443/images/1/2/3/shirt.jpg")}&w=1080&q=75`,
  );
  expect(customPortRes.status).toBe(400);

  // Direct optimizer request with uppercase .JPG on trusted host fails closed (HTTP 400)
  const uppercaseRes = await fetch(
    `${BASE_URL}/_next/image?url=${encodeURIComponent("https://content.pancake.vn/images/1/2/3/shirt.JPG")}&w=1080&q=75`,
  );
  expect(uppercaseRes.status).toBe(400);
});
