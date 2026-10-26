import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * Voucher v1 in a real browser (V16/V17/V19, AC-12/AC-13/AC-26/AC-40; the preview never holds, AC-42 for the picker): the picker on mobile and desktop,
 * keyboard and focus, the server-owned selection, that a draft is never saved until "Áp dụng", the private-code flow,
 * the marketing link that never lets the code reach a rendered document, and the PDP teaser.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 3361;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = 940_020;
const P = "vchr-ui-";

let server: ChildProcess;
let output = "";
let cartId = "";
let productSlug = "";
let ids: { m50: string; far: string; ship: string; priv: string };

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: "voucher-code-" } } });
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), NEXT_SERVER_COMMAND, "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP),
      LA_VOUCHER_ENABLED: "true",
      // A cart offer needs the same readiness as a hold: POS-verified shop, gift/quantity gate, line-level pricing.
      LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-VCHRTST",
      BETTER_AUTH_URL: BASE,
      APP_DOMAIN: `127.0.0.1:${PORT}`,
      ...nextServerEnv(".next-test/voucher-picker"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  for (let attempt = 0; attempt < 700; attempt += 1) {
    try { if ((await fetch(`${BASE}/cart`)).ok) return child; } catch { /* compiling */ }
    if (child.exitCode !== null) throw new Error(output);
    await delay(500);
  }
  child.kill("SIGKILL");
  throw new Error(output);
}

test.beforeAll(async () => {
  test.setTimeout(420_000); // the first request compiles the app
  server = await startServer();
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((done) => server.once("exit", done)), delay(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await cleanup();
  await prisma.$disconnect();
});

test.beforeEach(async ({ context }) => {
  await cleanup();
  const now = new Date();
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}dress`, slug: `${P}dress`, name: "Đầm voucher", isActive: true, isPresent: true, syncedAt: now,
      variants: { create: { pancakeVariationId: `${P}dress-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: now, pancakeRetailPrice: 450_000, pancakeRetailPriceAfterDiscount: 450_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}wh`, quantity: 20, syncedAt: now } } } },
    },
    include: { variants: true },
  });
  productSlug = created.slug;
  await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: "vayDam" } });
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId: created.variants[0]!.id, quantity: 2 } } } })).id;
  const base = { pancakeShopId: SHOP, kind: "MERCHANDISE" as const, issuance: "AUTO" as const, visibility: "PUBLIC" as const, discountType: "FIXED_AMOUNT_VND" as const, scopeMode: "ALL_SHOP" as const, isEnabled: true, enabledAt: now };
  const m50 = await prisma.voucherCampaign.create({ data: { ...base, name: "Giảm 50K", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  const far = await prisma.voucherCampaign.create({ data: { ...base, name: "Giảm 200K", fixedAmountVnd: BigInt(200_000), minEligibleSubtotalVnd: BigInt(2_000_000) } });
  const ship = await prisma.voucherCampaign.create({ data: { ...base, name: "Freeship", kind: "SHIPPING_FREE", discountType: null, minEligibleSubtotalVnd: BigInt(600_000) } });
  const priv = await prisma.voucherCampaign.create({ data: { ...base, name: "KOL 70K", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  ids = { m50: m50.id, far: far.id, ship: ship.id, priv: priv.id };
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});

const selection = () => prisma.cartVoucherSelection.findUnique({ where: { cartId } });
const trigger = (page: Page) => page.locator("[data-voucher-picker] > button");

test("AC-12: the picker shows two groups, NONE options, the exact shortfall and the footer count, with no axe violations, on mobile and desktop", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}/cart`);
    await expect(trigger(page)).toContainText("Đang dùng 2 ưu đãi");
    await trigger(page).click();
    const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: /Voucher giảm tiền hàng/ })).toBeVisible();
    await expect(dialog.getByRole("group", { name: /Voucher vận chuyển/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Không dùng voucher vận chuyển/ })).toBeVisible();
    // 900K cart; the 200K voucher needs 2.000.000đ: the server says exactly how much more.
    await expect(dialog.getByText("Đặt thêm 1.100.000đ để được hưởng ưu đãi này")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Giảm 200.000đ/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Áp dụng • 2 ưu đãi" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("dialog").withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
    // Touch targets: every radio row is at least 44px tall.
    const heights = await dialog.locator("label:has(input[type=radio])").evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  }
});

test("AC-26 / AC-42: choosing in the picker previews on the server and saves nothing until Áp dụng; closing keeps the old choice", async ({ page }) => {
  await page.goto(`${BASE}/cart`);
  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  // Nothing is optimistic: the radio flips when the server answers, so click and wait for the answer.
  await dialog.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ }).click();
  await expect(dialog.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Bỏ qua ưu đãi và tiếp tục" }).or(dialog.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }))).toBeVisible();
  expect(await selection()).toBeNull();
  await page.keyboard.press("Escape");
  expect(await selection()).toBeNull();
  await expect(trigger(page)).toContainText("Đang dùng 2 ưu đãi");
  // Reopened, the saved choice is what is shown, not the discarded draft.
  await trigger(page).click();
  await expect(dialog.getByRole("radio", { name: /Giảm 50.000đ/ })).toBeChecked();
});

