import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { OPTIMIZED_IMAGE_ROUTE } from "./image-routes";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * The admin page where the shop enters real customer reviews: the consent statement is required,
 * a phone-number "name" and an untrusted photograph are refused with a message that names the
 * field, an order code earns "Đã mua hàng" only when a confirmed order holds this product, hiding
 * takes a review off the product page, and deleting is a second, deliberate step.
 */

const HOST = "127.0.0.1";
const PORT = 3494;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_553;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-11-01T00:00:00.000Z");
const adminEmail = `admin-reviews-${runId}@example.invalid`;
const password = "admin-reviews-runtime-password-123";
const photo = "https://content.pancake.vn/2-2611/2026/11/8/admin-review-1.jpg";
const orderCode = `RVADM-${runId}`;

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

let server: ChildProcess | undefined;
let serverOutput = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];
let productId = "";
let productSlug = "";
let otherSlug = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Better Auth returned a malformed Set-Cookie header");
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: BASE_URL };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js admin reviews server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for admin reviews server\n${serverOutput}`);
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
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: "RVADM-" } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.user.deleteMany({ where: { email: adminEmail } });
}

async function createProduct(key: string) {
  const slug = `admin-reviews-${key}-${runId}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `${slug}-product`,
      slug,
      name: `Admin Reviews ${key} ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: "Mô tả thử nghiệm." } },
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
      pancakeRetailPrice: 990_000,
      pancakeRetailPriceAfterDiscount: 990_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${slug}-warehouse`, quantity: 2, syncedAt },
  });
  return { id: product.id, slug, variantId: variant.id, variationId: variant.pancakeVariationId };
}

test.beforeAll(async () => {
  await cleanup();
  const own = await createProduct("own");
  const other = await createProduct("other");
  productId = own.id;
  productSlug = own.slug;
  otherSlug = other.slug;

  // A confirmed order that holds the first product only.
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: orderCode,
      state: "CONFIRMED",
      checkoutSnapshottedAt: syncedAt,
      guestName: "Khách",
      guestPhone: "0900000000",
      provinceRef: "1",
      districtRef: "2",
      communeRef: "3",
      addressDetail: "1 Phố Huế",
      note: "",
      merchandiseSubtotalVnd: BigInt(990_000),
      shippingFeeVnd: BigInt(0),
      totalVnd: BigInt(990_000),
    },
  });
  await prisma.orderLineSnapshot.create({
    data: {
      orderId: order.id,
      variantId: own.variantId,
      pancakeVariationId: own.variationId,
      metaContentId: own.slug,
      productName: "Váy",
      size: "M",
      quantity: 1,
      unitPriceVnd: BigInt(990_000),
      lineTotalVnd: BigInt(990_000),
    },
  });

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.37" }),
    body: { name: "Reviews Admin Runtime", email: adminEmail, password },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/admin-product-reviews"),
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      PANCAKE_SHOP_ID: String(SHOP_ID),
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

