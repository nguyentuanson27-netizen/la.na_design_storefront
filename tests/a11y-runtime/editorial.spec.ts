import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3312;
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

const CATEGORY_KEYS = ["aoDai", "vayDam", "setDo", "phuKien"] as const;

type ParkedCategoryMedia = {
  categoryKey: string;
  heroImageUrl: string | null;
  megaMenuImageUrl: string | null;
};

/** `null` marks a key that had no row, so restoring it means removing the fixture again. */
let parkedCategoryMedia = new Map<string, ParkedCategoryMedia | null>();

/**
 * The homepage's one DB-owned editorial section is YOUR NEXT FAVOURITE, and several tests here
 * scroll the homepage to exercise the header and promotion states -- which needs a page with real
 * content below the fold. Its four category images are written the way the composition spec does:
 * snapshot first, upsert only the hero, and put back exactly what was there afterwards.
 */
async function parkCategoryMedia() {
  const existing = await prisma.categoryEditorialMedia.findMany({
    where: { categoryKey: { in: [...CATEGORY_KEYS] } },
    select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
  });
  parkedCategoryMedia = new Map(CATEGORY_KEYS.map((key) => [key as string, null]));
  for (const row of existing) parkedCategoryMedia.set(row.categoryKey, row);

  for (const categoryKey of CATEGORY_KEYS) {
    const heroImageUrl = `https://content.pancake.vn/images/1/2/3/editorial-${categoryKey}.jpg`;
    await prisma.categoryEditorialMedia.upsert({
      where: { categoryKey },
      update: { heroImageUrl },
      create: { categoryKey, heroImageUrl },
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
  expect(tokens.mediaProductRatio.replace(/\s+/g, "")).toBe("2/3");

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

  await parkCategoryMedia();

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
  await restoreCategoryMedia();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
});

test("mobile navigation is a true viewport overlay before and after header scroll styling", async ({
  page,
}) => {
  await prisma.collectionDefinition.update({
    where: { slug: "essential-outerwear" },
    data: { heroImageUrl: "https://content.pancake.vn/images/1/2/3/mobile-nav-hero.jpg" },
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toBeVisible();

    const menuTrigger = page.getByRole("button", { name: "Menu", exact: true });

    for (const scrollTop of [0, 120] as const) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), scrollTop);
      await expect
        .poll(() => page.evaluate(() => Math.round(window.scrollY)))
        .toBe(scrollTop);

      const header = page.locator("header.site-header");
      await expect(header).toHaveAttribute(
        "data-scrolled",
        scrollTop > 20 ? "true" : "false",
      );
      const headerBackground = await header.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      if (scrollTop === 0) {
        expect(headerBackground).toBe("rgba(0, 0, 0, 0)");
      } else {
        expect(headerBackground).not.toBe("rgba(0, 0, 0, 0)");
      }

      await menuTrigger.click();

      const dialog = page.getByRole("dialog", { name: "Menu điều hướng" });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);

      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.x)).toBe(0);
      expect(Math.round(box!.y)).toBe(0);
      expect(Math.round(box!.width)).toBe(390);
      expect(Math.round(box!.height)).toBe(844);

      await expect(dialog.locator("img.brand-mark-logo").first()).toBeVisible();
      const closeButton = dialog.getByRole("button", { name: "Đóng menu", exact: true });
      await expect(closeButton).toBeVisible();

      const primaryNavigation = dialog.getByRole("navigation", {
        name: "Điều hướng chính trên di động",
      });
      for (const label of [
        "Áo dài",
        "Set đồ",
        "Váy, đầm",
        "Phụ kiện",
        "Hàng mới về",
        "Bộ sưu tập",
        "Sale",
      ]) {
        await expect(
          primaryNavigation.getByRole("link", { name: label, exact: true }),
        ).toBeVisible();
      }

      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      const lockedPageScrollY = await page.evaluate(() => window.scrollY);
      await page.mouse.move(380, 820);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.scrollY)).toBe(lockedPageScrollY);

      const menuScrollState = await dialog.evaluate((element) => {
        const overflowY = getComputedStyle(element).overflowY;
        const scrollable = element.scrollHeight > element.clientHeight;
        if (scrollable) {
          element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
        }
        return { overflowY, scrollable, scrollTop: element.scrollTop };
      });
      expect(["auto", "scroll"]).toContain(menuScrollState.overflowY);
      if (menuScrollState.scrollable) {
        expect(menuScrollState.scrollTop).toBeGreaterThan(0);
      }

      await closeButton.click();
      await expect(dialog).toHaveCount(0);
      await expect(menuTrigger).toBeFocused();
    }
  } finally {
    await prisma.collectionDefinition.update({
      where: { slug: "essential-outerwear" },
      data: { heroImageUrl: null },
    });
  }
});

