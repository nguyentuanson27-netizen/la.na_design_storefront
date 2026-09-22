import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3325;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_018;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-23T00:00:00.000Z");
const productSlug = `p18-final-qa-product-${runId}`;
const productName = `P18 Final QA Overshirt ${runId}`;
const trustedImages = [
  "https://content.pancake.vn/images/1/2/3/p18-final-qa-front.jpg",
  "https://content.pancake.vn/images/1/2/3/p18-final-qa-back.jpg",
  "https://content.pancake.vn/images/1/2/3/p18-final-qa-detail.jpg",
] as const;

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
      throw new Error(`Next.js P18 production server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${productSlug}`, { redirect: "manual" });
      if (response.status === 200) {
        const text = await response.text();
        if (text.includes(productName)) return;
      }
    } catch {
      // Production server may still be starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for P18 production server\n${serverOutput}`);
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
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);

  const accessibility = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

async function measureRoute(
  page: import("@playwright/test").Page,
  routeName: "home" | "plp" | "pdp",
  url: string,
  viewportName: "mobile" | "desktop",
) {
  const response = await page.goto(url, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const metrics = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    if (!entry) return null;
    const navigation = entry as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];

    return {
      ttfbMs: navigation.responseStart,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      loadMs: navigation.loadEventEnd,
      fcpMs: fcp?.startTime ?? null,
      documentTransferBytes: navigation.transferSize,
      resourceCount: resources.length,
      resourceTransferBytes: resources.reduce((sum, resource) => sum + resource.transferSize, 0),
    };
  });

  expect(metrics).not.toBeNull();
  expect(metrics!.ttfbMs).toBeGreaterThanOrEqual(0);
  expect(metrics!.domContentLoadedMs).toBeGreaterThan(0);
  expect(metrics!.loadMs).toBeGreaterThan(0);
  expect(metrics!.fcpMs).not.toBeNull();
  expect(metrics!.fcpMs!).toBeGreaterThan(0);
  expect(metrics!.documentTransferBytes).toBeGreaterThanOrEqual(0);
  expect(metrics!.resourceCount).toBeGreaterThan(0);
  expect(metrics!.resourceTransferBytes).toBeGreaterThanOrEqual(0);

  console.log(
    `P18_PERFORMANCE_EVIDENCE ${JSON.stringify({
      viewport: viewportName,
      route: routeName,
      ...metrics,
    })}`,
  );

  await assertPageQuality(page);
}

async function createMeasuredPage(
  browser: import("@playwright/test").Browser,
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const browserErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/_next/image**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: TINY_JPEG_BUFFER,
    });
  });

  return { context, page, browserErrors };
}

