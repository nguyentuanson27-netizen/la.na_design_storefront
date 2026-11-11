import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { HOMEPAGE_CONFIG } from "../../src/content/homepage.config.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { seedFeedbackMirror } from "./feedback-mirror-fixture";
import { OPTIMIZED_IMAGE_ROUTE } from "./image-routes";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * Hand-entered customer reviews on the product page: the rating line under the name, the photograph
 * strip under the price, the review section (summary, filters, "Xem thêm", photograph viewer), and
 * what must NOT appear -- an average below the minimum, a hidden review, a verified label that no
 * order earned, or any structured-data rating.
 */

const HOST = "127.0.0.1";
const PORT = 3493;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_552;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-11-01T00:00:00.000Z");
const reviewedAt = (day: number) => new Date(Date.UTC(2026, 9, day, 5, 0, 0));
const photo = (n: number) => `https://content.pancake.vn/2-2611/2026/11/8/pdp-review-${n}.jpg`;

const BRAND_URLS = HOMEPAGE_CONFIG.feedback.images.slice(0, 4).map((image) => image.src);

const products = {
  rich: { slug: `pdp-reviews-rich-${runId}`, name: `PDP Reviews Rich ${runId}`, code: "RVRICH1" },
  few: { slug: `pdp-reviews-few-${runId}`, name: `PDP Reviews Few ${runId}`, code: "RVFEW2" },
  none: { slug: `pdp-reviews-none-${runId}`, name: `PDP Reviews None ${runId}`, code: "RVNONE3" },
} as const;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js PDP reviews server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${products.rich.slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(products.rich.name)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for PDP reviews server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(5_000)]);
  }
  server = undefined;
}

async function cleanup() {
  await prisma.cartItem.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP_ID } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function createProduct({ slug, name, code }: { slug: string; name: string; code: string }) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `${slug}-product`,
      slug,
      name,
      productCode: code,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: "Mô tả thử nghiệm.", sizeGuide: "ao-dai" } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Hồng",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${slug}-warehouse`, quantity: 2, syncedAt },
  });
  return product.id;
}

type SeedReview = {
  rating: number;
  authorName: string;
  body?: string;
  source?: "ZALO" | "MESSENGER" | "FACEBOOK" | "DIRECT";
  fit?: "SMALL" | "TRUE_TO_SIZE" | "LARGE";
  imageUrls?: string[];
  orderPublicCode?: string;
  shopReply?: string;
  status?: "DRAFT" | "PUBLISHED";
  day: number;
};

async function seedReviews(productId: string, reviews: readonly SeedReview[]) {
  for (const review of reviews) {
    await prisma.productReview.create({
      data: {
        productId,
        status: review.status ?? "PUBLISHED",
        rating: review.rating,
        authorName: review.authorName,
        body: review.body ?? "Đẹp, mặc vừa vặn.",
        source: review.source ?? "ZALO",
        fit: review.fit ?? null,
        sizeLabel: "M",
        colorLabel: "Hồng",
        heightCm: 160,
        weightKg: 52,
        imageUrls: review.imageUrls ?? [],
        orderPublicCode: review.orderPublicCode ?? null,
        shopReply: review.shopReply ?? null,
        reviewedAt: reviewedAt(review.day),
        consentConfirmedAt: syncedAt,
      },
    });
  }
}

async function assertPageQuality(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);
}

const section = (page: Page) => page.locator("#pdp-reviews");
const cards = (page: Page) => section(page).locator("[data-review-id]");

