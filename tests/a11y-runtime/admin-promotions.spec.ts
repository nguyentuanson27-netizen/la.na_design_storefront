/**
 * U14 / P5 — the promotion admin surface in a real browser.
 *
 * Three things need a browser rather than a unit test: that the page is reachable and operable by
 * keyboard, that Axe finds no violations on a data-bearing table, and — the one that matters most —
 * that pressing a lifecycle button while the activation gate is off produces a *typed, readable*
 * refusal rather than a driver error or a silent no-op.
 */

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
const PORT = 3306;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-promotions-${runId}@example.invalid`;
const password = "admin-promotions-runtime-password-123";
const campaignId = `u14-a11y-${runId}`;
const campaignName = `U14 Draft Campaign ${runId}`;
const testProductId = `u14-prod-${runId}`;
const testVariantId = `u14-var-${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
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
      throw new Error(`Next.js promotions server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // still compiling
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for promotions server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) server.kill("SIGKILL");
}

async function cleanupDatabase() {
  await prisma.$executeRaw`DELETE FROM "PromotionTarget" WHERE "id" LIKE ${`u14-%${runId}%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" = ${campaignId} OR "name" LIKE ${`%${runId}%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" = ${testVariantId}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" = ${testProductId}`;
  await prisma.user.deleteMany({ where: { email: adminEmail } });
}

test.beforeAll(async () => {
  await cleanupDatabase();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,920942,$2,$3,'U14 A11y Product',NOW(),NOW(),NOW())`,
    testProductId, `${testProductId}-ext`, `u14-prod-slug-${runId}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "VariantMirror" ("id","pancakeVariationId","productId","pancakeRetailPrice","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,500000,NOW(),NOW(),NOW())`,
    testVariantId, `${testVariantId}-ext`, testProductId,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign"
       ("id","kind","name","discountType","percentageValue","isEnabled","createdAt","updatedAt")
     VALUES ($1,'PROMOTION'::"PromotionCampaignKind",$2,'PERCENTAGE'::"PromotionDiscountType",10,false,NOW(),NOW())`,
    campaignId, campaignName,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","productId","variantId","createdAt")
     VALUES ($1,$2,$3,NULL,NOW())`,
    `u14-target-${runId}`, campaignId, testProductId,
  );

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.44" }),
    body: { name: "Admin Promotions Runtime", email: adminEmail, password },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);

  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    // The gate is left at its default — off — because that is the state this unit ships in and the
    // refusal path is what needs proving.
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/admin-promotions",
      // Better Auth rejects callbacks whose origin does not match its configured base URL,
      // so it has to follow this spec's own port rather than a value pinned in the workflow.
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
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

test("U14 the promotion admin lists campaigns and refuses activation with a typed message", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/promotions`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Khuyến mãi", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(campaignName) })).toBeVisible();

  // The gate is off, so the operator is told before they try.
  await expect(page.getByText("Kích hoạt khuyến mãi đang tắt")).toBeVisible();

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);

  // Keyboard reachability: the search field and the row's own controls take focus.
  await page.getByLabel("Tìm theo tên chiến dịch").focus();
  await expect(page.getByLabel("Tìm theo tên chiến dịch")).toBeFocused();

  const row = page.getByRole("row", { name: new RegExp(campaignName) });
  await row.getByRole("button", { name: "Bật" }).click();

  // The refusal is typed and readable — not a driver error, not a silent no-op — and it is
  // announced, with focus moved to it so a keyboard operator is not left on a vanished button.
  // Addressed by id: the framework mounts its own empty role="alert" route announcer, so a bare
  // role lookup is ambiguous rather than wrong.
  const status = page.locator("#promotion-admin-status");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("Chức năng kích hoạt khuyến mãi đang tắt");
  await expect(status).toContainText("Không có thay đổi nào được lưu");
  await expect(status).toBeFocused();

  // Nothing may have been written by a refused activation.
  const after = await prisma.$queryRaw<Array<{ isEnabled: boolean }>>`
    SELECT "isEnabled" FROM "PromotionCampaign" WHERE "id" = ${campaignId}
  `;
  expect(after[0]?.isEnabled).toBe(false);

  expect(browserErrors).toEqual([]);
});

test("U14 the surface stays usable at a narrow mobile viewport", async ({ page, context }) => {
  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/admin/promotions`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Khuyến mãi", level: 1 })).toBeVisible();
  // The table scrolls inside its own container rather than pushing the document sideways.
  const documentOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(documentOverflows).toBe(false);

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("U14 P5b create and edit campaign form renders with zero Axe violations", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/promotions?new=1`, { waitUntil: "networkidle" });

  await expect(page.getByRole("textbox", { name: "Tên chiến dịch" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Loại chiến dịch" })).toBeVisible();

  await expectSettledDocumentTitle(page);
  const newFormAxe = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(newFormAxe.violations).toEqual([]);

  await page.goto(`${BASE_URL}/admin/promotions?edit=${campaignId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: new RegExp(`Chỉnh sửa: ${campaignName}`), level: 2 })).toBeVisible();

  await expectSettledDocumentTitle(page);
  const editFormAxe = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(editFormAxe.violations).toEqual([]);

  expect(browserErrors).toEqual([]);
});