test.beforeAll(async () => {
  await cleanup();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `p18-product-${runId}`,
      slug: productSlug,
      name: productName,
      sourceDescription: "Reviewed source context for P18 final QA fixture.",
      primaryImageUrl: trustedImages[0],
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Published P18 final QA storefront copy.",
          seoTitle: "P18 final QA overshirt",
          seoDescription: "Published P18 final QA metadata fixture.",
          collectionSlugs: [],
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `p18-variant-${runId}`,
      productId: product.id,
      color: "Black",
      size: "M",
      pancakeImageUrls: [...trustedImages],
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
      pancakeWarehouseId: `p18-warehouse-${runId}`,
      quantity: 3,
      syncedAt,
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "start", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_URL: BASE_URL,
      PANCAKE_SHOP_ID: String(SHOP_ID),
      SEARCH_INDEXING_ENABLED: "false",
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

test("P18 captures representative production performance evidence for home, PLP, and PDP on mobile and desktop", async ({
  browser,
}) => {
  const viewports = [
    { name: "mobile" as const, width: 390, height: 844 },
    { name: "desktop" as const, width: 1440, height: 900 },
  ];
  const routes = [
    { name: "home" as const, url: `${BASE_URL}/` },
    { name: "plp" as const, url: `${BASE_URL}/shop` },
    { name: "pdp" as const, url: `${BASE_URL}/shop/${productSlug}` },
  ];

  for (const viewport of viewports) {
    for (const route of routes) {
      const { context, page, browserErrors } = await createMeasuredPage(browser, viewport);
      try {
        await measureRoute(page, route.name, route.url, viewport.name);

        if (route.name === "pdp") {
          const stage = page.getByRole("region", { name: `Ảnh chính của ${productName}` });
          await expect(stage).toHaveAttribute("data-header-overlay-hero", "");

          // The below-`lg` editorial grid is gone; the mobile gallery inside the stage replaced it.
          await expect(page.getByLabel(`Bộ sưu tập hình ảnh ${productName}`)).toHaveCount(0);

          /*
           * Both compositions live in this stage and each declares image 1, so the markup holds it
           * more than once while a viewport paints exactly one. What final QA owes is the
           * user-visible contract, so the assertions read what is rendered rather than counting
           * the hidden alternate composition's DOM copies.
           */
          const visibleProductImages = await page
            .locator(`img[alt^="${productName}"]:visible`)
            .evaluateAll((elements) => elements.map((element) => element.getAttribute("alt")));
          expect(
            visibleProductImages,
            `${viewport.name}: exactly one product photograph on screen`,
          ).toEqual([productName]);

          if (viewport.name === "desktop") {
            // From `lg` up the stage is the gallery: slide 1 is image 1 alone, then the pair.
            await expect(stage.locator(".pdp-mobile-gallery")).toBeHidden();
            await expect(stage.locator(".pdp-stage__track")).toBeVisible();
            await expect(stage.locator(".pdp-stage__slide")).toHaveCount(2);

            const activeSlide = stage.locator('.pdp-stage__slide[data-active="true"]');
            await expect(activeSlide).toHaveCount(1);
            await expect(activeSlide.locator("img")).toHaveCount(1);
            await expect(activeSlide.locator("img")).toHaveAttribute("alt", productName);
            await expect(stage.getByRole("status")).toHaveText("Trang ảnh 1 / 2");
          } else {
            // Below `lg` it is the one-image swipe gallery with its current/total indicator.
            await expect(stage.locator(".pdp-stage__track")).toBeHidden();
            const mobileGallery = stage.locator(".pdp-mobile-gallery");
            await expect(mobileGallery).toBeVisible();
            await expect(mobileGallery.locator("img")).toHaveCount(1);
            await expect(mobileGallery.locator("img")).toHaveAttribute("alt", productName);
            await expect(stage.getByRole("status")).toHaveText("1/3");
          }
        }

        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
        expect(browserErrors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }
});

test("independent mobile chrome keeps practical header targets and phone grid rhythm without overflow", async ({
  browser,
}) => {
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    const { context, page, browserErrors } = await createMeasuredPage(browser, viewport);
    try {
      await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });

      if (viewport.width < 900) {
        const menu = page.getByRole("button", { name: "Menu", exact: true });
        const search = page.locator(".utility-nav button").first();
        const cart = page.locator(".utility-nav button").last();

        for (const control of [menu, search, cart]) {
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          expect(box?.width).toBeGreaterThanOrEqual(44);
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }

        await menu.click();
        const closeMenu = page.getByRole("button", { name: "Đóng menu", exact: true });
        await expect(closeMenu).toBeVisible();
        const closeMenuBox = await closeMenu.boundingBox();
        expect(closeMenuBox?.width).toBeGreaterThanOrEqual(44);
        expect(closeMenuBox?.height).toBeGreaterThanOrEqual(44);
        await closeMenu.click();

        await expect(page.locator(".mobile-account-link")).toBeHidden();
      }

      /*
       * The product grid, not the first two-column thing on the page: `/shop` draws its filter
       * form as a `.grid-cols-2` too, and that one comes first in the DOM, so reading the rhythm
       * from it measured the form's `gap-x-4` and reported 16px against the grid's 2px.
       */
      const grid = page
        .locator("main .grid-cols-2")
        .filter({ has: page.locator(".product-visual") })
        .first();
      await expect(grid).toBeVisible();
      const computed = await grid.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          columns: style.gridTemplateColumns.split(/\s+/).filter(Boolean).length,
          columnGap: style.columnGap,
          rowGap: style.rowGap,
        };
      });

      if (viewport.width <= 390) {
        expect(computed.columns).toBe(2);
        expect(computed.columnGap).toBe("2px");
        expect(computed.rowGap).toBe("2px");
      }

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      expect(browserErrors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test("P18 inspects staging-safe metadata, robots, sitemap, and parent Product schema on the production build", async ({
  browser,
}) => {
  const { context, page, browserErrors } = await createMeasuredPage(browser, {
    width: 1440,
    height: 900,
  });

  try {
    const response = await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/La\.na Design/);

    const robotsMeta = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robotsMeta?.toLowerCase()).toContain("noindex");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

    const jsonLdDocuments = (await page.locator('script[type="application/ld+json"]').allTextContents()).map(
      (value) => JSON.parse(value),
    );
    const productDocument = jsonLdDocuments.find((document) =>
      Array.isArray(document?.["@graph"])
        ? document["@graph"].some((node: { "@type"?: string }) => node?.["@type"] === "Product")
        : false,
    );
    expect(productDocument).toBeTruthy();
    const productNode = productDocument["@graph"].find(
      (node: { "@type"?: string }) => node?.["@type"] === "Product",
    );
    expect(productNode.name).toBe(productName);
    expect(productNode.url).toBe(`${BASE_URL}/shop/${productSlug}`);
    expect(productNode.offers).toEqual({
      "@type": "Offer",
      url: `${BASE_URL}/shop/${productSlug}`,
      priceCurrency: "VND",
      price: 890_000,
      availability: "https://schema.org/InStock",
    });

    const robotsResponse = await page.request.get(`${BASE_URL}/robots.txt`);
    expect(robotsResponse.status()).toBe(200);
    const robots = await robotsResponse.text();
    expect(robots).toContain("User-Agent: OAI-SearchBot");
    expect(robots).toContain("Disallow: /api");
    expect(robots).not.toContain("Sitemap:");

    const sitemapResponse = await page.request.get(`${BASE_URL}/sitemap.xml`);
    expect(sitemapResponse.status()).toBe(200);
    const sitemap = await sitemapResponse.text();
    expect(sitemap).not.toContain("<url>");
    expect(sitemap).not.toContain(productSlug);

    await assertPageQuality(page);
    expect(browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
