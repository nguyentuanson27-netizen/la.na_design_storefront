import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * Voucher money on the English storefront. Vouchers spell dong their own way (`260.000đ`, `80K`,
 * `1,5 triệu`), and some of it reaches the page as a slot of a rich sentence, after the dollar
 * conversion would have run on a plain string. Every figure a shopper reads on `/en` must be a
 * dollar figure: the picker, the "buy more" nudge, the cart savings and the product page's chips.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 3362;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = 940_021;
const P = "vchr-en-";

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
      ...nextServerEnv(".next-test/locale-voucher"),
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



const DONG = /\d\s?(?:₫|đ)(?![\p{L}])|\b\d+(?:,\d+)?\s?(?:K|TR)\b|triệu/u;
const trigger = (page: Page) => page.locator("[data-voucher-picker] > button");

async function expectNoDong(page: Page, selector: string, label: string) {
  const text = (await page.locator(selector).first().innerText()).replace(/\s+/g, " ");
  expect(text, `${label}: ${text}`).not.toMatch(DONG);
  return text;
}

test("the voucher picker, its nudge and the cart show dollars on /en and dong on /", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // Vietnamese keeps its own figures.
  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await expect(page.locator(".voucher-nudge")).toContainText("1.100.000đ");

  await page.goto(`${BASE}/en/cart`, { waitUntil: "networkidle" });

  // The nudge builds its sentence from a slot: 200K needs 2,000,000 dong, the cart holds 900,000.
  const nudge = await expectNoDong(page, ".voucher-nudge", "nudge");
  expect(nudge).toContain("$42.31");

  await trigger(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const picker = await expectNoDong(page, "dialog[open]", "picker");
  expect(picker).toContain("$1.92"); // the 50K ticket
  expect(picker).toContain("$7.69"); // the 200K ticket
  expect(picker).toContain("$42.31"); // its shortfall
  // The picker's own bar and the tickets' accessible names.
  await expect(dialog.getByRole("button", { name: /\$1\.92/ }).first()).toBeVisible();
  const names = await dialog.locator("button[aria-pressed]").evaluateAll((tickets) => tickets.map((t) => t.getAttribute("aria-label") ?? ""));
  for (const name of names) expect(name).not.toMatch(DONG);
});

test("the product page's voucher chips show dollars on /en", async ({ page }) => {
  await page.goto(`${BASE}/en/shop/${productSlug}`, { waitUntil: "networkidle" });
  const chips = page.locator(".voucher-chips");
  await expect(chips).toBeVisible();
  const text = (await chips.innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(DONG);
  expect(text).toContain("$");
  // The sentence a screen reader gets is converted as well.
  const spoken = (await chips.locator(".sr-only").allTextContents()).join(" ");
  expect(spoken).not.toMatch(DONG);
});

test("the checkout's voucher panel and the cart's bill show dollars on /en, and the order is still charged in dong", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(`${BASE}/en/cart`, { waitUntil: "networkidle" });
  const cart = (await page.locator("#main-content").innerText()).replace(/\s+/g, " ");
  expect(cart).not.toMatch(DONG);
  expect(cart).toContain("$");

  await page.goto(`${BASE}/en/checkout`, { waitUntil: "networkidle" });
  const vouchers = page.locator("[data-checkout-vouchers]");
  await expect(vouchers).toBeVisible();
  const voucherText = (await vouchers.innerText()).replace(/\s+/g, " ");
  expect(voucherText, voucherText).not.toMatch(DONG);
  expect(voucherText).toContain("$");
  const checkout = (await page.locator("#main-content").innerText()).replace(/\s+/g, " ");
  expect(checkout).not.toMatch(DONG);
  // 900.000 dong of goods, 30.000 of shipping, 50.000 off: the note under the total says what is charged.
  await expect(page.locator("[data-dong-note]").first()).toContainText(/priced and paid in VND: [\d.]+ VND/);
});