test("mobile search opened from scrolled navigation remains a true viewport dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await page.evaluate(() => window.scrollTo({ top: 120, behavior: "instant" }));
  // The homepage promotion joins the fixed masthead after the 20px threshold. Chromium may
  // compensate the scroll position when that overlay gains height, so the regression contract is
  // "scrolled past the threshold", not an invariant physical scrollY of exactly 120px.
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(20);

  const header = page.locator("header.site-header");
  await expect(header).toHaveAttribute("data-scrolled", "true");

  const menuTrigger = page.getByRole("button", { name: "Menu", exact: true });
  await menuTrigger.click();

  const mobileDialog = page.getByRole("dialog", { name: "Menu điều hướng" });
  await expect(mobileDialog).toBeVisible();
  await mobileDialog.getByRole("button", { name: "Tìm kiếm", exact: true }).click();
  await expect(mobileDialog).toHaveCount(0);

  const searchDialog = page.getByRole("dialog", { name: "Tìm kiếm sản phẩm" });
  await expect(searchDialog).toBeVisible();
  expect(await searchDialog.evaluate((element) => element.parentElement === document.body)).toBe(true);

  const box = await searchDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.y)).toBe(0);
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.height)).toBe(844);

  const input = searchDialog.getByRole("searchbox", { name: "Nhập từ khóa tìm kiếm" });
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(searchDialog).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
});

