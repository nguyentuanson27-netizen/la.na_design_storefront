/**
 * Voucher v1 V07 in a real browser: the Admin voucher screen (`/admin/promotions/vouchers`).
 *
 * What needs a browser rather than a unit or database test: that the list and the form have no Axe violations and are operable
 * by keyboard, that a campaign written through the REAL form lands in the database exactly as typed (inactive, revision 1),
 * that the Admin's "Bật" is the only thing that activates it, that a stale revision and a hostile URL reason are refused
 * without writing or echoing anything, that "Sao chép" makes a new draft, that the screen says plainly the feature is OFF on
 * the server, that a visitor who is not an Admin never sees it, and that it stays usable at a phone width.
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
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

const HOST = "127.0.0.1";
const PORT = 3364 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0);
const BASE_URL = `http://${HOST}:${PORT}`;
const PAGE = `${BASE_URL}/admin/promotions/vouchers`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP = 920_951;

const runId = `${Date.now()}-${process.pid}`;
const adminEmail = `admin-voucher-${runId}@example.invalid`;
const visitorEmail = `visitor-voucher-${runId}@example.invalid`;
const password = "admin-voucher-runtime-password-123";
const seededName = `V07 Seeded ${runId}`;
const createdName = `V07 Created ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let adminCookies: Array<{ name: string; value: string; url: string }> = [];
let visitorCookies: Array<{ name: string; value: string; url: string }> = [];

const capture = (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000); };

function cookiesFrom(headers: Headers) {
  return headers.getSetCookie().map((header) => {
    const pair = header.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("Better Auth returned a malformed Set-Cookie header");
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: BASE_URL };
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`Next.js server exited with ${server.exitCode}\n${serverOutput}`);
    try { if ((await fetch(`${BASE_URL}/`, { redirect: "manual" })).status < 500) return; } catch { /* compiling */ }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the server\n${serverOutput}`);
}

async function cleanupDatabase() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, visitorEmail] } } });
}

async function signUp(email: string, name: string) {
  const { headers } = await auth.api.signUpEmail({ returnHeaders: true, headers: new Headers({ "x-ci-client-ip": "203.0.113.45" }), body: { name, email, password } });
  return cookiesFrom(headers);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await cleanupDatabase();
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", name: seededName, fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000), maxUses: 10 },
  });
  adminCookies = await signUp(adminEmail, "Admin Voucher Runtime");
  await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });
  visitorCookies = await signUp(visitorEmail, "Visitor Voucher Runtime");

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    // The voucher gate is left at its default, OFF: that is the state the feature ships in.
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP),
      PANCAKE_API_KEY: "admin-voucher-test-key",
      ...nextServerEnv(`.next-test/admin-voucher-${runId}`),
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);
  await waitForServer();
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
    if (!exited) server.kill("SIGKILL");
  }
  await cleanupDatabase();
  await prisma.$disconnect();
});

// Optional review screenshots (H4): written only when H4_SHOTS_DIR is set; CI never sets it, so this changes nothing there.
const SHOTS_DIR = process.env.H4_SHOTS_DIR;
async function shot(page: import("@playwright/test").Page, name: string) {
  if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/${name}.png`, fullPage: true });
}

const row = (page: import("@playwright/test").Page, name: string) => page.locator("article", { hasText: name });

test("V07 the list renders, says the feature is OFF on the server, has no Axe violations and is keyboard reachable", async ({ page, context }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await context.addCookies(adminCookies);
  await page.goto(PAGE, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Voucher", level: 1 })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("LA_VOUCHER_ENABLED");
  await expect(row(page, seededName)).toContainText("Nháp");
  await expect(row(page, seededName)).toContainText("Giảm 50.000đ · Đơn từ 600.000đ");
  await shot(page, "admin-list");

  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);

  // Everything is reachable with the keyboard, in a sensible order, and the focus ring is not removed.
  await page.getByRole("link", { name: "Tạo voucher" }).focus();
  await expect(page.getByRole("link", { name: "Tạo voucher" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: seededName })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row(page, seededName).getByRole("button", { name: /^Bật/ })).toBeFocused();
  expect(browserErrors).toEqual([]);
});

