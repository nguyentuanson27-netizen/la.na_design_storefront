import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * Campaign names on the English storefront. Promotion, gift, shipping and voucher campaigns are named
 * by hand in Vietnamese; an admin enters the English in `/admin/promotions/name-translations`, and the
 * storefront shows it wherever the name is shown. A name with no translation stays Vietnamese.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 3363;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = 940_022;
const P = "name-en-";

let server: ChildProcess;
let output = "";
let cartId = "";
let productSlug = "";
let ids: { m50: string; far: string; ship: string; priv: string };

const TRANSLATED = {
  "Ưu đãi mùa thu": "Autumn offer",
  "Freeship toàn quốc": "Nationwide free shipping",
  "Miễn phí vận chuyển mùa thu": "Autumn free shipping",
  // The same words as the interface's own "Ưu đãi" label, which must keep saying "Offers".
  "Ưu đãi": "Autumn promotion",
  // Never published: a private voucher, a switched-off campaign, and a translation no campaign carries.
  "Bí mật nội bộ": "Internal secret",
  "Chiến dịch đã tắt": "Switched off campaign",
  "Chiến dịch mồ côi": "Orphan campaign",
} as const;

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
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
      ...nextServerEnv(".next-test/locale-campaign-names"),
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
  await prisma.campaignNameTranslation.deleteMany({ where: { source: { in: Object.keys(TRANSLATED) } } });
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
  const m50 = await prisma.voucherCampaign.create({ data: { ...base, name: "Ưu đãi mùa thu", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  const far = await prisma.voucherCampaign.create({ data: { ...base, name: "Quà tri ân khách hàng", fixedAmountVnd: BigInt(200_000), minEligibleSubtotalVnd: BigInt(2_000_000) } });
  const ship = await prisma.voucherCampaign.create({ data: { ...base, name: "Freeship toàn quốc", kind: "SHIPPING_FREE", discountType: null, minEligibleSubtotalVnd: BigInt(600_000) } });
  const priv = await prisma.voucherCampaign.create({ data: { ...base, name: "KOL 70K", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  await prisma.voucherCampaign.create({ data: { ...base, name: "Ưu đãi", fixedAmountVnd: BigInt(30_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  await prisma.voucherCampaign.create({ data: { ...base, name: "Bí mật nội bộ", issuance: "CODE", visibility: "PRIVATE", code: "SECRET1", fixedAmountVnd: BigInt(40_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  await prisma.voucherCampaign.create({ data: { ...base, name: "Chiến dịch đã tắt", isEnabled: false, fixedAmountVnd: BigInt(60_000), minEligibleSubtotalVnd: BigInt(600_000) } });
  await prisma.shippingPromotionCampaign.create({ data: { pancakeShopId: SHOP, name: "Miễn phí vận chuyển mùa thu", isEnabled: true, enabledAt: now, minimumQuantity: 1, priority: 1, stackingEnabled: false, categoryKeys: ["vayDam"] } });
  ids = { m50: m50.id, far: far.id, ship: ship.id, priv: priv.id };
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});



const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

test.beforeAll(async () => {
  // Before the first English request: the server holds the names for a short while once it has read them.
  await prisma.campaignNameTranslation.createMany({
    data: Object.entries(TRANSLATED).map(([source, text]) => ({ source, locale: "en", text })),
  });
});

test("campaign names are English on /en where an admin gave them, and Vietnamese on /", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await page.locator("[data-voucher-picker] > button").click();
  const vi = (await page.getByRole("dialog").innerText()).replace(/\s+/g, " ");
  expect(vi).toContain("Ưu đãi mùa thu");
  expect(vi).not.toContain("Autumn offer");

  await page.goto(`${BASE}/en/cart`, { waitUntil: "networkidle" });
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog");
  const en = (await dialog.innerText()).replace(/\s+/g, " ");
  expect(en).toContain("Autumn offer");
  expect(en).toContain("Nationwide free shipping");
  expect(en).not.toContain("Ưu đãi mùa thu");
  // A name nobody translated stays as the shop wrote it, rather than disappearing.
  expect(en).toContain("Quà tri ân khách hàng");
  // The accessible name of a ticket follows.
  const names = await dialog.locator("button[aria-pressed]").evaluateAll((tickets) => tickets.map((t) => t.getAttribute("aria-label") ?? ""));
  expect(names.join(" | ")).toContain("Autumn offer");
});

test("a campaign called like an interface label shows its own English and leaves the interface's label alone", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/en/cart`, { waitUntil: "networkidle" });
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog");
  // The campaign "Ưu đãi" reads as the admin's English...
  await expect(dialog.locator(".voucher-ticket__name", { hasText: "Autumn promotion" })).toBeVisible();
  // ...while the interface's own "Ưu đãi" (the picker's name and back link) still says "Offers".
  await expect(page.getByRole("dialog", { name: "Offers" })).toBeVisible();
  expect((await dialog.innerText()).replace(/\s+/g, " ")).toContain("Offers");
  // And the same label on the page behind it: the vouchers entry in the cart.
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-voucher-picker] > button")).not.toContainText("Autumn promotion");
});

test("the browser is given only the names of public, running campaigns", async ({ page, request }) => {
  for (const path of ["/en", "/en/cart", `/en/shop/${productSlug}`]) {
    const html = await (await request.get(`${BASE}${path}`)).text();
    // A private voucher, a switched-off campaign and a translation left behind by a deleted one stay on the server.
    for (const secret of ["Internal secret", "Switched off campaign", "Orphan campaign", "Bí mật nội bộ", "Chiến dịch đã tắt", "Chiến dịch mồ côi"]) {
      expect(html.includes(secret), `${path} leaks "${secret}"`).toBe(false);
    }
  }
  // The public ones are there: that is how the browser draws them in English.
  const cart = await (await request.get(`${BASE}/en/cart`)).text();
  expect(cart).toContain("Autumn offer");
  // Vietnamese is given none of it.
  const vi = await (await request.get(`${BASE}/cart`)).text();
  expect(vi).not.toContain("Autumn offer");
  void page;
});

test("the checkout's voucher lines and the shipping page's notice use the English name", async ({ page }) => {
  await page.goto(`${BASE}/en/checkout`, { waitUntil: "networkidle" });
  const panel = page.locator("[data-checkout-vouchers]");
  await expect(panel).toBeVisible();
  const text = (await panel.innerText()).replace(/\s+/g, " ");
  expect(text).toContain("Autumn offer");
  expect(text).not.toMatch(VIETNAMESE);

  await page.goto(`${BASE}/en/shipping`, { waitUntil: "networkidle" });
  const notice = (await page.locator("#main-content").innerText()).replace(/\s+/g, " ");
  expect(notice).toContain("Autumn free shipping");
  expect(notice).not.toContain("Miễn phí vận chuyển mùa thu");
  expect(notice).toContain("Only products bought within the campaign count");
});

test("the product page's voucher chips name the offer in English", async ({ page }) => {
  await page.goto(`${BASE}/en/shop/${productSlug}`, { waitUntil: "networkidle" });
  const chips = page.locator(".voucher-chips");
  await expect(chips).toBeVisible();
  const spoken = (await chips.locator(".sr-only").allTextContents()).join(" ");
  expect(spoken).not.toMatch(VIETNAMESE);
});