test("mobile cart opened from scrolled navigation remains a true viewport drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await page.evaluate(() => window.scrollTo({ top: 120, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(20);

  const header = page.locator("header.site-header");
  await expect(header).toHaveAttribute("data-scrolled", "true");

  await page.getByRole("button", { name: "Giỏ hàng", exact: true }).click();

  const cartOverlay = page.getByRole("region", { name: "Giỏ hàng" });
  const cartDialog = page.getByRole("dialog", { name: "Giỏ hàng" });
  await expect(cartDialog).toBeVisible();

  // The cart must escape the scrolled/backdrop-filtered header containing block and own the viewport.
  expect(await cartOverlay.evaluate((element) => element.parentElement === document.body)).toBe(true);

  const box = await cartOverlay.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.y)).toBe(0);
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.height)).toBe(844);

  await expect(cartDialog.getByRole("button", { name: "Đóng giỏ hàng", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(cartDialog).toHaveCount(0);
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
  // DOM locator is intentional: the homepage contract removes the promotion from the
  // accessibility tree with display:none while keeping the element mounted for the scrolled state.
  const shippingPromotion = page.locator(".promotion-shell");
  await expect(shippingPromotion).toBeHidden();
  await expect(shippingPromotion).toHaveClass(/promotion-shell/);
  await expect(shippingPromotion).toContainText("Free ship từ 4 sản phẩm hoặc đơn trên 750 nghìn");
  expect(await shippingPromotion.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(400);
  await expect(shippingPromotion).toBeVisible();
  expect(await shippingPromotion.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => {
      const masthead = document.querySelector(".site-masthead");
      if (!masthead) return null;
      const { top } = masthead.getBoundingClientRect();
      return { top: Math.round(top), pinned: document.elementFromPoint(5, 5)?.className ?? null };
    }),
  ).toEqual({ top: 0, pinned: "promotion-shell" });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(0);
  await expect(shippingPromotion).toBeHidden();
  expect(await shippingPromotion.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
  await expect(page.getByText("FALL / WINTER — NEW COLLECTION", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "La.na Design — Trang chủ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Giỏ hàng", exact: true })).toBeVisible();

  // This project runs at 390px, where the footer's link columns are disclosures. The shopping
  // group opens before its links are asserted; footer-support.spec.ts owns the collapsed state.
  await page.locator("footer").getByRole("button", { name: "Mua sắm", exact: true }).click();
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

  // Subcategories start collapsed and open under their own category, one at a time.
  await expect(mobileNavigation.getByRole("link", { name: "Áo dài Tết", exact: true })).toHaveCount(0);
  const aoDaiDisclosure = mobileNavigation.getByRole("button", { name: "Mở rộng Áo dài", exact: true });
  await expect(aoDaiDisclosure).toHaveAttribute("aria-expanded", "false");
  await aoDaiDisclosure.click();
  await expect(mobileNavigation.getByRole("link", { name: "Áo dài Tết", exact: true })).toBeVisible();

  await mobileNavigation.getByRole("button", { name: "Mở rộng Set đồ", exact: true }).click();
  await expect(mobileNavigation.getByRole("link", { name: "Set váy", exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Áo dài Tết", exact: true })).toHaveCount(0);

  await mobileNavigation.getByRole("button", { name: "Thu gọn Set đồ", exact: true }).click();
  await expect(mobileNavigation.getByRole("link", { name: "Set váy", exact: true })).toHaveCount(0);
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
        const shopBuyerNotice = page
          .locator("main p")
          .filter({
            hasText: "Giá và tình trạng còn hàng được kiểm tra lại trước khi mua.",
          })
          .first();
        await expect(
          shopBuyerNotice,
          `${viewport.name} shop buyer notice`,
        ).toBeVisible();

        const search = page.getByRole("searchbox", { name: "Tìm sản phẩm" });
        await search.fill("Editorial Runtime");

        const submit =
          viewport.name === "mobile"
            ? async () => {
                await page.getByRole("button", { name: /Bộ lọc/ }).click();
                const dialog = page.getByRole("dialog", { name: "Bộ lọc" });
                await expect(dialog).toBeVisible();
                await dialog.getByRole("button", { name: "Áp dụng", exact: true }).click();
              }
            : async () => {
                await page.getByRole("button", { name: "Áp dụng", exact: true }).click();
              };

        await Promise.all([
          page.waitForURL((url) => url.pathname === "/shop" && url.searchParams.get("q") === "Editorial Runtime"),
          submit(),
        ]);
        await expect(page.getByRole("heading", { level: 1, name: "Cửa hàng" })).toBeVisible();
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
  // Master spec §10 keeps /new-arrivals and says it shows newest products automatically, so the
  // heading is the listing's, in the same serif hierarchy every other listing uses.
  await expect(page.getByRole("heading", { level: 1, name: "Hàng mới về" })).toBeVisible();
  await expect(
    page.getByText(
      "Những phom dáng, chất liệu và lớp trang phục theo mùa mới nhất — được ra mắt với số lượng chọn lọc.",
      { exact: true },
    ),
  ).toBeVisible();
  await expectRuntimePageClean(page);
});

test("homepage carries only the refreshed composition while retired Lookbook and old sections are absent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  // The page's one h1 is the approved homepage title, carried outside the hero: master spec §17
  // puts image and CTA on a slide and no heading over the campaign art.
  await expect(page.locator("h1")).toHaveCount(1);
  // This fixture publishes no collection hero media, so the hero region is absent rather than
  // rendered against a product photo the way the retired campaign block was.
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);

  // The homepage editorial refresh retired every old lower-homepage section. None may return.
  await expect(page.getByRole("heading", { level: 2, name: "Hàng mới về" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Sản phẩm nổi bật" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Xem tất cả", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Về La.na Design ↗" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Hỗ trợ và khám phá" })).toHaveCount(0);
  await expect(page.getByText("Mua theo bộ sưu tập", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Bộ sưu tập nổi bật" })).toHaveCount(0);
  for (const region of [
    "new-arrivals",
    "lead-category",
    "featured",
    "category-editorial",
    "collection-navigation",
    "service",
    "trust-support",
  ]) {
    await expect(page.locator(`[data-homepage-region="${region}"]`)).toHaveCount(0);
  }
  await expect(page.locator(".lookbook-panel")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Tuyển chọn" })).toHaveCount(0);
  await expect(page.locator('a[href="/lookbook"]')).toHaveCount(0);

  // The refreshed sections are fail-closed on pending content: SPECIAL DEALS has no configured
  // source collection yet, the promo rows are unmapped and the feedback gallery is unsupplied, so
  // none of them renders a placeholder. YOUR NEXT FAVOURITE is DB-owned and this fixture
  // configures all four of its images, so it is the one refreshed section on the page.
  expect(
    await page
      .locator("[data-homepage-region]")
      .evaluateAll((regions) => regions.map((region) => region.getAttribute("data-homepage-region"))),
  ).toEqual(["category-discovery"]);
  await expect(page.locator('a[href*="category="]')).toHaveCount(0);
  await expect(page.getByText("Draft Capsule", { exact: true })).toHaveCount(0);
  await expectRuntimePageClean(page);

  const lookbookResponse = await page.request.get(`${BASE_URL}/lookbook`);
  expect(lookbookResponse.status()).toBe(404);

  await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Bộ sưu tập" })).toBeVisible();
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
  // The product-card assertions the retired homepage grid used to carry, on the listing that
  // still renders this product.
  await expect(page.getByRole("link", { name: `Xem ${productName}` })).toHaveAttribute("href", `/shop/${productSlug}`);
  await expect(page.getByText("1.290.000")).toBeVisible();
  await expect(page.getByText("Runtime editorial layer for the city uniform.")).toHaveCount(0);
  await expectRuntimePageClean(page);

  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
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

test("an empty catalog leaves the refreshed homepage without product grids or placeholder states", async ({ page }) => {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  // The retired `Hàng mới về` grid carried the homepage's empty state. SPECIAL DEALS does not have
  // one: with nothing real to show it is absent, never an empty or partial grid.
  await expect(page.locator('[data-ui-state="empty"]')).toHaveCount(0);
  await expect(page.locator(".product-grid")).toHaveCount(0);
  await expect(page.locator('[data-homepage-region="special-deals"]')).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Ảnh bìa trang chủ" })).toHaveCount(0);
  await expect(page.locator(".lookbook-panel")).toHaveCount(0);
  await expect(page.locator('a[href="/lookbook"]')).toHaveCount(0);
  await expectRuntimePageClean(page);
});