test("V07 the create form has no Axe violations, and a campaign written through it lands in the database exactly as typed, inactive", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?new=1`, { waitUntil: "networkidle" });
  await expect(page.getByRole("textbox", { name: "Tên voucher" })).toBeVisible();
  const formAxe = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(formAxe.violations).toEqual([]);

  await page.getByRole("textbox", { name: "Tên voucher" }).fill(createdName);
  await page.getByRole("radio", { name: "Giảm tiền hàng" }).check();
  await page.getByRole("radio", { name: "Khách nhập mã" }).check();
  await page.getByRole("radio", { name: "Riêng tư (chỉ hiện sau khi nhập mã)" }).check();
  await page.getByLabel(/^Mã \(3–32/).fill("V07-KOL70");
  await page.getByRole("radio", { name: "Số tiền cố định" }).check();
  await page.getByLabel("Số tiền giảm (đồng)").fill("70000");
  await page.getByLabel(/^Giá trị đơn tối thiểu/).fill("700000");
  await page.getByLabel("Tổng số lượt dùng (tuỳ chọn)").fill("25");
  await page.getByLabel("Ngân sách tối đa (đồng, tuỳ chọn)").fill("1750000");
  await shot(page, "admin-form-filled");
  const formAxeFilled = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(formAxeFilled.violations).toEqual([]);
  await page.getByRole("button", { name: "Lưu voucher" }).click();

  await expect(page.getByRole("status")).toContainText("Đã lưu");
  const saved = await prisma.voucherCampaign.findFirstOrThrow({ where: { pancakeShopId: SHOP, name: createdName } });
  expect([saved.kind, saved.issuance, saved.visibility, saved.code, saved.discountType]).toEqual(["MERCHANDISE", "CODE", "PRIVATE", "V07-KOL70", "FIXED_AMOUNT_VND"]);
  expect([saved.fixedAmountVnd, saved.minEligibleSubtotalVnd, saved.maxUses, saved.maxBudgetVnd]).toEqual([BigInt(70_000), BigInt(700_000), 25, BigInt(1_750_000)]);
  expect(saved.isEnabled, "a created voucher never activates itself").toBe(false);
  expect(saved.revision).toBe(1);
});

test("V07 a refused form says why (the server rule, not just the browser), writes nothing and keeps what the Admin typed", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  const before = await prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP } });
  await page.goto(`${PAGE}?new=1`, { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Tên voucher" }).fill(`V07 Refused ${runId}`);
  await page.getByRole("radio", { name: "Số tiền cố định" }).check();
  await page.getByLabel("Số tiền giảm (đồng)").fill("90000");
  await page.getByLabel(/^Giá trị đơn tối thiểu/).fill("80000"); // the minimum must exceed the amount: the server decides, not the browser
  await page.getByRole("button", { name: "Lưu voucher" }).click();
  await expect(page.locator("p[role='alert']")).toBeVisible();
  await expect(page.locator("p[role='alert']")).toContainText("Giá trị đơn tối thiểu phải lớn hơn số tiền giảm");
  // What was typed is still there to correct (the form is not emptied by the refusal).
  await expect(page.getByRole("textbox", { name: "Tên voucher" })).toHaveValue(`V07 Refused ${runId}`);
  await expect(page.getByLabel("Số tiền giảm (đồng)")).toHaveValue("90000");
  await expect(page.getByLabel(/^Giá trị đơn tối thiểu/)).toHaveValue("80000");
  expect(await prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP } })).toBe(before);
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("V07 'Bật' is the only thing that activates a voucher; a stale revision is refused without writing; 'Sao chép' makes a new draft", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(PAGE, { waitUntil: "networkidle" });
  const seeded = await prisma.voucherCampaign.findFirstOrThrow({ where: { pancakeShopId: SHOP, name: seededName } });

  // A form whose hidden revision is old (another admin changed it) is refused, and nothing is written.
  await row(page, seededName).locator('input[name="revision"]').first().evaluate((input: HTMLInputElement) => { input.value = "999"; });
  await row(page, seededName).getByRole("button", { name: /^Bật/ }).click();
  await expect(page.locator("p[role='alert']")).toContainText("Voucher đã thay đổi");
  expect((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: seeded.id } })).isEnabled).toBe(false);

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await row(page, seededName).getByRole("button", { name: /^Bật/ }).click();
  await expect(page.getByRole("status")).toContainText("Đã lưu");
  const enabled = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: seeded.id } });
  expect(enabled.isEnabled).toBe(true);
  expect(enabled.revision).toBeGreaterThan(seeded.revision);
  await expect(row(page, seededName)).toContainText("Đang chạy");

  const copies = await prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP } });
  await row(page, seededName).getByRole("button", { name: /^Sao chép/ }).click();
  await expect.poll(() => prisma.voucherCampaign.count({ where: { pancakeShopId: SHOP } })).toBe(copies + 1);
  const copy = await prisma.voucherCampaign.findFirstOrThrow({ where: { pancakeShopId: SHOP, id: { not: seeded.id }, name: { contains: seededName } }, orderBy: { createdAt: "desc" } });
  expect(copy.isEnabled, "a copy is a new draft").toBe(false);

  // Turning it off keeps the ledger and makes it read-only: it cannot be switched back on.
  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.locator("article", { hasText: "Đang chạy" }).filter({ hasText: seededName }).getByRole("button", { name: /^Tắt/ }).click();
  await expect(page.getByRole("status")).toContainText("Đã lưu");
  expect((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: seeded.id } })).isEnabled).toBe(false);
  await page.goto(`${PAGE}?edit=${encodeURIComponent(seeded.id)}`, { waitUntil: "networkidle" });
  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("V07 a voucher that is already running can be edited (economics), keeps its identity, and a forged identity is refused", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  const running = await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: `V07-RUN-${runId.slice(-6)}`, discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: `V07 Running ${runId}`, fixedAmountVnd: BigInt(40_000), minEligibleSubtotalVnd: BigInt(500_000), maxUses: 10, maxBudgetVnd: BigInt(400_000) },
  });
  await page.goto(`${PAGE}?edit=${encodeURIComponent(running.id)}`, { waitUntil: "networkidle" });
  await expect(page.getByText("Đã bật nên loại, cách phát hành, hiển thị và mã không đổi được")).toBeVisible();
  await page.getByLabel("Tổng số lượt dùng (tuỳ chọn)").fill("40");
  await page.getByLabel("Ngân sách tối đa (đồng, tuỳ chọn)").fill("1600000");
  await page.getByLabel("Số tiền giảm (đồng)").fill("45000");
  await page.getByRole("button", { name: "Lưu voucher" }).click();
  await expect(page.getByRole("status")).toContainText("Đã lưu");
  const saved = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: running.id } });
  expect([saved.maxUses, saved.maxBudgetVnd, saved.fixedAmountVnd]).toEqual([40, BigInt(1_600_000), BigInt(45_000)]);
  expect(saved.revision).toBeGreaterThan(running.revision);
  expect([saved.kind, saved.issuance, saved.visibility, saved.code, saved.isEnabled]).toEqual(["MERCHANDISE", "CODE", "PRIVATE", running.code, true]);

  // A forged identity (the hidden mirror edited in the browser) is refused by the server and nothing is written.
  await page.goto(`${PAGE}?edit=${encodeURIComponent(running.id)}`, { waitUntil: "networkidle" });
  await page.locator('input[type="hidden"][name="kind"]').evaluate((input: HTMLInputElement) => { input.value = "SHIPPING_FREE"; });
  await page.getByLabel("Tổng số lượt dùng (tuỳ chọn)").fill("99");
  await page.getByRole("button", { name: "Lưu voucher" }).click();
  await expect(page.locator("p[role='alert']")).toContainText("Loại voucher, cách phát hành, hiển thị và mã không đổi được");
  const after = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: running.id } });
  expect([after.kind, after.maxUses, after.revision]).toEqual(["MERCHANDISE", 40, saved.revision]);
});

test("V07 a hand-edited URL reason is never echoed and falls back to one generic sentence", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.goto(`${PAGE}?reason=STALE_REVISION`, { waitUntil: "networkidle" });
  await expect(page.locator("p[role='alert']")).toContainText("Voucher đã thay đổi");
  for (const reason of ["NOPE", "__proto__", "constructor", "%3Cscript%3Ealert(1)%3C%2Fscript%3E"]) {
    await page.goto(`${PAGE}?reason=${reason}`, { waitUntil: "networkidle" });
    await expect(page.locator("p[role='alert']")).toBeVisible();
    await expect(page.locator("p[role='alert']")).not.toContainText(reason.replace(/%3C|%3E|%2F/g, ""));
  }
});

test("V07 a signed-in visitor who is not an Admin, and a signed-out one, never see the screen", async ({ browser }) => {
  for (const cookies of [visitorCookies, []]) {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Voucher", level: 1 })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Tạo voucher" })).toHaveCount(0);
    await expect(page.getByText(seededName)).toHaveCount(0);
    await context.close();
  }
});

test("V07 the list and the form stay usable at a phone width", async ({ page, context }) => {
  await context.addCookies(adminCookies);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of [PAGE, `${PAGE}?new=1`]) {
    await page.goto(url, { waitUntil: "networkidle" });
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows, url).toBe(false);
    const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(accessibility.violations).toEqual([]);
  }
});
