import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3216;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_008;
const runId = `${Date.now()}-${process.pid}`;
const productExternalId = `editorial-runtime-product-${runId}`;
const productSlug = `editorial-runtime-product-${runId}`;
const productName = `AAA Editorial Runtime Coat ${runId}`;
const variantExternalId = `editorial-runtime-variant-${runId}`;
const warehouseExternalId = `editorial-runtime-warehouse-${runId}`;
const syncedAt = new Date("2026-08-13T00:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js editorial server exited with ${server.exitCode}\n${serverOutput}`);
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
  throw new Error(`Timed out waiting for editorial server\n${serverOutput}`);
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
}

async function expectRuntimePageClean(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.title.trim().length > 0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForFunction(() => window.scrollY === 0);

  const overflow = await page.evaluate(() => {
    const scrollWidth = document.documentElement.scrollWidth;
    const innerWidth = window.innerWidth;
    if (scrollWidth <= innerWidth) return null;

    const overflowingElements: Array<{
      tag: string;
      className: string;
      text: string;
      right: number;
      width: number;
    }> = [];
    document.querySelectorAll("*").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.right > innerWidth + 1 || rect.left < -1) {
        overflowingElements.push({
          tag: el.tagName,
          className: el.className,
          text: (el.textContent || "").slice(0, 50).trim(),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        });
      }
    });

    return { scrollWidth, innerWidth, overflowingElements };
  });

  expect(overflow).toBeNull();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

