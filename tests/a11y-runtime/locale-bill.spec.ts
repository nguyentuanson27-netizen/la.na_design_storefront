import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * The English bill adds up (src/i18n/usd-bill.ts). Prices are shown at a .49/.99 ending, so a figure
 * built from them has to be calculated from the prices shown and not rounded on its own: at every
 * quantity the line total is quantity x unit price, the subtotal is the sum of the lines, and the
 * total is the subtotal and the shipping less the voucher. Vietnamese pages stay in dong.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 3364;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = 940_022;
const P = "bill-en-";
// 205.000 dong at 20.000 dong to the dollar is $10.25, shown as $10.49.
const UNIT_CENTS = 1049;
// 30.000 dong of shipping is $1.50, shown as $1.49.
const SHIPPING_CENTS = 149;

let server: ChildProcess;
let output = "";
let variantId = "";
let cartId = "";

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), NEXT_SERVER_COMMAND, "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP),
      LA_VOUCHER_ENABLED: "true",
      LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-BILLTST",
      BETTER_AUTH_URL: BASE,
      APP_DOMAIN: `127.0.0.1:${PORT}`,
      ...nextServerEnv(".next-test/locale-bill"),
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
  test.setTimeout(420_000);
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
      pancakeShopId: SHOP, pancakeProductId: `${P}dress`, slug: `${P}dress`, name: "Đầm hóa đơn", isActive: true, isPresent: true, syncedAt: now,
      variants: { create: { pancakeVariationId: `${P}dress-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: now, pancakeRetailPrice: 205_000, pancakeRetailPriceAfterDiscount: 205_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}wh`, quantity: 50, syncedAt: now } } } },
    },
    include: { variants: true },
  });
  await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: "vayDam" } });
  variantId = created.variants[0]!.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId, quantity: 2 } } } })).id;
  const base = { pancakeShopId: SHOP, kind: "MERCHANDISE" as const, issuance: "AUTO" as const, visibility: "PUBLIC" as const, discountType: "FIXED_AMOUNT_VND" as const, scopeMode: "ALL_SHOP" as const, isEnabled: true, enabledAt: now };
  await prisma.voucherCampaign.create({ data: { ...base, name: "Giảm 50K", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(400_000) } });
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});

const cents = (text: string) => Math.round(Number(text.replace(/[^0-9.]/g, "")) * 100);
const amounts = (text: string) => [...text.matchAll(/\$[\d,]+\.\d{2}/g)].map((match) => cents(match[0]));

async function setQuantity(quantity: number) {
  await prisma.cartItem.updateMany({ where: { cartId, variantId }, data: { quantity } });
}

/** Label -> the dollar figures beside it, from every definition list on the page. */
async function readRows(page: Page): Promise<Map<string, number[]>> {
  const rows = await page.locator("#main-content dl > div").evaluateAll((items) =>
    items.map((item) => [item.querySelector("dt")?.textContent ?? "", item.querySelector("dd")?.textContent ?? ""] as const));
  const map = new Map<string, number[]>();
  for (const [label, value] of rows) map.set(label.replace(/\s+/g, " ").trim(), amounts(value));
  return map;
}
const first = (rows: Map<string, number[]>, label: RegExp) => {
  for (const [name, values] of rows) if (label.test(name) && values.length > 0) return values[0]!;
  throw new Error(`no row matches ${label} in ${[...rows.keys()].join(" | ")}`);
};

for (const quantity of [2, 4]) {
  test(`the English cart adds up at ${quantity} items: line, subtotal, voucher and total from the prices shown`, async ({ page }) => {
    await setQuantity(quantity);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/en/cart`, { waitUntil: "networkidle" });

    const lineTotal = cents(await page.locator("[data-line-total]").first().innerText());
    expect(lineTotal, "line total = quantity x $10.49").toBe(quantity * UNIT_CENTS);

    const rows = await readRows(page);
    expect(first(rows, /^Order value/)).toBe(quantity * UNIT_CENTS);
    expect(first(rows, /^Shipping/)).toBe(SHIPPING_CENTS);
    const total = first(rows, /^Total/);
    expect(total, "the bill's total = lines + shipping").toBe(quantity * UNIT_CENTS + SHIPPING_CENTS);

    // The voucher preview under the bill: what is left to pay is measured from the same subtotal.
    const preview = page.locator("[data-cart-voucher-total]");
    await expect(preview).toBeVisible();
    const previewAmounts = amounts((await preview.innerText()).replace(/\s+/g, " "));
    const voucherOff = previewAmounts[0]!;
    const afterVoucher = previewAmounts[previewAmounts.length - 1]!;
    expect(voucherOff, "a $50K voucher is a price, shown at its own ending").toBe(249);
    expect(afterVoucher, "estimated after offers = total - voucher").toBe(total - voucherOff);

    // The Vietnamese page is still in dong, whole.
    await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
    const vietnamese = (await page.locator("#main-content").innerText()).replace(/\s+/g, " ");
    expect(vietnamese).not.toContain("$");
    expect(vietnamese).toContain(`${(quantity * 205_000).toLocaleString("vi-VN")}`);
  });
}

test("the English checkout adds up at 4 items: line, subtotal, shipping and total", async ({ page }) => {
  await setQuantity(4);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/en/checkout`, { waitUntil: "networkidle" });

  const line = page.locator('[data-line-role="paid"]').first();
  const [unit, lineTotal] = amounts((await line.innerText()).replace(/\s+/g, " "));
  expect(unit).toBe(UNIT_CENTS);
  expect(lineTotal).toBe(4 * UNIT_CENTS);

  const rows = await readRows(page);
  const subtotal = first(rows, /^(Subtotal|Order value)/);
  expect(subtotal).toBe(4 * UNIT_CENTS);
  const total = first(rows, /^Total/);
  expect(total).toBe(4 * UNIT_CENTS + SHIPPING_CENTS);
});
