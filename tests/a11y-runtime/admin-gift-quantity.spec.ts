/**
 * GQ05 — the gift / quantity-tier admin surface in a real browser.
 *
 * What needs a browser rather than a unit test: that the page is operable by keyboard and has no
 * Axe violations, that the scope form reshapes itself the way the spec says (a whole-order gift
 * asks for no categories or products), that a Draft written through the real form lands in the
 * database exactly as typed, and that pressing Bật while the feature gate is OFF yields a typed,
 * readable, announced refusal with nothing written.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { PROMOTION_REVISION_ID } from "../../src/commerce/promotion-activation-service.ts";
import { auth } from "../../src/auth/server.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags.ts";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

const HOST = "127.0.0.1";
const PORT = 3322;
const BASE_URL = `http://${HOST}:${PORT}`;
const PAGE = `${BASE_URL}/admin/promotions/gift-quantity`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-gift-quantity-${runId}@example.invalid`;
const password = "admin-gift-quantity-runtime-password-123";
const productId = `gq05-prod-${runId}`;
const seededName = `GQ05 Seeded Draft ${runId}`;
const seededId = `gq05-seed-${runId}`;
const scheduledName = `GQ05 Scheduled ${runId}`;
const scheduledId = `gq05-sched-${runId}`;
// Minute-aligned, because that is the precision the datetime-local field round-trips.
const scheduledStart = new Date(Math.floor((Date.now() + 10 * 24 * 3600 * 1000) / 60_000) * 60_000);
const scheduledEnd = new Date(scheduledStart.getTime() + 5 * 24 * 3600 * 1000);
// R04: instants that carry seconds and milliseconds, which the minute-precision form field cannot show.
const preciseName = `GQ05 Precise ${runId}`;
const preciseId = `gq05-precise-${runId}`;
const preciseStart = new Date(scheduledStart.getTime() + 37_123);
const preciseEnd = new Date(scheduledEnd.getTime() + 59_900);

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // still compiling
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
}

async function cleanupDatabase() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "name" LIKE ${`%${runId}%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" = ${productId}`;
  await prisma.user.deleteMany({ where: { email: adminEmail } });
}

test.beforeAll(async () => {
  await cleanupDatabase();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,920942,$2,$3,'GQ05 Picker Product',NOW(),NOW(),NOW())`,
    productId, `${productId}-ext`, `gq05-prod-slug-${runId}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductCategoryMembership" ("productId","categoryKey") VALUES ($1,'setVay')`,
    productId,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","giftTrigger","minimumQuantity","updatedAt")
     VALUES ($1,'GIFT_ITEM',$2,'DYNAMIC_CATEGORY',ARRAY['setVay']::text[],'QUANTITY',2,NOW())`,
    seededId, seededName,
  );

  await prisma.giftQuantityCampaign.create({
    data: {
      id: scheduledId, kind: "GIFT_ITEM", name: scheduledName, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
      giftTrigger: "QUANTITY", minimumQuantity: 2, isEnabled: true, enabledAt: new Date(), startsAt: scheduledStart, endsAt: scheduledEnd,
    },
  });

  await prisma.giftQuantityCampaign.create({
    data: {
      id: preciseId, kind: "GIFT_ITEM", name: preciseName, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
      giftTrigger: "QUANTITY", minimumQuantity: 2, isEnabled: true, enabledAt: new Date(), startsAt: preciseStart, endsAt: preciseEnd,
    },
  });

  const { headers } = await auth.api.signUpEmail({
    returnHeaders: true,
    headers: new Headers({ "x-ci-client-ip": "203.0.113.45" }),
    body: { name: "Admin Gift Quantity Runtime", email: adminEmail, password },
  });
  adminCookies = cookiesFrom(headers);
  expect(adminCookies.length).toBeGreaterThan(0);
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    // The feature gate is left at its default, OFF: that is the state this unit ships in.
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/admin-gift-quantity",
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
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
  await cleanupDatabase();
  await prisma.$disconnect();
});

test("GQ05 the list renders, says the feature is off, has no Axe violations and is keyboard reachable", async ({ page, context }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await watchDocumentTitle(page);
  await context.addCookies(adminCookies);
  await page.goto(PAGE, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Quà tặng & giảm giá theo số lượng", level: 1 })).toBeVisible();
  await expect(page.getByText("Tính năng đang tắt")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(seededName) })).toBeVisible();

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByLabel("Tìm theo tên chiến dịch").focus();
  await expect(page.getByLabel("Tìm theo tên chiến dịch")).toBeFocused();
  expect(browserErrors).toEqual([]);
});

test("GQ05 pressing Bật while the feature gate is OFF gives a typed, announced refusal and writes nothing", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const row = page.getByRole("row", { name: new RegExp(seededName) });
  await row.getByRole("button", { name: /^Bật/ }).click();

  const status = page.locator("#promotion-admin-status");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("Tính năng quà tặng và giảm giá theo số lượng đang tắt");
  await expect(status).toContainText("Không có thay đổi nào được lưu");
  await expect(status).toBeFocused();

  const after = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: seededId } });
  expect(after.isEnabled).toBe(false);
  expect(after.revision).toBe(1);
});

test("GQ05 the surface stays usable at a narrow mobile viewport", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Quà tặng & giảm giá theo số lượng", level: 1 })).toBeVisible();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("GQ05 the create form has no Axe violations and a whole-order gift asks for no category or product (EX-22)", async ({ page, context }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?new=1`, { waitUntil: "networkidle" });

  await expect(page.getByRole("textbox", { name: "Tên chiến dịch" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Loại chiến dịch" })).toBeVisible();
  // by default a real scope is asked for
  await expect(page.getByRole("checkbox", { name: "Set váy" })).toBeVisible();
  const defaultAxe = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(defaultAxe.violations).toEqual([]);

  await page.getByRole("combobox", { name: "Nhận quà khi" }).selectOption("ORDER_SUBTOTAL");
  await page.getByRole("combobox", { name: "Giá trị đơn hàng tính trên" }).selectOption("ELIGIBLE_PAID_LINES");
  await expect(page.getByRole("checkbox", { name: "Set váy" })).toBeVisible();
  await page.getByRole("combobox", { name: "Giá trị đơn hàng tính trên" }).selectOption("ALL_PAID_LINES");

  await expect(page.getByText("Áp dụng giá trị toàn đơn.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Set váy" })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Tìm sản phẩm" })).toHaveCount(0);
  const globalAxe = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(globalAxe.violations).toEqual([]);

  // leaving the whole-order choice brings the real scope back and never submits the contradiction
  await page.getByRole("combobox", { name: "Giá trị đơn hàng tính trên" }).selectOption("ELIGIBLE_PAID_LINES");
  await expect(page.getByRole("checkbox", { name: "Set váy" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("GQ05 creating a whole-order gift through the form persists a global Draft with no targets", async ({ page, context }) => {
  const name = `GQ05 Global Gift ${runId}`;
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?new=1`, { waitUntil: "networkidle" });

  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(name);
  await page.getByRole("combobox", { name: "Nhận quà khi" }).selectOption("ORDER_SUBTOTAL");
  await page.getByRole("combobox", { name: "Giá trị đơn hàng tính trên" }).selectOption("ALL_PAID_LINES");
  await page.getByRole("button", { name: "Tạo bản nháp" }).click();

  await expect(page).toHaveURL(`${PAGE}?status=ok`);
  await expect(page.getByText("Đã lưu thay đổi.")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();

  const created = await prisma.giftQuantityCampaign.findFirstOrThrow({ where: { name }, include: { targets: true } });
  expect(created.scopeMode).toBe("GLOBAL_ALL_PAID_LINES");
  expect(created.giftTrigger).toBe("ORDER_SUBTOTAL");
  expect(created.subtotalScope).toBe("ALL_PAID_LINES");
  expect(created.categoryKeys).toEqual([]);
  expect(created.targets).toHaveLength(0);
  expect(created.isEnabled).toBe(false);
});

test("GQ05 creating a tier Draft with a category and an excluded product persists exactly that, and the preview counts matches", async ({ page, context }) => {
  const name = `GQ05 Tier ${runId}`;
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?new=1`, { waitUntil: "networkidle" });

  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(name);
  await page.getByRole("combobox", { name: "Loại chiến dịch" }).selectOption("QUANTITY_TIER");
  await page.getByRole("radio", { name: /Chốt danh sách sản phẩm khi bật chiến dịch/ }).check();
  await page.getByRole("checkbox", { name: "Set váy" }).check();

  await page.getByRole("button", { name: "Xem sản phẩm khớp hiện tại" }).click();
  await expect(page.getByRole("status").filter({ hasText: "sản phẩm khớp" })).toContainText("GQ05 Picker Product");
  await expect(page.getByText("Danh sách sẽ được chốt khi bật chiến dịch.")).toBeVisible();

  const excludeSearch = page.getByRole("searchbox", { name: "Tìm sản phẩm" }).nth(1);
  await excludeSearch.fill("GQ05 Picker Product");
  await excludeSearch.press("Enter");
  await page.getByRole("button", { name: /^Thêm GQ05 Picker Product/ }).last().click();
  await page.getByRole("button", { name: "Tạo bản nháp" }).click();

  await expect(page).toHaveURL(`${PAGE}?status=ok`);
  const created = await prisma.giftQuantityCampaign.findFirstOrThrow({ where: { name }, include: { targets: true } });
  expect(created.kind).toBe("QUANTITY_TIER");
  expect(created.scopeMode).toBe("FIXED_PRODUCT_SET");
  expect(created.categoryKeys).toEqual(["setVay"]);
  expect(created.targets.map((target) => [target.productId, target.role])).toEqual([[productId, "EXCLUDE"]]);
  expect(created.frozenAt).toBeNull();
});

test("GQ05 the edit form for a Draft renders with no Axe violations and the kind is not changeable", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?edit=${seededId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: new RegExp(`Chỉnh sửa: ${seededName}`), level: 2 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Loại chiến dịch" })).toHaveCount(0);
  await expect(page.getByText("Không thể đổi loại sau khi đã tạo.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Set váy" })).toBeChecked();
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("GQ05 copy creates a fresh Draft", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const row = page.getByRole("row", { name: new RegExp(`^${seededName}`) });
  await row.getByRole("button", { name: /^Sao chép/ }).click();
  await expect(page).toHaveURL(`${PAGE}?status=ok`);
  const copies = await prisma.giftQuantityCampaign.findMany({ where: { name: `${seededName} - Bản sao` } });
  expect(copies).toHaveLength(1);
  expect(copies[0]!.isEnabled).toBe(false);
});

test("F03/F05 a Scheduled campaign: the trigger is shown but fixed, and a rename saved through the real form is not an effective edit", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?edit=${scheduledId}`, { waitUntil: "networkidle" });
  const trigger = page.getByRole("combobox", { name: "Nhận quà khi" });
  await expect(trigger).toBeDisabled();
  await expect(trigger).toHaveValue("QUANTITY");
  await expect(page.getByText("Chiến dịch đã lên lịch nên không đổi được điều kiện nhận quà.")).toBeVisible();

  const renamed = `${scheduledName} renamed`;
  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(renamed);
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();

  // The feature gate is OFF in this environment: a real change would be refused, a rename must not be.
  await expect(page).toHaveURL(`${PAGE}?status=ok`);
  const after = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: scheduledId } });
  expect(after.name).toBe(renamed);
  expect(after.revision).toBe(1);
  expect(after.startsAt?.toISOString()).toBe(scheduledStart.toISOString());
  expect(after.endsAt?.toISOString()).toBe(scheduledEnd.toISOString());
  expect(after.isEnabled).toBe(true);

  // moving the end date IS an effective edit and is refused while the gate is OFF
  await page.goto(`${PAGE}?edit=${scheduledId}`, { waitUntil: "networkidle" });
  await page.getByLabel("Kết thúc (giờ Việt Nam)").fill("2099-01-01T10:00");
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page.locator("#promotion-admin-status")).toContainText("Tính năng quà tặng và giảm giá theo số lượng đang tắt");
  const unchanged = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: scheduledId } });
  expect(unchanged.endsAt?.toISOString()).toBe(scheduledEnd.toISOString());
});

test("R04 a Scheduled campaign whose times carry seconds can be renamed through the real form without that counting as a time edit", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?edit=${preciseId}`, { waitUntil: "networkidle" });
  const renamed = `${preciseName} renamed`;
  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(renamed);
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();

  // The gate is OFF: had the minute-rounded form value been read as a new start/end, this would be refused.
  await expect(page).toHaveURL(`${PAGE}?status=ok`);
  const after = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: preciseId } });
  expect(after.name).toBe(renamed);
  expect(after.revision).toBe(1);
  expect(after.startsAt?.getTime()).toBe(preciseStart.getTime());
  expect(after.endsAt?.getTime()).toBe(preciseEnd.getTime());

  // typing a genuinely different minute is still an effective edit and is still refused while the gate is OFF
  await page.goto(`${PAGE}?edit=${preciseId}`, { waitUntil: "networkidle" });
  await page.getByLabel("Kết thúc (giờ Việt Nam)").fill("2099-01-01T10:00");
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page.locator("#promotion-admin-status")).toContainText("Tính năng quà tặng và giảm giá theo số lượng đang tắt");
  const unchanged = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: preciseId } });
  expect(unchanged.endsAt?.getTime()).toBe(preciseEnd.getTime());
});

test("GQ09a-F1 real Server Actions reject tier fields on Gift create and edit without any write", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  const beforeCount = await prisma.giftQuantityCampaign.count();
  const [revision] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  const original = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: seededId } });
  const payloads = [
    [["tierRuleForm", "on"], ["tierUnit", "PERCENTAGE"], ["tierMinQuantity", "2"], ["tierDiscountValue", "10"]],
    [["tierUnit", "BOGUS"], ["tierMinQuantity", "1.5"]],
    Array.from({ length: 101 }, () => ["stackPeer", "PROMOTION:x"]),
  ];
  for (const edit of [false, true]) {
    for (const payload of payloads) {
      await page.goto(edit ? `${PAGE}?edit=${seededId}` : `${PAGE}?new=1`, { waitUntil: "networkidle" });
      await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(`GQ09a rejected ${runId}`);
      await page.evaluate((entries) => {
        const form = document.querySelector<HTMLInputElement>('input[name="name"]')!.form!;
        for (const [name, value] of entries) {
          const input = document.createElement("input");
          input.type = "hidden"; input.name = name!; input.value = value!;
          form.appendChild(input);
        }
      }, payload);
      await page.getByRole("button", { name: edit ? "Lưu thay đổi" : "Tạo bản nháp" }).click();
      await expect(page).toHaveURL(`${PAGE}?status=error&reason=TIER_FIELDS_ON_GIFT`);
      await expect(page.getByRole("alert")).toContainText("Chiến dịch quà tặng không có bậc giảm giá theo số lượng.");
    }
  }
  expect(await prisma.giftQuantityCampaign.count()).toBe(beforeCount);
  expect(await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: seededId } })).toEqual(original);
  const [after] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  expect(after!.revision).toBe(revision!.revision);
});