test.beforeAll(async () => {
  await cleanup();
  await seedFeedbackMirror(prisma, { shopId: SHOP_ID, runId, urls: BRAND_URLS });
  const ids = {
    rich: await createProduct(products.rich),
    few: await createProduct(products.few),
    none: await createProduct(products.none),
  };

  // Seven published reviews (average 32 / 7 = 4,6), three with photographs (six photographs), one
  // verified, one answered by the shop; plus a draft that must never be shown.
  await seedReviews(ids.rich, [
    { rating: 5, authorName: "Lan A.", day: 28, source: "ZALO", fit: "TRUE_TO_SIZE", imageUrls: [photo(1), photo(2)], orderPublicCode: "LN-VERIFIED-1", shopReply: "Cảm ơn nàng đã tin chọn." },
    { rating: 5, authorName: "Minh T.", day: 27, source: "MESSENGER", fit: "TRUE_TO_SIZE", imageUrls: [photo(3), photo(4)] },
    { rating: 5, authorName: "Hoa N.", day: 26, source: "FACEBOOK", fit: "SMALL", imageUrls: [photo(5), photo(6)] },
    { rating: 5, authorName: "Thu P.", day: 25, fit: "TRUE_TO_SIZE" },
    { rating: 4, authorName: "Mai L.", day: 24, fit: "LARGE" },
    { rating: 3, authorName: "Vy D.", day: 23, source: "DIRECT" },
    { rating: 5, authorName: "Ngọc B.", day: 22 },
    { rating: 1, authorName: "Nháp Ẩn", day: 21, status: "DRAFT", body: "Nội dung đang ẩn không được hiện." },
  ]);
  // Two reviews: enough to show, too few to average.
  await seedReviews(ids.few, [
    { rating: 5, authorName: "An K.", day: 20 },
    { rating: 5, authorName: "Bình Q.", day: 19 },
  ]);

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/pdp-reviews"),
      APP_DOMAIN: `${HOST}:${PORT}`,
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

test.beforeEach(async ({ page }) => {
  await page.route(OPTIMIZED_IMAGE_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }),
  );
});

test("a product with reviews shows the rating under its name and its own photographs under the price", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });

  const rating = page.locator("[data-pdp-rating]");
  await expect(rating).toBeVisible();
  await expect(rating).toHaveAttribute("href", "#pdp-reviews");
  await expect(rating).toContainText("4,6");
  await expect(rating).toContainText("7 đánh giá");
  await expect(rating).toContainText("3 có ảnh");
  await expect(rating.getByRole("img", { name: "4,6 trên 5 sao" })).toBeVisible();

  const strip = page.locator("[data-pdp-photo-strip]");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Đánh giá sản phẩm");
  await expect(strip).toContainText("6 ảnh thật");
  await expect(strip).toHaveAttribute("href", "#pdp-review-photos");

  // The strip sits under the price and above the purchase buttons.
  const priceBox = await page.getByText("1.290.000", { exact: false }).first().boundingBox();
  const stripBox = await strip.boundingBox();
  const buyBox = await page.getByRole("button", { name: /Mua ngay/ }).first().boundingBox();
  expect(stripBox!.y).toBeGreaterThan(priceBox!.y);
  expect(stripBox!.y).toBeLessThan(buyBox!.y);

  await assertPageQuality(page);
});

test("the review section computes its summary from the published reviews and hides the draft", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });

  await expect(section(page).getByRole("heading", { level: 2, name: "Đánh giá sản phẩm" })).toBeVisible();
  const summary = section(page).locator("[data-review-summary]");
  await expect(summary).toContainText("4,6");
  await expect(summary).toContainText("7 đánh giá");
  // The star breakdown is folded away so the reviews and photographs come first; opening shows it.
  const breakdown = summary.locator("[data-review-breakdown]");
  await expect(breakdown).not.toHaveAttribute("open", "");
  await breakdown.getByText("Xem theo từng mức sao").click();
  const histogram = summary.getByRole("list", { name: "Số đánh giá theo từng mức sao" });
  await expect(histogram.getByRole("listitem")).toHaveCount(5);
  await expect(histogram.getByRole("listitem").first()).toContainText("5 sao");
  await expect(histogram.getByRole("listitem").first()).toContainText("5");

  await expect(section(page).locator("[data-review-fit]")).toContainText("Vừa vặn 60%");
  await expect(page.getByText("Nháp Ẩn")).toHaveCount(0);
  await expect(page.getByText("Nội dung đang ẩn không được hiện.")).toHaveCount(0);
});