test("the shop enters, verifies, hides and deletes a real customer review", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.route(OPTIMIZED_IMAGE_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }),
  );
  const reviewsPath = `/admin/products/${productId}/reviews`;

  await page.goto(`${BASE_URL}${reviewsPath}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Admin Reviews own");
  await expect(page.getByRole("heading", { level: 2, name: "Thêm đánh giá" })).toBeVisible();
  await expect(page.getByText("Chưa có đánh giá nào cho sản phẩm này.")).toBeVisible();
  const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);

  // The consent statement is a required box: the browser itself stops a save without it.
  await page.getByLabel(/^Tên hiển thị/).fill("Lan A.");
  await page.getByLabel(/^Nội dung đánh giá/).fill("Vải mềm, lên form đẹp.");
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await expect(page).toHaveURL(`${BASE_URL}${reviewsPath}`);
  expect(await prisma.productReview.count({ where: { productId } })).toBe(0);

  // A phone number is not a display name; the message names the field and nothing is saved.
  await page.getByLabel(/^Tên hiển thị/).fill("0987654321");
  await page.getByLabel(/Khách đã đồng ý cho đăng/).check();
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await page.waitForURL((url) => url.searchParams.get("error") === "authorName");
  await expect(page.getByRole("alert").filter({ hasText: "Tên hiển thị chưa hợp lệ" })).toBeVisible();
  expect(await prisma.productReview.count({ where: { productId } })).toBe(0);

  // An untrusted photograph link is refused rather than silently dropped.
  await page.getByLabel(/^Tên hiển thị/).fill("Lan A.");
  await page.getByLabel(/^Nội dung đánh giá/).fill("Vải mềm, lên form đẹp.");
  await page.getByLabel(/Link ảnh khách/).fill("https://evil.example.com/a/b/c/d.jpg");
  await page.getByLabel(/Khách đã đồng ý cho đăng/).check();
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await page.waitForURL((url) => url.searchParams.get("error") === "imageUrls");
  await expect(page.getByRole("alert").filter({ hasText: "Link ảnh chưa hợp lệ" })).toBeVisible();

  // An order that does not exist cannot verify a review.
  await page.getByLabel(/^Tên hiển thị/).fill("Lan A.");
  await page.getByLabel(/^Nội dung đánh giá/).fill("Vải mềm, lên form đẹp.");
  await page.getByLabel(/Mã đơn hàng/).fill(`RVADM-missing-${runId}`);
  await page.getByLabel(/Khách đã đồng ý cho đăng/).check();
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await page.waitForURL((url) => url.searchParams.get("orderError") === "ORDER_NOT_FOUND");
  await expect(page.getByRole("alert").filter({ hasText: "Không tìm thấy đơn hàng" })).toBeVisible();
  expect(await prisma.productReview.count({ where: { productId } })).toBe(0);

  // The real thing: a review backed by this product's confirmed order, with a photograph.
  await page.getByLabel(/^Số sao/).selectOption("5");
  await page.getByLabel(/^Tên hiển thị/).fill("Lan A.");
  await page.getByLabel(/^Nội dung đánh giá/).fill("Vải mềm, lên form đẹp.");
  await page.getByLabel(/^Nguồn/).selectOption("ZALO");
  await page.getByLabel(/^Size đã mua/).fill("M");
  await page.getByLabel(/^Vừa vặn/).selectOption("TRUE_TO_SIZE");
  await page.getByLabel(/Link ảnh khách/).fill(photo);
  await page.getByLabel(/Mã đơn hàng/).fill(orderCode);
  await page.getByLabel(/Khách đã đồng ý cho đăng/).check();
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await page.waitForURL((url) => url.searchParams.get("saved") === "1");
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu." })).toBeVisible();

  const saved = await prisma.productReview.findFirstOrThrow({ where: { productId } });
  expect(saved.authorName).toBe("Lan A.");
  expect(saved.orderPublicCode).toBe(orderCode);
  expect(saved.imageUrls).toEqual([photo]);
  expect(saved.status).toBe("PUBLISHED");
  expect(saved.consentConfirmedAt).toBeInstanceOf(Date);

  const row = page.getByRole("listitem").filter({ hasText: "Lan A." });
  await expect(row).toContainText("Đang hiển thị");
  await expect(row).toContainText(`Đã gắn đơn ${orderCode}`);

  // The same order cannot verify a review of a different product.
  const other = await prisma.productMirror.findUniqueOrThrow({ where: { slug: otherSlug }, select: { id: true } });
  await page.goto(`${BASE_URL}/admin/products/${other.id}/reviews`, { waitUntil: "networkidle" });
  await page.getByLabel(/^Tên hiển thị/).fill("Minh T.");
  await page.getByLabel(/^Nội dung đánh giá/).fill("Đẹp.");
  await page.getByLabel(/Mã đơn hàng/).fill(orderCode);
  await page.getByLabel(/Khách đã đồng ý cho đăng/).check();
  await page.getByRole("button", { name: "Thêm đánh giá" }).click();
  await page.waitForURL((url) => url.searchParams.get("orderError") === "ORDER_LACKS_PRODUCT");
  await expect(page.getByRole("alert").filter({ hasText: "không có sản phẩm này" })).toBeVisible();
  expect(await prisma.productReview.count({ where: { productId: other.id } })).toBe(0);

  // The storefront shows it, with the verified label the order earned.
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.locator("#pdp-reviews")).toContainText("Lan A.");
  await expect(page.locator("#pdp-reviews")).toContainText("✓ Đã mua hàng");

  // Hiding takes it off the page.
  await page.goto(`${BASE_URL}${reviewsPath}`, { waitUntil: "networkidle" });
  await page.getByRole("listitem").filter({ hasText: "Lan A." }).getByRole("button", { name: "Ẩn" }).click();
  await page.waitForURL((url) => url.searchParams.get("saved") === "1");
  await expect(page.getByRole("listitem").filter({ hasText: "Lan A." })).toContainText("Đang ẩn");
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await expect(page.locator("#pdp-reviews")).toHaveCount(0);

  // Editing keeps the saved values; deleting needs a second, deliberate step.
  await page.goto(`${BASE_URL}${reviewsPath}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Sửa" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Sửa đánh giá" })).toBeVisible();
  await expect(page.getByLabel(/^Tên hiển thị/)).toHaveValue("Lan A.");
  await expect(page.getByLabel(/Mã đơn hàng/)).toHaveValue(orderCode);
  await page.goto(`${BASE_URL}${reviewsPath}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Xác nhận xóa" })).toBeHidden();
  await page.getByText("Xóa vĩnh viễn…").click();
  await page.getByRole("button", { name: "Xác nhận xóa" }).click();
  await page.waitForURL((url) => url.searchParams.get("saved") === "1");
  expect(await prisma.productReview.count({ where: { productId } })).toBe(0);
});