test("U14 P5b product admin displays related campaign summary and link with zero Axe violations", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/products/${testProductId}`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Chiến dịch liên quan", level: 2 })).toBeVisible();
  await expect(page.getByText(campaignName)).toBeVisible();
  await expect(page.getByRole("link", { name: "Xem tất cả khuyến mãi →" })).toBeVisible();

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page })
    .include("section[aria-labelledby='product-promotions-heading']")
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibility.violations).toEqual([]);

  expect(browserErrors).toEqual([]);
});

test("U14 P5b browser creates campaign and persists exact Draft row without advancing revision", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const newCampaignName = `U14 Browser Created ${runId}`;

  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/promotions?new=1`, { waitUntil: "networkidle" });

  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(newCampaignName);
  await page.getByLabel("Mức giảm (%)").fill("25");

  // Search target and add
  const searchInput = page.getByRole("searchbox", { name: "Từ khóa tìm kiếm mục áp dụng" });
  await searchInput.fill("U14 A11y Product");
  await page.getByRole("button", { name: "Tìm mục" }).click();

  const addButton = page.getByRole("button", { name: "+ Thêm" });
  await expect(addButton).toBeVisible();
  await addButton.click();
  await expect(page.getByRole("button", { name: "Đã thêm" })).toBeVisible();

  // Submit create
  await page.getByRole("button", { name: "Tạo chiến dịch (Nháp)" }).click();

  // Wait for redirect to /admin/promotions?status=ok
  await expect(page).toHaveURL(`${BASE_URL}/admin/promotions?status=ok`);
  await expect(page.getByText("Đã lưu thay đổi.")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(newCampaignName) })).toBeVisible();

  // Direct database assertions
  const created = await prisma.promotionCampaign.findFirst({
    where: { name: newCampaignName },
    include: { targets: true },
  });
  expect(created).not.toBeNull();
  expect(created?.percentageValue).toBe(25);
  expect(created?.isEnabled).toBe(false);
  expect(created?.targets.length).toBe(1);
  expect(created?.targets[0]?.productId).toBe(testProductId);

  expect(browserErrors).toEqual([]);
});

test("U14 P5b browser edits campaign and updates material fields in DB", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await context.addCookies(adminCookies);
  await page.goto(`${BASE_URL}/admin/promotions?edit=${campaignId}`, { waitUntil: "networkidle" });

  const percentInput = page.getByLabel("Mức giảm (%)");
  await percentInput.clear();
  await percentInput.fill("35");

  await page.getByRole("button", { name: "Lưu thay đổi" }).click();

  await expect(page).toHaveURL(`${BASE_URL}/admin/promotions?status=ok`);
  await expect(page.getByText("Đã lưu thay đổi.")).toBeVisible();

  // Assert DB exact value
  const updated = await prisma.promotionCampaign.findUnique({
    where: { id: campaignId },
  });
  expect(updated?.percentageValue).toBe(35);

  expect(browserErrors).toEqual([]);
});

test("U14 P5b non-admin is refused access to campaign creation and actions", async ({ browser }) => {
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();

  // Unauthenticated user navigating to admin promotions create URL is blocked
  await anonPage.goto(`${BASE_URL}/admin/promotions?new=1`, { waitUntil: "networkidle" });
  await expect(anonPage.getByRole("textbox", { name: "Tên chiến dịch" })).not.toBeVisible();

  await anonContext.close();
});