test("a review is labelled with where it came from, and Đã mua hàng only when an order backs it", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });

  const first = cards(page).first();
  await expect(first).toContainText("Lan A.");
  await expect(first).toContainText("28/10/2026");
  await expect(first).toContainText("✓ Đã mua hàng");
  await expect(first).toContainText("Gửi qua Zalo");
  await expect(first).toContainText("Size M · Hồng · cao 1m60, 52kg · Vừa vặn");
  await expect(first).toContainText("trả lời");
  await expect(first).toContainText("Cảm ơn nàng đã tin chọn.");

  await expect(section(page).getByText("✓ Đã mua hàng")).toHaveCount(1);
  await expect(cards(page).nth(1)).toContainText("Gửi qua Messenger");
  await expect(cards(page).nth(2)).toContainText("Bình luận trên Facebook");
});

test("filters and Xem thêm narrow and extend the list without a reload", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });

  await expect(cards(page)).toHaveCount(5);
  await section(page).getByRole("button", { name: /^Xem thêm đánh giá/ }).click();
  await expect(cards(page)).toHaveCount(7);
  await expect(section(page).getByRole("button", { name: /^Xem thêm đánh giá/ })).toHaveCount(0);

  const filters = section(page).getByRole("group", { name: "Lọc đánh giá" });
  await filters.getByRole("button", { name: "Có ảnh (3)" }).click();
  await expect(filters.getByRole("button", { name: "Có ảnh (3)" })).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(3);
  await filters.getByRole("button", { name: "3 sao trở xuống (1)" }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Vy D.");
  await filters.getByRole("button", { name: "Tất cả (7)" }).click();
  await expect(cards(page)).toHaveCount(5);
});

test("the product's own photographs rail replaces the shared brand gallery and opens a viewer", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });

  const rails = page.locator('[data-pdp-region="feedback"]');
  await expect(rails).toHaveCount(1);
  // The rail sits under the "Đánh giá sản phẩm" heading, so its own heading is kept for assistive
  // technology only and draws no visible text.
  const railHeading = rails.getByRole("heading", { level: 2, name: "Ảnh khách diện mẫu này" });
  await expect(railHeading).toHaveCount(1);
  await expect(railHeading).toHaveClass(/sr-only/);
  await expect(rails.getByRole("button", { name: /^Phóng to ảnh/ })).toHaveCount(6);
  // The shared brand gallery and the link to it would say the same thing about no product in particular.
  await expect(page.getByRole("heading", { name: "Khách hàng & La.na" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /ảnh khách hàng diện/i })).toHaveCount(0);

  // A photograph inside a review enlarges, steps and closes with the keyboard.
  const opener = cards(page).first().getByRole("button", { name: /^Phóng to ảnh 1 trong 2/ });
  await opener.click();
  const viewer = page.getByRole("dialog", { name: "Ảnh trong đánh giá" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("2 / 2");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a rating or review never reaches the product's structured data", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.rich.slug}`, { waitUntil: "networkidle" });
  const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(jsonLd.length).toBeGreaterThan(0);
  for (const block of jsonLd) {
    expect(block).not.toContain("aggregateRating");
    expect(block).not.toContain('"Review"');
    expect(block).not.toContain("ratingValue");
  }
});

test("with too few reviews the page lists them but claims no average, filter or photograph strip", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.few.slug}`, { waitUntil: "networkidle" });

  const rating = page.locator("[data-pdp-rating]");
  await expect(rating).toContainText("2 đánh giá");
  await expect(rating.getByRole("img")).toHaveCount(0);
  // No review photographs of its own, so no strip under the price (the shared gallery stays at the bottom).
  await expect(page.locator("[data-pdp-photo-strip]")).toHaveCount(0);
  await expect(section(page).locator("[data-review-summary]")).toHaveCount(0);
  await expect(section(page).getByRole("group", { name: "Lọc đánh giá" })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
  await assertPageQuality(page);
});

test("a product with no reviews has no strip under the price, only the shared gallery at the bottom", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${products.none.slug}`, { waitUntil: "networkidle" });

  await expect(page.locator("[data-pdp-rating]")).toHaveCount(0);
  await expect(page.locator("#pdp-reviews")).toHaveCount(0);
  await expect(page.locator("[data-pdp-photo-strip]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Xem ảnh khách hàng diện/ })).toHaveCount(0);

  // The shared brand rail is still there, at the bottom of the page.
  await expect(page.locator('[data-pdp-region="feedback"]')).toHaveCount(1);
  await expect(page.locator("#pdp-feedback")).toBeAttached();
  await assertPageQuality(page);
});
