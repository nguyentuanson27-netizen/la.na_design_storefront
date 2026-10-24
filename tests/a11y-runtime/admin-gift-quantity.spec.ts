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
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

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
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`gq13b-${runId}-%`}`;
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
      // A published campaign always has an explicit duplicate policy (publish refuses an unset one), so the
      // fixture does too: an unset value would make an untouched form save look like a rule change.
      giftTrigger: "QUANTITY", minimumQuantity: 2, allowDuplicateGifts: false, isEnabled: true, enabledAt: new Date(), startsAt: scheduledStart, endsAt: scheduledEnd,
    },
  });

  await prisma.giftQuantityCampaign.create({
    data: {
      id: preciseId, kind: "GIFT_ITEM", name: preciseName, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
      giftTrigger: "QUANTITY", minimumQuantity: 2, allowDuplicateGifts: false, isEnabled: true, enabledAt: new Date(), startsAt: preciseStart, endsAt: preciseEnd,
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

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    // The feature gate is left at its default, OFF: that is the state this unit ships in.
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/admin-gift-quantity"),
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

test("GQ13a a refused action's specific sub-reason reaches the Admin page, and a hand-edited one never widens it", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  const status = page.locator("#promotion-admin-status");
  const generic = "Quy tắc của chiến dịch chưa hoàn thiện hoặc chưa được hỗ trợ xuất bản";

  // What the Server Action redirect now carries for a 21st concurrent gift campaign.
  await page.goto(`${PAGE}?status=error&reason=INVALID_RULE&code=GIFT_CAMPAIGN_LIMIT_EXCEEDED`, { waitUntil: "networkidle" });
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("chiến dịch quà tặng được phép cùng hiệu lực");
  await expect(status).not.toContainText(generic);
  await expect(status).toBeFocused();

  // Other gift publish refusals are specific too.
  await page.goto(`${PAGE}?status=error&reason=INVALID_RULE&code=GIFT_VARIANT_COMPOSITE`, { waitUntil: "networkidle" });
  await expect(status).toContainText("combo");

  // Unknown, hostile or mismatched codes fall back to the reason's generic sentence and are never echoed.
  for (const code of ["NOPE", "__proto__", "constructor", "%3Cscript%3Ealert(1)%3C%2Fscript%3E"]) {
    await page.goto(`${PAGE}?status=error&reason=INVALID_RULE&code=${code}`, { waitUntil: "networkidle" });
    await expect(status).toContainText(generic);
    await expect(status).not.toContainText(code.replace(/%3C|%3E|%2F/g, ""));
  }
  await page.goto(`${PAGE}?status=error&reason=FEATURE_DISABLED&code=GIFT_CAMPAIGN_LIMIT_EXCEEDED`, { waitUntil: "networkidle" });
  await expect(status).toContainText("Tính năng quà tặng và giảm giá theo số lượng đang tắt");
  await expect(status).not.toContainText("cùng hiệu lực");
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
      await expect(page.locator("#promotion-admin-status")).toContainText("Chiến dịch quà tặng không có bậc giảm giá theo số lượng.");
    }
  }
  expect(await prisma.giftQuantityCampaign.count()).toBe(beforeCount);
  expect(await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: seededId } })).toEqual(original);
  const [after] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  expect(after!.revision).toBe(revision!.revision);
});


test("GQ09b tier form previews EX-19 Q=3 to Q=4 and fails closed for invalid VND", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addCookies(adminCookies);
  await page.setViewportSize({ width: 390, height: 844 });
  await watchDocumentTitle(page);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Loại chiến dịch" }).selectOption("QUANTITY_TIER");
  await expect(page.getByRole("group", { name: "Quy tắc giảm giá theo số lượng" })).toBeVisible();
  await page.getByRole("combobox", { name: "Đơn vị giảm giá" }).selectOption("PERCENTAGE");
  await page.getByRole("combobox", { name: "Chiếc được giảm", exact: true }).selectOption("FROM_REACHED_THRESHOLD");
  await page.getByRole("combobox", { name: "Ưu tiên chiếc được giảm" }).selectOption("CHEAPEST_FIRST");
  await page.getByRole("textbox", { name: "Bậc 1: từ số chiếc" }).fill("2");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).fill("10");
  await page.getByRole("button", { name: "+ Thêm bậc" }).click();
  await page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" }).fill("4");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).nth(1).fill("15");
  const previewButton = page.getByRole("button", { name: "Xem trước giá" });
  await previewButton.focus();
  await expect(previewButton).toBeFocused();
  await previewButton.click();

  const table = page.getByRole("table", { name: "So sánh số lượng và mức giảm giá minh họa" });
  await expect(table.getByRole("row", { name: /Q=3/ })).toContainText("100.000đ");
  await expect(table.getByRole("row", { name: /Q=3/ })).toContainText("1.400.000đ");
  await expect(table.getByRole("row", { name: /Q=4/ })).toContainText("225.000đ");
  await expect(table.getByRole("row", { name: /Q=4/ })).toContainText("1.775.000đ");
  await expect(page.getByText("Q=4: 3 × 425.000đ + 1 × 500.000đ")).toBeVisible();

  // A fixed 50,000 VND step on a 40,000 VND unit must drop the whole tier.
  await page.getByRole("combobox", { name: "Đơn vị giảm giá" }).selectOption("FIXED_AMOUNT_PER_UNIT_VND");
  await page.getByRole("textbox", { name: "Mức giảm (VND/chiếc)" }).first().fill("50000");
  await page.getByRole("textbox", { name: "Mức giảm (VND/chiếc)" }).nth(1).fill("50000");
  await page.getByRole("textbox", { name: "Giá mỗi chiếc trước tier (VND)" }).fill("40000");
  await previewButton.click();
  await expect(page.getByText(/TIER_PRICE_INVALID: bỏ toàn bậc/).first()).toBeVisible();
  // "Tiết kiệm" is exactly zero: the whole tier is dropped, not clamped to a 1đ unit price.
  await expect(table.getByRole("row", { name: /Q=3/ }).getByRole("cell").nth(2)).toHaveText("0đ");

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  expect(errors).toEqual([]);
});

test("GQ09b preview names a tier beyond the engine cap instead of silently dropping it", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Loại chiến dịch" }).selectOption("QUANTITY_TIER");
  await page.getByRole("combobox", { name: "Đơn vị giảm giá" }).selectOption("PERCENTAGE");
  await page.getByRole("combobox", { name: "Chiếc được giảm", exact: true }).selectOption("ALL_ELIGIBLE_UNITS");
  await page.getByRole("textbox", { name: "Bậc 1: từ số chiếc" }).fill("2");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).fill("10");
  await page.getByRole("button", { name: "+ Thêm bậc" }).click();
  await page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" }).fill("6000");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).nth(1).fill("15");
  await page.getByRole("button", { name: "Xem trước giá" }).click();

  // The warning is in the live region, so a screen reader hears it, and names the threshold and the cap.
  const warning = page.getByRole("status").filter({ hasText: "Cảnh báo" });
  await expect(warning).toContainText("6.000");
  await expect(warning).toContainText("5.000");
  await expect(warning).toContainText("không giỏ hợp lệ nào đạt tới");

  // The reachable steps are still computed exactly: only the 10% step applies, never the 15% one.
  const table = page.getByRole("table", { name: "So sánh số lượng và mức giảm giá minh họa" });
  await expect(table.getByRole("row", { name: /Q=2/ })).toContainText("100.000đ");
  await expect(table.getByRole("row", { name: /Q=3/ })).toContainText("150.000đ");
  await expect(table.getByRole("row", { name: /Q=4/ })).toContainText("200.000đ");
  // The step beyond the cap is shown as not previewable, not as a simulated result.
  const beyond = table.getByRole("row", { name: /Q=6\.000/ });
  await expect(beyond).toContainText("Không thể xem trước");
  await expect(beyond).not.toContainText(/\d\s*đ/);
  await expect(table.getByRole("row", { name: /Q=5\.999|Q=6000/ })).toHaveCount(0);
});

test("GQ09b Draft tier rule persists, reads back, and edits without bumping pricing revision", async ({ page, context }) => {
  const name = "GQ09b Draft " + runId;
  const before = await prisma.promotionPricingRevision.findUniqueOrThrow({ where: { id: PROMOTION_REVISION_ID } });
  await context.addCookies(adminCookies);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(name);
  await page.getByRole("combobox", { name: "Loại chiến dịch" }).selectOption("QUANTITY_TIER");
  await page.getByRole("checkbox", { name: "Set váy" }).check();
  await page.getByRole("combobox", { name: "Đơn vị giảm giá" }).selectOption("PERCENTAGE");
  await page.getByRole("combobox", { name: "Chiếc được giảm", exact: true }).selectOption("FROM_REACHED_THRESHOLD");
  await page.getByRole("combobox", { name: "Ưu tiên chiếc được giảm" }).selectOption("MOST_EXPENSIVE_FIRST");
  await page.getByRole("textbox", { name: "Bậc 1: từ số chiếc" }).fill("2");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).fill("10");
  await page.getByRole("button", { name: "+ Thêm bậc" }).click();
  await page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" }).fill("4");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).nth(1).fill("15");
  await page.getByRole("checkbox", { name: /Cho phép cộng dồn khi cả hai/ }).check();
  await page.getByRole("textbox", { name: /Mức ưu tiên \(0/ }).fill("7");
  await page.getByRole("button", { name: "+ Thêm chiến dịch" }).click();
  await page.getByRole("button", { name: "Tạo bản nháp" }).click();
  await expect(page).toHaveURL(PAGE + "?status=ok");

  const created = await prisma.giftQuantityCampaign.findFirstOrThrow({
    where: { name }, include: { tiers: { orderBy: { minQuantity: "asc" } }, stackPeers: true },
  });
  expect(created.kind).toBe("QUANTITY_TIER");
  expect(created.tierDiscountedUnits).toBe("FROM_REACHED_THRESHOLD");
  expect(created.tierSelectionPriority).toBe("MOST_EXPENSIVE_FIRST");
  expect(created.tiers.map((tier) => [tier.minQuantity, tier.discountValue])).toEqual([[2, 10], [4, 15]]);
  expect(created.stackPriority).toBe(7);
  expect(created.stackingEnabled).toBe(true);
  expect(created.stackPeers.map((peer) => [peer.peerKind, peer.peerCampaignId])).toEqual([["PROMOTION", "*"]]);
  expect(created.isEnabled).toBe(false);
  await page.goto(PAGE + "?edit=" + created.id, { waitUntil: "networkidle" });
  await expect(page.getByRole("combobox", { name: "Đơn vị giảm giá" })).toHaveValue("PERCENTAGE");
  await expect(page.getByRole("combobox", { name: "Chiếc được giảm", exact: true })).toHaveValue("FROM_REACHED_THRESHOLD");
  await expect(page.getByRole("combobox", { name: "Ưu tiên chiếc được giảm" })).toHaveValue("MOST_EXPENSIVE_FIRST");
  await expect(page.getByRole("checkbox", { name: /Cho phép cộng dồn khi cả hai/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: /Mức ưu tiên \(0/ })).toHaveValue("7");
  await expect(page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" })).toHaveValue("4");
  await expect(page.getByRole("textbox", { name: "ID chiến dịch hoặc *" })).toHaveValue("*");
  await page.getByRole("textbox", { name: "Mức giảm (%)" }).nth(1).fill("20");
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page).toHaveURL(PAGE + "?status=ok");
  const edited = await prisma.giftQuantityCampaign.findUniqueOrThrow({
    where: { id: created.id }, include: { tiers: { orderBy: { minQuantity: "asc" } }, stackPeers: true },
  });
  expect(edited.tiers.map((tier) => [tier.minQuantity, tier.discountValue])).toEqual([[2, 10], [4, 20]]);
  expect(edited.stackPeers.map((peer) => [peer.peerKind, peer.peerCampaignId])).toEqual([["PROMOTION", "*"]]);
  expect(edited.revision).toBe(created.revision);
  const after = await prisma.promotionPricingRevision.findUniqueOrThrow({ where: { id: PROMOTION_REVISION_ID } });
  expect(after.revision).toBe(before.revision);
});

test("GQ09b priority preflight flags live collisions but never changes promotion revision", async ({ page, context }) => {
  const name = "GQ09b Priority " + runId;
  await prisma.giftQuantityCampaign.create({
    data: {
      kind: "QUANTITY_TIER", name, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
      tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", stackPriority: 17,
      stackingEnabled: true, isEnabled: true, enabledAt: new Date(),
      tiers: { create: [{ minQuantity: 2, discountValue: 10 }] },
    },
  });
  const before = await prisma.promotionPricingRevision.findUniqueOrThrow({ where: { id: PROMOTION_REVISION_ID } });
  await context.addCookies(adminCookies);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Loại chiến dịch" }).selectOption("QUANTITY_TIER");
  await page.getByRole("checkbox", { name: /Cho phép cộng dồn khi cả hai/ }).check();
  const priority = page.getByRole("textbox", { name: /Mức ưu tiên \(0/ });
  await priority.fill("17");
  await page.getByRole("button", { name: "Kiểm tra mức ưu tiên" }).click();
  await expect(page.getByRole("status").filter({ hasText: "đã có chiến dịch còn hiệu lực" })).toBeVisible();
  await priority.fill("18");
  await page.getByRole("button", { name: "Kiểm tra mức ưu tiên" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chưa phát hiện xung đột" })).toBeVisible();
  const after = await prisma.promotionPricingRevision.findUniqueOrThrow({ where: { id: PROMOTION_REVISION_ID } });
  expect(after.revision).toBe(before.revision);
});

test("GQ09b moving between Sửa links remounts the edit form and never writes campaign A's rule onto B", async ({ page, context }) => {
  const nameA = "GQ09b Key A " + runId;
  const nameB = "GQ09b Key B " + runId;
  const common = { kind: "QUANTITY_TIER", scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"], stackingEnabled: true } as const;
  const a = await prisma.giftQuantityCampaign.create({
    data: {
      ...common, name: nameA, tierUnit: "PERCENTAGE", tierDiscountedUnits: "FROM_REACHED_THRESHOLD",
      tierSelectionPriority: "CHEAPEST_FIRST", stackPriority: 31,
      tiers: { create: [{ minQuantity: 2, discountValue: 10 }, { minQuantity: 4, discountValue: 15 }] },
      stackPeers: { create: [{ peerKind: "PROMOTION", peerCampaignId: "*" }] },
    },
  });
  const b = await prisma.giftQuantityCampaign.create({
    data: {
      ...common, name: nameB, tierUnit: "FIXED_AMOUNT_PER_UNIT_VND", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      stackPriority: 32,
      tiers: { create: [{ minQuantity: 3, discountValue: 20000 }] },
      stackPeers: { create: [{ peerKind: "CLEARANCE", peerCampaignId: "*" }] },
    },
  });
  const read = (id: string) => prisma.giftQuantityCampaign.findUniqueOrThrow({
    where: { id }, include: { tiers: { orderBy: { minQuantity: "asc" } }, stackPeers: true },
  });

  await context.addCookies(adminCookies);
  await page.goto(PAGE + "?edit=" + a.id, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Chỉnh sửa: " + nameA })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Tên chiến dịch" })).toHaveValue(nameA);
  await expect(page.getByRole("combobox", { name: "Đơn vị giảm giá" })).toHaveValue("PERCENTAGE");
  await expect(page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" })).toHaveValue("4");

  // A client-side navigation, not a reload: the page keeps the same form position and receives B's props.
  await page.getByRole("link", { name: "Sửa " + nameB }).click();
  await expect(page).toHaveURL(PAGE + "?edit=" + b.id);
  await expect(page.getByRole("heading", { name: "Chỉnh sửa: " + nameB })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Tên chiến dịch" })).toHaveValue(nameB);
  await expect(page.getByRole("combobox", { name: "Đơn vị giảm giá" })).toHaveValue("FIXED_AMOUNT_PER_UNIT_VND");
  await expect(page.getByRole("combobox", { name: "Chiếc được giảm", exact: true })).toHaveValue("ALL_ELIGIBLE_UNITS");
  await expect(page.getByRole("combobox", { name: "Ưu tiên chiếc được giảm" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Bậc 1: từ số chiếc" })).toHaveValue("3");
  await expect(page.getByRole("textbox", { name: "Mức giảm (VND/chiếc)" })).toHaveValue("20000");
  await expect(page.getByRole("textbox", { name: "Bậc 2: từ số chiếc" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Cho phép cộng dồn khi cả hai/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: /Mức ưu tiên \(0/ })).toHaveValue("32");
  await expect(page.getByRole("combobox", { name: "Đối tác 1: loại" })).toHaveValue("CLEARANCE");

  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(nameB + " edited");
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page).toHaveURL(PAGE + "?status=ok");

  const [savedA, savedB] = [await read(a.id), await read(b.id)];
  expect(savedA.name).toBe(nameA);
  expect(savedA.tierUnit).toBe("PERCENTAGE");
  expect(savedA.tiers.map((tier) => [tier.minQuantity, tier.discountValue])).toEqual([[2, 10], [4, 15]]);
  expect(savedA.stackPeers.map((peer) => [peer.peerKind, peer.peerCampaignId])).toEqual([["PROMOTION", "*"]]);
  expect(savedB.name).toBe(nameB + " edited");
  expect(savedB.tierUnit).toBe("FIXED_AMOUNT_PER_UNIT_VND");
  expect(savedB.tierDiscountedUnits).toBe("ALL_ELIGIBLE_UNITS");
  expect(savedB.stackPriority).toBe(32);
  expect(savedB.tiers.map((tier) => [tier.minQuantity, tier.discountValue])).toEqual([[3, 20000]]);
  expect(savedB.stackPeers.map((peer) => [peer.peerKind, peer.peerCampaignId])).toEqual([["CLEARANCE", "*"]]);
});

// --- GQ13b: the gift rule form (thresholds, cap, duplicates, allowlist, entitlement preview)

async function giftProduct(suffix: string, options: Readonly<{ stock?: number }> = {}) {
  const { stock = 5 } = options;
  const id = `gq13b-${runId}-${suffix}`;
  const created = await prisma.productMirror.create({
    data: {
      id, pancakeShopId: 920942, pancakeProductId: `${id}-ext`, slug: `${id}-slug`, name: `GQ13b ${suffix} ${runId}`,
      isActive: true, isPresent: true, syncedAt: new Date(),
      variants: {
        create: {
          id: `${id}-v`, pancakeVariationId: `${id}-var`, color: "Hồng", size: "M", sku: `GQ13B-${suffix}`, isActive: true, isPresent: true,
          pancakeRetailPrice: 100_000, syncedAt: new Date(),
          warehouseStocks: stock > 0 ? { create: { pancakeWarehouseId: `gq13b-${runId}`, quantity: stock, syncedAt: new Date() } } : undefined,
        },
      },
    },
    include: { variants: true },
  });
  return created.variants[0]!.id;
}

test("GQ13b gift form: threshold, cap, duplicates and allowlist round-trip through the real form, with a live entitlement preview", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const okVariant = await giftProduct("ok", { stock: 5 });
  await giftProduct("dry", { stock: 0 });
  const comboVariant = await giftProduct("combo");
  const partVariant = await giftProduct("part");
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: comboVariant, componentVariantId: partVariant, quantity: 1, syncedAt: new Date() } });

  await context.addCookies(adminCookies);
  await page.setViewportSize({ width: 390, height: 844 });
  await watchDocumentTitle(page);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  const name = "GQ13b Gift " + runId;
  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(name);
  await page.getByRole("combobox", { name: "Nhận quà khi" }).selectOption("QUANTITY");
  await page.getByRole("checkbox", { name: "Set váy" }).check();
  await page.getByRole("textbox", { name: "Số lượng tối thiểu (N)" }).fill("2");
  await page.getByRole("textbox", { name: "Số quà tối đa mỗi đơn (tùy chọn)" }).fill("3");
  await page.getByRole("checkbox", { name: /Cho phép tặng trùng quà/ }).check();

  // Search is shop-scoped and tells the operator why a variant cannot be chosen.
  const search = page.getByRole("searchbox", { name: "Tìm quà theo tên, SKU, màu hoặc size" });
  await search.fill(runId);
  await search.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Tìm thấy 4 phiên bản." })).toBeVisible();
  const results = page.getByRole("list", { name: "Kết quả tìm quà" });
  await expect(results.getByRole("listitem").filter({ hasText: "ok " + runId })).toContainText("kho 5");
  await expect(results.getByRole("listitem").filter({ hasText: "dry " + runId })).toContainText("hết hàng sẵn sàng");
  await expect(results.getByRole("listitem").filter({ hasText: "combo " + runId })).toContainText("kho 5");
  await expect(results.getByRole("button", { name: /Thêm .*dry/ })).toBeDisabled();
  await expect(results.getByRole("button", { name: /Thêm .*combo/ })).toBeEnabled();
  await results.getByRole("button", { name: /Thêm .*ok /i }).click();
  const chosen = page.getByRole("list", { name: "Quà đã chọn" });
  await expect(chosen.getByRole("listitem")).toHaveCount(1);
  // A composite with READY components is a real selectable option in the Admin form.
  await results.getByRole("button", { name: /Thêm .*combo/ }).click();
  await expect(chosen.getByRole("listitem")).toHaveCount(2);
  await chosen.getByRole("button", { name: /Bỏ .*combo/ }).click();
  await expect(chosen.getByRole("listitem")).toHaveCount(1);
  await expect(results.getByRole("button", { name: /Đã chọn/ })).toBeDisabled();

  // The preview is the real entitlement engine on a sample line: floor(Q / N), then the per-order cap.
  await page.getByRole("textbox", { name: "Thử thêm số lượng (tùy chọn)" }).fill("10");
  await page.getByRole("button", { name: "Xem trước quyền lợi" }).click();
  const table = page.getByRole("table", { name: "Số quà tặng theo số lượng minh họa" });
  await expect(table.getByRole("row", { name: /Q=1 / })).toContainText("0");
  await expect(table.getByRole("row", { name: /Q=2 / })).toContainText("Còn thiếu 2 chiếc");
  await expect(table.getByRole("row", { name: /Q=4 / })).toContainText("Còn thiếu 2 chiếc");
  const capped = table.getByRole("row", { name: /Q=10 / });
  await expect(capped).toContainText("Đã chạm giới hạn quà mỗi đơn");
  await expect(table.getByRole("row", { name: /Q=6 / }).getByRole("cell").nth(1)).toHaveText("3");
  await expect(table.getByRole("row", { name: /Q=10 / }).getByRole("cell").nth(0)).toHaveText("5");
  await expect(table.getByRole("row", { name: /Q=10 / }).getByRole("cell").nth(1)).toHaveText("3");

  await expectSettledDocumentTitle(page);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);

  await page.getByRole("button", { name: "Tạo bản nháp" }).click();
  await expect(page).toHaveURL(PAGE + "?status=ok");
  const created = await prisma.giftQuantityCampaign.findFirstOrThrow({ where: { name }, include: { giftOptions: true } });
  expect([created.giftTrigger, created.minimumQuantity, created.maxGiftsPerOrder, created.allowDuplicateGifts, created.isEnabled]).toEqual(["QUANTITY", 2, 3, true, false]);
  expect(created.giftOptions.map((option) => option.variantId)).toEqual([okVariant]);

  // Edit: everything is read back; swapping the allowlist keeps an unavailable variant visible with its reason.
  await page.goto(PAGE + "?edit=" + created.id, { waitUntil: "networkidle" });
  await expect(page.getByRole("textbox", { name: "Số lượng tối thiểu (N)" })).toHaveValue("2");
  await expect(page.getByRole("textbox", { name: "Số quà tối đa mỗi đơn (tùy chọn)" })).toHaveValue("3");
  await expect(page.getByRole("checkbox", { name: /Cho phép tặng trùng quà/ })).toBeChecked();
  await expect(page.getByRole("list", { name: "Quà đã chọn" }).getByRole("listitem")).toContainText("ok " + runId);
  await page.getByRole("textbox", { name: "Số lượng tối thiểu (N)" }).fill("4");
  await page.getByRole("checkbox", { name: /Cho phép tặng trùng quà/ }).uncheck();
  await page.getByRole("button", { name: /Bỏ .*ok / }).click();
  await expect(page.getByRole("list", { name: "Quà đã chọn" })).toHaveCount(0);
  const editSearch = page.getByRole("searchbox", { name: "Tìm quà theo tên, SKU, màu hoặc size" });
  await editSearch.fill("part " + runId);
  await editSearch.press("Enter");
  await page.getByRole("list", { name: "Kết quả tìm quà" }).getByRole("button", { name: /Thêm/ }).click();
  await page.getByRole("button", { name: "Lưu thay đổi" }).click();
  await expect(page).toHaveURL(PAGE + "?status=ok");
  const edited = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: created.id }, include: { giftOptions: true } });
  expect([edited.minimumQuantity, edited.maxGiftsPerOrder, edited.allowDuplicateGifts]).toEqual([4, 3, false]);
  expect(edited.giftOptions.map((option) => option.variantId)).toEqual([partVariant]);

  // A stored option that stops being giftable stays visible with its reason (the server refuses it at publish).
  await prisma.warehouseStock.updateMany({ where: { variantId: partVariant }, data: { quantity: 0 } });
  await page.goto(PAGE + "?edit=" + created.id, { waitUntil: "networkidle" });
  await expect(page.getByRole("list", { name: "Quà đã chọn" })).toContainText("Hiện không tặng được: hết hàng sẵn sàng");
  expect(errors).toEqual([]);
});

test("GQ13b gift form: a subtotal gift previews boundaries, and malformed input is refused by the server with a typed message and no write", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(PAGE + "?new=1", { waitUntil: "networkidle" });
  const name = "GQ13b Subtotal " + runId;
  await page.getByRole("textbox", { name: "Tên chiến dịch" }).fill(name);
  await page.getByRole("combobox", { name: "Nhận quà khi" }).selectOption("ORDER_SUBTOTAL");
  await page.getByRole("combobox", { name: "Giá trị đơn hàng tính trên" }).selectOption("ALL_PAID_LINES");
  // Fields follow the trigger: the subtotal ones show, the quantity one does not.
  await expect(page.getByRole("textbox", { name: "Số lượng tối thiểu (N)" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Giá trị đơn hàng tối thiểu (VND)" }).fill("880000");

  await page.getByRole("button", { name: "Xem trước quyền lợi" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Hãy chọn cách tặng quà" })).toBeVisible();
  await page.getByRole("combobox", { name: "Cách tặng quà" }).selectOption("REPEAT_PER_THRESHOLD");
  await page.getByRole("button", { name: "Xem trước quyền lợi" }).click();
  const table = page.getByRole("table", { name: "Số quà tặng theo giá trị đơn hàng minh họa" });
  await expect(table.getByRole("row", { name: /879\.999đ/ }).getByRole("cell").nth(0)).toHaveText("0");
  await expect(table.getByRole("row", { name: /^880\.000đ/ }).getByRole("cell").nth(0)).toHaveText("1");
  await expect(table.getByRole("row", { name: /1\.760\.000đ/ }).getByRole("cell").nth(0)).toHaveText("2");
  await page.getByRole("combobox", { name: "Cách tặng quà" }).selectOption("ONCE");
  await page.getByRole("button", { name: "Xem trước quyền lợi" }).click();
  await expect(table.getByRole("row", { name: /1\.760\.000đ/ }).getByRole("cell").nth(0)).toHaveText("1");

  // The client only hints; a malformed value is refused by the server and nothing is written.
  await page.getByRole("textbox", { name: "Giá trị đơn hàng tối thiểu (VND)" }).fill("12abc");
  await page.getByRole("button", { name: "Xem trước quyền lợi" }).click();
  await expect(page.getByRole("status").filter({ hasText: "số nguyên dương" })).toBeVisible();
  await page.getByRole("button", { name: "Tạo bản nháp" }).click();
  await expect(page).toHaveURL(PAGE + "?status=error&reason=INVALID_GIFT_MINIMUM_SUBTOTAL");
  const status = page.locator("#promotion-admin-status");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toContainText("Giá trị đơn hàng tối thiểu để nhận quà phải là số nguyên dương");
  expect(await prisma.giftQuantityCampaign.count({ where: { name } })).toBe(0);
});