async function expectVisualFoundationTokens(page: import("@playwright/test").Page) {
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      shellGutter: style.getPropertyValue("--shell-gutter").trim(),
      shellMax: style.getPropertyValue("--shell-max").trim(),
      space4: style.getPropertyValue("--space-4").trim(),
      mediaProductRatio: style.getPropertyValue("--media-product-ratio").trim(),
      focusRingColor: style.getPropertyValue("--focus-ring-color").trim(),
    };
  });

  for (const value of Object.values(tokens)) {
    expect(value).not.toBe("");
  }

  const primitives = await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <button class="btn btn--primary">Primary</button>
      <button class="btn btn--secondary">Secondary</button>
      <button class="btn btn--outline">Outline</button>
      <span class="badge badge--olive">Olive</span>
      <span class="badge badge--stone">Stone</span>
      <span class="badge badge--outline">Tag</span>
      <div class="skeleton" style="width: 100px; height: 20px;"></div>
    `;
    document.body.appendChild(fixture);

    const btnPrimary = getComputedStyle(fixture.querySelector(".btn--primary")!);
    const btnSecondary = getComputedStyle(fixture.querySelector(".btn--secondary")!);
    const btnOutline = getComputedStyle(fixture.querySelector(".btn--outline")!);
    const badgeOlive = getComputedStyle(fixture.querySelector(".badge--olive")!);
    const badgeStone = getComputedStyle(fixture.querySelector(".badge--stone")!);
    const badgeOutline = getComputedStyle(fixture.querySelector(".badge--outline")!);
    const skeleton = getComputedStyle(fixture.querySelector(".skeleton")!);

    const result = {
      primaryBg: btnPrimary.backgroundColor,
      primaryColor: btnPrimary.color,
      primaryHeight: btnPrimary.minHeight,
      secondaryBg: btnSecondary.backgroundColor,
      outlineBorder: btnOutline.borderColor,
      badgeOliveBg: badgeOlive.backgroundColor,
      badgeStoneBg: badgeStone.backgroundColor,
      badgeOutlineBorder: badgeOutline.borderColor,
      skeletonImage: skeleton.backgroundImage,
    };

    fixture.remove();
    return result;
  });

  expect(primitives.primaryBg).not.toBe("");
  expect(primitives.primaryColor).not.toBe("");
  expect(primitives.primaryHeight).toBe("44px");
  expect(primitives.secondaryBg).not.toBe("");
  expect(primitives.outlineBorder).not.toBe("");
  expect(primitives.badgeOliveBg).not.toBe("");
  expect(primitives.badgeStoneBg).not.toBe("");
  expect(primitives.badgeOutlineBorder).not.toBe("");
  expect(primitives.skeletonImage).toContain("gradient");
}

const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

test.beforeAll(async () => {
  await cleanup();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: productName,
      primaryImageUrl: "https://content.pancake.vn/images/1/2/3/editorial-jacket.jpg",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Runtime editorial layer for the city uniform.",
          collectionSlugs: ["essential-outerwear", "draft-capsule"],
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: variantExternalId,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: warehouseExternalId,
      quantity: 2,
      syncedAt,
    },
  });
  await prisma.collectionDefinition.upsert({
    where: { slug: "essential-outerwear" },
    create: {
      slug: "essential-outerwear",
      title: "Essential Outerwear",
      description: "Functional outerwear designed for transition and movement.",
      seoTitle: "Essential Outerwear — LA Clothing",
      seoDescription: "Modern outerwear from LA Clothing.",
      isPublished: true,
      homepagePosition: 1,
      pancakeCategoryIds: [],
    },
    update: {
      isPublished: true,
      homepagePosition: 1,
      title: "Essential Outerwear",
      description: "Functional outerwear designed for transition and movement.",
    },
  });
  await prisma.collectionDefinition.upsert({
    where: { slug: "draft-capsule" },
    create: {
      slug: "draft-capsule",
      title: "Draft Capsule",
      description: "Unpublished internal capsule.",
      seoTitle: "Draft Capsule — LA Clothing",
      seoDescription: "Unpublished.",
      isPublished: false,
      homepagePosition: null,
      pancakeCategoryIds: [],
    },
    update: {
      isPublished: false,
      homepagePosition: null,
      title: "Draft Capsule",
      description: "Unpublished internal capsule.",
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/editorial",
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      LA_SHIPPING_FEE_VND: "25000",
      LA_FREE_SHIPPING_SUBTOTAL_VND: "750000",
      LA_FREE_SHIPPING_MIN_QUANTITY: "4",
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

test.beforeEach(async ({ page }) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
});

test("P8 storefront shell exposes cutover navigation, shared tokens, focus treatment and semantic footer", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const shippingPromotion = page.getByRole("complementary", { name: "Miễn phí vận chuyển" });
  await expect(shippingPromotion).toBeVisible();
  await expect(shippingPromotion).toHaveClass(/promotion-shell/);
  await expect(shippingPromotion).toContainText("Free ship từ 4 sản phẩm hoặc đơn trên 750 nghìn");
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(400);
  expect(
    await page.evaluate(() => {
      const masthead = document.querySelector(".site-masthead");
      if (!masthead) return null;
      const { top } = masthead.getBoundingClientRect();
      return { top: Math.round(top), pinned: document.elementFromPoint(5, 5)?.className ?? null };
    }),
  ).toEqual({ top: 0, pinned: "promotion-shell" });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.getByText("FALL / WINTER — NEW COLLECTION", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "La.na Design — Trang chủ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Giỏ hàng", exact: true })).toBeVisible();

  const footerNavigation = page.getByRole("navigation", { name: "Mua sắm" });
  await expect(footerNavigation).toBeVisible();
  await expect(footerNavigation.getByRole("link", { name: "Áo dài", exact: true })).toBeVisible();
  await expect(footerNavigation.getByRole("link", { name: "Hàng mới về", exact: true })).toBeVisible();
  await expect(footerNavigation.getByRole("link", { name: "Sale", exact: true })).toBeVisible();
  await expect(page.locator('footer a[href="/lookbook"]')).toHaveCount(0);
  await expect(page.locator('footer a[href="/flash-sale"]')).toHaveCount(0);
  await expectVisualFoundationTokens(page);

  const mobileMenu = page.getByRole("button", { name: "Menu", exact: true });
  await expect(mobileMenu).toBeVisible();
  await mobileMenu.click();

  const mobileMenuDialog = page.getByRole("dialog", { name: "Menu điều hướng" });
  await expect(mobileMenuDialog).toBeVisible();

  const mobileNavigation = page.getByRole("navigation", { name: "Điều hướng chính trên di động" });
  for (const label of ["Áo dài", "Set đồ", "Váy, đầm", "Phụ kiện", "Hàng mới về", "Bộ sưu tập", "Sale"]) {
    await expect(mobileNavigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(mobileNavigation.getByRole("link", { name: "Cửa hàng", exact: true })).toHaveCount(0);
  await expect(mobileNavigation.getByRole("link", { name: "Lookbook", exact: true })).toHaveCount(0);
  await expect(mobileNavigation.getByRole("button", { name: "Tìm kiếm", exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Tài khoản", exact: true })).toBeVisible();

  // Verify Escape closes mobile nav and restores focus to hamburger trigger
  await page.keyboard.press("Escape");
  await expect(mobileMenuDialog).toHaveCount(0);
  await expect(mobileMenu).toBeFocused();

  // Re-open and test close button dismissal and focus restoration
  await mobileMenu.click();
  await expect(mobileMenuDialog).toBeVisible();
  const closeMenuBtn = page.getByRole("button", { name: "Đóng menu", exact: true });
  await expect(closeMenuBtn).toBeVisible();
  await closeMenuBtn.click();
  await expect(mobileMenuDialog).toHaveCount(0);
  await expect(mobileMenu).toBeFocused();

  await page.reload({ waitUntil: "networkidle" });
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Bỏ qua đến nội dung chính" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  const focusStyle = await skipLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).not.toBe("0px");
  await expectRuntimePageClean(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: "networkidle" });
  const desktopNavigation = page.getByRole("navigation", { name: "Điều hướng chính" });
  await expect(desktopNavigation).toBeVisible();
  for (const label of ["Áo dài", "Set đồ", "Váy, đầm", "Phụ kiện", "Hàng mới về", "Bộ sưu tập", "Sale"]) {
    await expect(desktopNavigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(desktopNavigation.getByRole("link", { name: "Cửa hàng", exact: true })).toHaveCount(0);
  await expect(desktopNavigation.getByRole("link", { name: "Lookbook", exact: true })).toHaveCount(0);
  const utilityNavigation = page.getByRole("navigation", { name: "Tiện ích" });
  await expect(utilityNavigation.getByRole("button", { name: "Tìm kiếm", exact: true })).toBeVisible();
  await expect(utilityNavigation.getByRole("link", { name: "Tài khoản", exact: true })).toBeVisible();
  await expect(utilityNavigation.getByRole("button", { name: "Giỏ hàng", exact: true })).toBeVisible();
  await expect(page.locator(".mobile-nav")).toBeHidden();
  await expectRuntimePageClean(page);

  await page.goto(`${BASE_URL}/account`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "TÀI KHOẢN" })).toBeVisible();
  await expect(page).toHaveTitle(/Tài khoản/);
  await expectRuntimePageClean(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("V1 accepts remaining buyer surfaces on mobile and desktop", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  const viewports = [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ] as const;
  const routes = [
    { path: "/", label: "homepage" },
    { path: "/shop", label: "PLP" },
    { path: "/about", label: "about" },
    { path: "/contact", label: "contact" },
    { path: "/shipping", label: "shipping policy" },
    { path: "/returns", label: "returns policy" },
    { path: "/size-guide", label: "size guide" },
    { path: "/policies", label: "policy hub" },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of routes) {
      browserErrors.length = 0;
      failedResponses.length = 0;

      const response = await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "networkidle" });
      expect(response?.status(), `${viewport.name} ${route.label} response`).toBe(200);

      const main = page.locator("main");
      await expect(main, `${viewport.name} ${route.label} main`).toBeVisible();
      await expect(main.locator("h1").first(), `${viewport.name} ${route.label} h1`).toBeAttached();

      const overflow = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
      expect(
        overflow.documentWidth,
        `${viewport.name} ${route.label} horizontal overflow`,
      ).toBeLessThanOrEqual(overflow.viewportWidth + 1);

      const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
      expect(
        accessibility.violations,
        `${viewport.name} ${route.label} Axe violations`,
      ).toEqual([]);

      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => document.activeElement?.tagName),
        `${viewport.name} ${route.label} keyboard focus`,
      ).not.toBe("BODY");

      if (route.path === "/shop") {
        const search = page.getByRole("searchbox", { name: "Tìm sản phẩm" });
        await search.fill("Editorial Runtime");
        await Promise.all([
          page.waitForURL((url) => url.pathname === "/shop" && url.searchParams.get("q") === "Editorial Runtime"),
          page.getByRole("button", { name: "Áp dụng", exact: true }).click(),
        ]);
        await expect(page.getByRole("heading", { level: 1, name: "CỬA HÀNG" })).toBeVisible();
      }

      expect(browserErrors, `${viewport.name} ${route.label} console/page errors`).toEqual([]);
      expect(failedResponses, `${viewport.name} ${route.label} failed requests`).toEqual([]);
    }
  }
});

test("V1 search overlay keeps keyboard focus, closes cleanly, and works from desktop and mobile navigation", async ({ page }) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const trigger =
      viewport.name === "mobile"
        ? page.getByRole("button", { name: "Menu", exact: true })
        : page.getByRole("navigation", { name: "Tiện ích" }).getByRole("button", {
            name: "Tìm kiếm",
            exact: true,
          });

    if (viewport.name === "mobile") {
      await trigger.click();
      const mobileDialog = page.getByRole("dialog", { name: "Menu điều hướng" });
      await expect(mobileDialog).toBeVisible();
      await mobileDialog.getByRole("button", { name: "Tìm kiếm", exact: true }).click();
      await expect(mobileDialog).toHaveCount(0);
    } else {
      await trigger.click();
    }

    const dialog = page.getByRole("dialog", { name: "Tìm kiếm sản phẩm" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("searchbox", { name: "Nhập từ khóa tìm kiếm" });
    await expect(input).toBeFocused();

    await input.fill("Editorial Runtime");
    await expect(
      dialog.getByRole("link", { name: /Xem tất cả kết quả cho/ }),
    ).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("U1a search entry hands q to Shop and new arrivals is Vietnamese-first", async ({ page }) => {
  const searchResponse = await page.goto(`${BASE_URL}/search`, { waitUntil: "networkidle" });
  expect(searchResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page).toHaveTitle(/Tìm kiếm/);
  await expect(page.getByRole("heading", { level: 1, name: "TÌM KIẾM" })).toBeVisible();

  const searchForm = page.getByRole("search");
  await expect(searchForm).toHaveAttribute("action", "/shop");
  const searchInput = page.getByRole("searchbox", { name: "Tìm sản phẩm" });
  await expect(searchInput).toHaveAttribute("name", "q");
  await searchInput.fill("Oxford");
  await Promise.all([
    page.waitForURL(`${BASE_URL}/shop?q=Oxford`),
    searchForm.getByRole("button", { name: "Tìm kiếm", exact: true }).click(),
  ]);
  expect(page.url()).toBe(`${BASE_URL}/shop?q=Oxford`);

  const sitemapResponse = await page.request.get(`${BASE_URL}/sitemap.xml`);
  expect(sitemapResponse.ok()).toBe(true);
  expect(await sitemapResponse.text()).not.toContain("/search");

  await page.goto(`${BASE_URL}/new-arrivals`, { waitUntil: "networkidle" });
  await expect(page).toHaveTitle(/Hàng mới/);
  await expect(page.getByRole("heading", { level: 1, name: "HÀNG MỚI" })).toBeVisible();
  await expect(
    page.getByText(
      "Những phom dáng, chất liệu và lớp trang phục theo mùa mới nhất — được ra mắt với số lượng chọn lọc.",
      { exact: true },
    ),
  ).toBeVisible();
  await expectRuntimePageClean(page);
});

test("homepage uses the configured local catalog while retired Lookbook is absent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  // The page's one h1 is the approved homepage title, carried outside the hero: master spec §17
  // puts image and CTA on a slide and no heading over the campaign art.
  await expect(page.locator("h1")).toHaveCount(1);
  // This fixture publishes no collection hero media, so the hero region is absent rather than
  // rendered against a product photo the way the retired campaign block was.
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);
  // Master spec §16's first product grid. `Tuyển chọn` and the Brand #1 lookbook block are gone:
  // neither is in the approved order.
  await expect(page.getByRole("heading", { level: 2, name: "Hàng mới về" })).toBeVisible();
  // No `Xem tất cả` out of this grid. `/new-arrivals` is the drop announcement and carries no
  // product listing, so that CTA sent a shopper asking for more products to a page with none.
  // Pinned as an absence rather than deleted, so it cannot come back before that route has a
  // listing to land on.
  await expect(page.getByRole("link", { name: "Xem tất cả", exact: true })).toHaveCount(0);
  await expect(
    page.locator('[data-homepage-region="new-arrivals"] a[href="/new-arrivals"]'),
  ).toHaveCount(0);
  await expect(page.locator(".lookbook-panel")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Tuyển chọn" })).toHaveCount(0);
  await expect(page.locator('a[href="/lookbook"]')).toHaveCount(0);

  // §22: exactly these three facts, and the brand story links to /about.
  const serviceStrip = page.locator('[data-homepage-region="service"]');
  await expect(serviceStrip.getByRole("listitem")).toHaveCount(3);
  await expect(serviceStrip.getByText("Đổi trả trong 15 ngày", { exact: true })).toBeVisible();
  await expect(serviceStrip.getByText("Giao hàng toàn quốc", { exact: true })).toBeVisible();
  await expect(serviceStrip.getByText("Tư vấn size 08:00–22:00", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Về La.na Design ↗" })).toHaveAttribute(
    "href",
    "/about",
  );

  // §19 and §21 depend on category editorial media this fixture does not configure, and §20 on a
  // manual Featured selection it does not make, so all three omit themselves.
  await expect(page.locator('[data-homepage-region="lead-category"]')).toHaveCount(0);
  await expect(page.locator('[data-homepage-region="featured"]')).toHaveCount(0);
  await expect(page.locator('[data-homepage-region="category-editorial"]')).toHaveCount(0);

  const brandFactsNavigation = page.getByRole("navigation", { name: "Hỗ trợ và khám phá" });
  await expect(brandFactsNavigation.getByRole("link", { name: "Cửa hàng ↗" })).toHaveAttribute("href", "/shop");
  await expect(brandFactsNavigation.getByRole("link", { name: "Bộ sưu tập ↗" })).toHaveAttribute("href", "/collections");
  await expect(brandFactsNavigation.getByRole("link", { name: "Tra cứu đơn ↗" })).toHaveAttribute("href", "/track-order");
  await expect(page.getByText("Mua theo danh mục", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Danh mục sản phẩm" })).toHaveCount(0);
  await expect(page.getByText("Mua theo bộ sưu tập", { exact: true })).toBeVisible();

  const collectionNavigation = page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" });
  await expect(collectionNavigation).toBeVisible();
  await expect(collectionNavigation.getByRole("link", { name: "Essential Outerwear", exact: true })).toHaveAttribute(
    "href",
    "/collections/essential-outerwear",
  );
  await expect(page.getByText("Draft Capsule", { exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: productName })).toBeVisible();
  await expect(page.getByRole("link", { name: `Xem ${productName}` })).toHaveAttribute("href", `/shop/${productSlug}`);
  await expect(page.getByText("Runtime editorial layer for the city uniform.")).toHaveCount(0);
  await expect(page.getByText("Có sẵn", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1.290.000")).toBeVisible();
  await expect(page.getByText("Fall / Winter 2026")).toHaveCount(0);
  await expect(page.getByText("Relaxed Oxford Shirt")).toHaveCount(0);
  await expectRuntimePageClean(page);

  const lookbookResponse = await page.request.get(`${BASE_URL}/lookbook`);
  expect(lookbookResponse.status()).toBe(404);

  await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "BỘ SƯU TẬP" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Essential Outerwear" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Khám phá bộ sưu tập ↗" })).toHaveAttribute(
    "href",
    "/collections/essential-outerwear",
  );
  await expect(page.getByText("Fall / Winter 2026")).toHaveCount(0);
  await expect(page.getByText("EVERYDAY UNIFORM")).toHaveCount(0);
  await expectRuntimePageClean(page);

  await page.goto(`${BASE_URL}/collections/essential-outerwear`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Essential Outerwear" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: productName })).toBeVisible();
  await expectRuntimePageClean(page);

  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  await expect(page.getByRole("link", { name: "Essential Outerwear" })).toHaveAttribute("href", "/collections/essential-outerwear");
  await expect(page.getByRole("link", { name: /draft capsule/i })).toHaveCount(0);
  await expect(page.getByText("Draft Capsule")).toHaveCount(0);
  await expect(page.getByText("Runtime editorial layer for the city uniform.")).toBeVisible();

  const addToBag = page.getByRole("button", { name: "Thêm vào giỏ hàng" });
  await expect(addToBag).toBeEnabled();
  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Ink" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M" })).toBeChecked();
  await expect(addToBag).toBeEnabled();
  await addToBag.click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  await page.getByRole("link", { name: "Essential Outerwear" }).click();
  await page.waitForURL("**/collections/essential-outerwear");
  await expect(page.getByRole("heading", { level: 1, name: "Essential Outerwear" })).toBeVisible();
  await expectRuntimePageClean(page);
});

test("P8 homepage empty state uses the shared semantic state pattern and degrades gracefully", async ({ page }) => {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  const emptyState = page.locator('[data-ui-state="empty"]');
  await expect(emptyState).toBeVisible();
  await expect(
    emptyState.getByText("Sản phẩm sẽ xuất hiện tại đây khi sẵn sàng để hiển thị trên website.", { exact: true }),
  ).toBeVisible();
  // An empty catalog empties the grid, not the page: the approved copy sections stay.
  await expect(page.getByRole("heading", { level: 2, name: "Hàng mới về" })).toBeVisible();
  await expect(page.locator('[data-homepage-region="service"]').getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);
  await expect(page.locator(".lookbook-panel")).toHaveCount(0);
  await expect(page.locator('a[href="/lookbook"]')).toHaveCount(0);
  await expectRuntimePageClean(page);
});