test("V16: Áp dụng commits both groups on the server and the cart shows what the server decided", async ({ page }) => {
  await page.goto(`${BASE}/cart`);
  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByRole("radio", { name: /Không dùng voucher vận chuyển/ }).click();
  await expect(dialog.getByRole("radio", { name: /Không dùng voucher vận chuyển/ })).toBeChecked();
  await dialog.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await selection())?.shippingMode).toBe("MANUAL");
  const saved = await selection();
  expect(saved?.shippingVoucherId).toBeNull();
  expect(saved?.merchandiseMode).toBe("AUTO");
  await expect(trigger(page)).toContainText("Đang dùng 1 ưu đãi");
  // No hold was created by any of this.
  expect(await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } })).toBe(0);
});

test("AC-13: a private code is applied through the picker; a wrong code gets one generic answer", async ({ page }) => {
  await page.goto(`${BASE}/cart`);
  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await expect(dialog.getByText("KOL 70K")).toHaveCount(0);
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("WRONG123");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Mã không hợp lệ hoặc đã hết hiệu lực");
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("kol70");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog.getByRole("radio", { name: /Giảm 70.000đ/ })).toBeChecked();
  await expect.poll(async () => (await selection())?.merchandiseVoucherId).toBe(ids.priv);
  expect(JSON.stringify(await selection())).not.toMatch(/KOL70/i);
});

test("AC-40: a marketing link is redirected to a clean URL; the code is never in a rendered page, and the redirect is no-referrer / no-store", async ({ page, context }) => {
  const responses: { url: string; status: number; referrerPolicy: string | null; cacheControl: string | null }[] = [];
  page.on("response", (response) => {
    responses.push({ url: response.url(), status: response.status(), referrerPolicy: response.headers()["referrer-policy"] ?? null, cacheControl: response.headers()["cache-control"] ?? null });
  });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto(`${BASE}/shop/${productSlug}?voucher=KOL70&utm_source=fb`);
  expect(new URL(page.url()).search).toBe("?utm_source=fb");
  expect(page.url()).not.toMatch(/KOL70/i);
  const redirects = responses.filter((r) => r.status >= 300 && r.status < 400);
  expect(redirects.length).toBeGreaterThanOrEqual(2);
  for (const redirect of redirects) {
    expect(redirect.referrerPolicy).toBe("no-referrer");
    expect(redirect.cacheControl).toContain("no-store");
  }
  // Every document, script and beacon request after the first hop is on the clean URL.
  expect(requested.filter((url) => !url.includes("/voucher-link") && url !== `${BASE}/shop/${productSlug}?voucher=KOL70&utm_source=fb`).some((url) => /KOL70/i.test(url))).toBe(false);
  expect(await page.content()).not.toMatch(/KOL70/i);
  // The cart already existed, so the code was validated and locked server-side.
  await expect.poll(async () => (await selection())?.merchandiseVoucherId).toBe(ids.priv);
  void context;
});

test("AC-13 / V19: with no cart yet, the link's code waits in an HttpOnly cookie and the cart only OFFERS it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/shop/${productSlug}?voucher=KOL70`);
  expect(page.url()).toBe(`${BASE}/shop/${productSlug}`);
  const cookies = await context.cookies(BASE);
  const pending = cookies.find((cookie) => cookie.name === "la_voucher_code");
  expect(pending?.httpOnly).toBe(true);
  expect(pending?.value).toBe("KOL70");
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/KOL70/);
  await context.close();
});

test("a link with a bad code still loses the parameter and applies nothing", async ({ page }) => {
  await page.goto(`${BASE}/shop/${productSlug}?voucher=bad%20code!`);
  expect(new URL(page.url()).search).toBe("");
  expect(await selection()).toBeNull();
});

test("V17: the PDP names the vouchers that cover the product and promises nothing", async ({ page }) => {
  await page.goto(`${BASE}/shop/${productSlug}`);
  const teaser = page.locator("[data-pdp-vouchers]");
  await expect(teaser).toBeVisible();
  await expect(teaser).toContainText("Giảm 50.000đ cho đơn từ 600.000đ");
  await expect(teaser).toContainText("Voucher chỉ áp dụng khi giỏ đủ điều kiện");
  await expect(teaser).not.toContainText("KOL");
  expect(await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } })).toBe(0);
  expect((await new AxeBuilder({ page }).include("[data-pdp-vouchers]").withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});
