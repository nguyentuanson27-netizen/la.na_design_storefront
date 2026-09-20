import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags.ts";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

const HOST = "127.0.0.1";
const PORT = 3216;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_016;

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-bulkops-${runId}@example.invalid`;
const password = "admin-bulk-operations-password-123";
const collectionSlug = `bulkops-collection-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
const trustedImageUrl = "https://content.pancake.vn/media/1/2/3/bulkops.jpg";
const untrustedImageUrl = "https://cdn.example.com/media/1/2/3/bulkops.jpg";

const plainName = `Bulk Ops Plain ${runId}`;
const boundName = `Bulk Ops Scan Bound ${runId}`;
const stockedName = `Bulk Ops Stocked ${runId}`;
const childName = `Bulk Ops Child ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let plainProductId = "";
let boundProductId = "";
let stockedProductId = "";
let childProductId = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js admin bulk-ops server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for admin bulk-ops server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([once(server, "exit").then(() => true), delay(timeoutMs).then(() => false)]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  if (await waitForServerExit(5_000)) return;
  server.kill("SIGKILL");
  await waitForServerExit(5_000);
}

async function cleanupDatabase() {
  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
}

test.beforeAll(async () => {
  await cleanupDatabase();
  const syncedAt = new Date();

  await prisma.collectionDefinition.create({
    data: {
      slug: collectionSlug,
      title: `Bulk Ops Collection ${runId}`,
      description: "Bulk operations runtime fixture.",
      isPublished: true,
    },
  });

  // A plain product whose only trusted media sits on an inactive variant: storefront resolves no
  // primary, so the directory must classify it as missing an image.
  const plain = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `bulkops-plain-${runId}`,
      slug: `bulkops-plain-${runId}`,
      name: plainName,
      isActive: false,
      syncedAt,
      variants: {
        create: [
          {
            pancakeVariationId: `bulkops-plain-${runId}-a`,
            isPresent: true,
            isActive: false,
            pancakeImageUrls: [trustedImageUrl],
            syncedAt,
          },
        ],
      },
    },
  });
  plainProductId = plain.id;

  // Positive summed stock on an inactive variant, plus a trusted image on an active variant.
  const stocked = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `bulkops-stocked-${runId}`,
      slug: `bulkops-stocked-${runId}`,
      name: stockedName,
      isActive: false,
      syncedAt,
      variants: {
        create: [
          {
            pancakeVariationId: `bulkops-stocked-${runId}-a`,
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [untrustedImageUrl, trustedImageUrl],
            syncedAt,
          },
          {
            pancakeVariationId: `bulkops-stocked-${runId}-b`,
            isPresent: true,
            isActive: false,
            syncedAt,
            warehouseStocks: {
              create: [
                { pancakeWarehouseId: "wh-a", quantity: -2, syncedAt },
                { pancakeWarehouseId: "wh-b", quantity: 5, syncedAt },
              ],
            },
          },
        ],
      },
    },
  });
  stockedProductId = stocked.id;

  // The resolver's scan budget in the browser: 100 rejected raw candidates leave nothing for the
  // trusted candidate at #101, so storefront resolves no primary and the row stays `Thiếu ảnh`.
  const bound = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `bulkops-bound-${runId}`,
      slug: `bulkops-bound-${runId}`,
      name: boundName,
      isActive: false,
      syncedAt,
      variants: {
        create: [
          {
            pancakeVariationId: `bulkops-bound-${runId}-a`,
            isPresent: true,
            isActive: true,
            pancakeImageUrls: Array.from({ length: 100 }, () => untrustedImageUrl),
            syncedAt,
          },
          {
            pancakeVariationId: `bulkops-bound-${runId}-b`,
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [trustedImageUrl],
            syncedAt,
          },
        ],
      },
    },
  });
  boundProductId = bound.id;

  // W17 — the scan-bound product carries complete SEO copy but no editorial description, so the
  // two content-health chips cannot pass by selecting the same rows.
  await prisma.productContent.create({
    data: {
      productId: bound.id,
      seoTitle: `Bulk Ops Scan Bound SEO ${runId}`,
      seoDescription: "Mô tả tìm kiếm đầy đủ cho sản phẩm scan bound.",
    },
  });

  const child = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `bulkops-child-${runId}`,
      slug: `bulkops-child-${runId}`,
      name: childName,
      isActive: false,
      syncedAt,
      variants: {
        create: [
          {
            pancakeVariationId: `bulkops-child-${runId}-a`,
            isPresent: true,
            isActive: true,
            pancakeImageUrls: [trustedImageUrl],
            syncedAt,
          },
        ],
      },
    },
  });
  childProductId = child.id;

  // W17 — the one product an operator has finished: neither content-health chip may list it.
  await prisma.productContent.create({
    data: {
      productId: child.id,
      editorialDescription: "Nội dung biên tập đã hoàn tất cho sản phẩm child.",
      seoTitle: `Bulk Ops Child SEO ${runId}`,
      seoDescription: "Mô tả tìm kiếm đầy đủ cho sản phẩm child.",
    },
  });

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.36" }),
    body: { name: "Admin Bulk Operations", email: adminEmail, password },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);

  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/admin-bulk-operations",
      NEXT_TELEMETRY_DISABLED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
  await cleanupDatabase();
  await prisma.$disconnect();
});

test("admin directory surfaces health truth and runs bulk collection and catalog operations accessibly", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);

  await page.goto(`${BASE_URL}/admin?q=${encodeURIComponent(runId)}`, { waitUntil: "networkidle" });

  // C5 — row metrics come from database truth, not from the client's view of the mirror.
  const stockedRow = page.locator("tr", { hasText: stockedName });
  await expect(stockedRow.getByText("Biến thể: 1 / 2 active")).toBeVisible();
  await expect(stockedRow.getByText("1 variant có hàng nhưng đang tắt")).toBeVisible();
  await expect(stockedRow.getByText("Thiếu ảnh")).toHaveCount(0);

  const plainRow = page.locator("tr", { hasText: plainName });
  await expect(plainRow.getByText("Thiếu ảnh")).toBeVisible();
  await expect(page.locator("tr", { hasText: boundName }).getByText("Thiếu ảnh")).toBeVisible();

  // C5 — the missing-image chip opens exactly the set it counts, and trusted media on an inactive
  // variant does not clear the blocker.
  const missingImageChip = page.getByRole("link", { name: /^Thiếu ảnh/ });
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("health") === "missing-image"),
    missingImageChip.click(),
  ]);
  await expect(page.locator("tr", { hasText: plainName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: boundName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: stockedName })).toHaveCount(0);

  const stockedChip = page.getByRole("link", { name: /^Có hàng nhưng variant đang tắt/ });
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("health") === "stocked-inactive"),
    stockedChip.click(),
  ]);
  await expect(page.locator("tr", { hasText: stockedName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: plainName })).toHaveCount(0);

  // W17 — the content-health chips are keyboard-operable links that mark themselves current and
  // list exactly the products still missing that content.
  const missingSeoChip = page.getByRole("link", { name: /^Thiếu SEO/ });
  await missingSeoChip.focus();
  await expect(missingSeoChip).toBeFocused();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("health") === "missing-seo"),
    page.keyboard.press("Enter"),
  ]);
  await expect(page.getByRole("link", { name: /^Thiếu SEO/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("tr", { hasText: plainName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: stockedName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: boundName })).toHaveCount(0);
  await expect(page.locator("tr", { hasText: childName })).toHaveCount(0);

  const missingEditorialChip = page.getByRole("link", { name: /^Thiếu nội dung biên tập/ });
  await missingEditorialChip.focus();
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("health") === "missing-editorial"),
    page.keyboard.press("Enter"),
  ]);
  await expect(page.locator("tr", { hasText: boundName })).toHaveCount(1);
  await expect(page.locator("tr", { hasText: childName })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Thiếu SEO/ })).not.toHaveAttribute(
    "aria-current",
    "true",
  );

  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("health") === null),
    page.getByRole("link", { name: "Xóa tình trạng" }).click(),
  ]);

  // C4 — bulk collection add over the existing current-page selection.
  await page.getByRole("checkbox", { name: "Chọn tất cả sản phẩm trên trang này" }).check();
  await expect(page.getByText("Đã chọn 4 sản phẩm", { exact: true })).toBeVisible();

  await page.getByLabel("Thao tác").selectOption("collection-add");
  await page.getByRole("button", { name: "Thêm collection cho 4 sản phẩm" }).click();
  await expect(page.getByText(/^Thêm Bulk Ops Collection .* cho 4 sản phẩm\?$/)).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "sản phẩm thay đổi" }),
  ).toBeVisible();

  const membership = await prisma.productContent.findMany({
    where: {
      productId: { in: [plainProductId, stockedProductId, boundProductId, childProductId] },
    },
    select: { collectionSlugs: true },
  });
  expect(membership).toHaveLength(4);
  expect(membership.every((row) => row.collectionSlugs.includes(collectionSlug))).toBe(true);

  // C4 — bulk catalog enable is a two-phase, confirmation-fresh handshake.
  await page.getByRole("checkbox", { name: `Chọn ${plainName}` }).check();
  await page.getByRole("checkbox", { name: `Chọn ${stockedName}` }).check();
  await page.getByLabel("Thao tác").selectOption("catalog-enable");
  await page.getByRole("button", { name: "Bật catalog cho 2 sản phẩm" }).click();

  await expect(page.getByText("1/2 sản phẩm hiện không có biến thể hoạt động.")).toBeVisible();
  await expect(
    page.getByText("0/2 sản phẩm đang là thành phần set/composite và sẽ được mở catalog riêng."),
  ).toBeVisible();
  await expect(page.getByText("Bật catalog không tự kích hoạt biến thể.")).toBeVisible();

  // Cancelling is keyboard reachable and writes nothing.
  await page.getByRole("button", { name: "Hủy" }).click();
  await expect(page.getByRole("button", { name: "Bật catalog cho 2 sản phẩm" })).toBeVisible();
  expect(
    (await prisma.productMirror.findUniqueOrThrow({ where: { id: plainProductId } })).isActive,
  ).toBe(false);

  await page.getByRole("button", { name: "Bật catalog cho 2 sản phẩm" }).click();
  await expect(page.getByText("Bật catalog cho 2 sản phẩm?")).toBeVisible();

  await page.getByRole("button", { name: "Xác nhận" }).click();
  const status = page.getByRole("status").filter({ hasText: "Đã bật catalog cho 2 sản phẩm." });
  await expect(status).toBeVisible();
  await expect(status).toBeFocused();

  const enabled = await prisma.productMirror.findMany({
    where: { id: { in: [plainProductId, stockedProductId, childProductId] } },
    select: { id: true, isActive: true },
  });
  expect(enabled.find((row) => row.id === plainProductId)?.isActive).toBe(true);
  expect(enabled.find((row) => row.id === stockedProductId)?.isActive).toBe(true);
  expect(enabled.find((row) => row.id === childProductId)?.isActive).toBe(false);

  const variantActivity = await prisma.variantMirror.findMany({
    where: { productId: plainProductId },
    select: { isActive: true },
  });
  expect(variantActivity.every((variant) => variant.isActive)).toBe(false);

  // Bulk variant operations
  await page.getByRole("checkbox", { name: `Chọn ${plainName}` }).check();
  await page.getByLabel("Thao tác").selectOption("variants-enable-all");
  await page.getByRole("button", { name: "Kích hoạt tất cả biến thể cho 1 sản phẩm" }).click();
  await expect(page.getByText("Kích hoạt tất cả biến thể cho 1 sản phẩm đã chọn?")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Đã kích hoạt 1 biến thể cho 1 sản phẩm; 1 biến thể thay đổi.",
    }),
  ).toBeVisible();
  const plainVariantsAfterEnable = await prisma.variantMirror.findMany({
    where: { productId: plainProductId },
    select: { isActive: true },
  });
  expect(plainVariantsAfterEnable.every((variant) => variant.isActive)).toBe(true);

  // Bulk variant enable-stocked
  await page.getByRole("checkbox", { name: `Chọn ${stockedName}` }).check();
  await page.getByLabel("Thao tác").selectOption("variants-enable-stocked");
  await page.getByRole("button", { name: "Kích hoạt biến thể có hàng cho 1 sản phẩm" }).click();
  await expect(page.getByText("Kích hoạt các biến thể có hàng cho 1 sản phẩm đã chọn?")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Đã kích hoạt 1 biến thể có hàng cho 1 sản phẩm; 1 biến thể thay đổi.",
    }),
  ).toBeVisible();
  // Only the variant with positive sellable stock flips; the zero-stock one stays as seeded, and
  // variant activation never publishes the product itself.
  const stockedVariantsAfterEnable = await prisma.variantMirror.findMany({
    where: { productId: stockedProductId },
    orderBy: { pancakeVariationId: "asc" },
    select: { isActive: true },
  });
  expect(stockedVariantsAfterEnable.map((variant) => variant.isActive)).toEqual([true, true]);

  // Bulk variant disable-all
  await page.getByRole("checkbox", { name: `Chọn ${plainName}` }).check();
  await page.getByLabel("Thao tác").selectOption("variants-disable-all");
  await page.getByRole("button", { name: "Tắt tất cả biến thể cho 1 sản phẩm" }).click();
  await expect(page.getByText("Tắt tất cả biến thể cho 1 sản phẩm đã chọn?")).toBeVisible();
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Đã tắt 1 biến thể cho 1 sản phẩm; 1 biến thể thay đổi.",
    }),
  ).toBeVisible();
  const plainVariantsAfterDisable = await prisma.variantMirror.findMany({
    where: { productId: plainProductId },
    select: { isActive: true },
  });
  expect(plainVariantsAfterDisable.every((variant) => variant.isActive)).toBe(false);

  // C4 — a warning-relevant change after the confirmation was shown must reconfirm with zero
  // writes for the whole batch.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("checkbox", { name: `Chọn ${childName}` }).check();
  await page.getByLabel("Thao tác").selectOption("catalog-enable");
  await page.getByRole("button", { name: "Bật catalog cho 1 sản phẩm" }).click();
  await expect(
    page.getByText("0/1 sản phẩm đang là thành phần set/composite và sẽ được mở catalog riêng."),
  ).toBeVisible();

  const parent = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `bulkops-parent-${runId}`,
      slug: `bulkops-parent-${runId}`,
      name: `Bulk Ops Parent ${runId}`,
      isActive: true,
      syncedAt: new Date(),
      variants: {
        create: [
          {
            pancakeVariationId: `bulkops-parent-${runId}-a`,
            isPresent: true,
            isActive: true,
            syncedAt: new Date(),
          },
        ],
      },
    },
    include: { variants: true },
  });
  const childVariant = await prisma.variantMirror.findFirstOrThrow({
    where: { productId: childProductId },
  });
  await prisma.compositeComponentMirror.create({
    data: {
      parentVariantId: parent.variants[0]!.id,
      componentVariantId: childVariant.id,
      quantity: 1,
      syncedAt: new Date(),
    },
  });

  await page.getByRole("button", { name: "Xác nhận" }).click();
  const reconfirmAlert = page.getByRole("alert").filter({ hasText: "Trạng thái cảnh báo" });
  await expect(reconfirmAlert).toContainText("Trạng thái cảnh báo đã thay đổi");
  await expect(reconfirmAlert).toContainText("Không có sản phẩm nào được cập nhật");
  await expect(
    page.getByText("1/1 sản phẩm đang là thành phần set/composite và sẽ được mở catalog riêng."),
  ).toBeVisible();
  expect(
    (await prisma.productMirror.findUniqueOrThrow({ where: { id: childProductId } })).isActive,
  ).toBe(false);

  // The fresh confirmation is the one that commits.
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Đã bật catalog cho 1 sản phẩm." }),
  ).toBeVisible();
  expect(
    (await prisma.productMirror.findUniqueOrThrow({ where: { id: childProductId } })).isActive,
  ).toBe(true);

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(horizontalOverflow).toBe(false);

  // The bulk action's revalidation re-streams the dynamic head — the root layout's
  // generateMetadata awaits connection() — so the document title is briefly absent afterwards and
  // Axe can scan that transient state instead of the settled page. The one-shot toHaveTitle that
  // used to stand here observed a point in time and let e51d6cd's run land in the gap anyway; this
  // waits for the title to have been continuously present. A title that never arrives still fails.
  await expectSettledDocumentTitle(page);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
  expect({ browserErrors, failedResponses }).toEqual({
    browserErrors: [],
    failedResponses: [],
  });
});
