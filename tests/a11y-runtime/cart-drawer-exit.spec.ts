import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page, type Route } from "@playwright/test";

import { ORDER_TRUST_SHORT } from "../../src/brand/index.ts";
import { prisma } from "../../src/db/prisma.ts";

/**
 * Cart → checkout, in a real browser with a pixel configured:
 *  - the "mua thêm" milestone sits in the drawer's fixed footer, on screen however long the basket,
 *    and CartDrawerExit reports it available and seen (or neither, when nothing is left to reach);
 *  - the trust line under the order button and in the mobile sticky order bar is one line.
 *
 * Always its own `next dev`, like facebook-pixel.spec.ts: the pixel id is inlined at build time and
 * the shared CI build has none.
 */

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown; queue?: unknown[] };
    __fbqCalls?: unknown[][];
  }
}

const HOST = "127.0.0.1";
const PORT = 3492;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_092;
const PREFIX = "cart-exit-";
const LINES = 7;

let server: ChildProcess | undefined;
let serverOutput = "";
let cartId = "";
const variantIds: string[] = [];

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP_ID } } } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.$executeRawUnsafe(`DELETE FROM "PromotionCampaign" WHERE "id" LIKE '${PREFIX}%'`);
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
}

const PIXEL_LIBRARY_STUB = `(function(){
  var original = window.fbq;
  window.__fbqCalls = (original && original.queue) ? [].slice.call(original.queue) : [];
  var shim = function(){ window.__fbqCalls.push([].slice.call(arguments)); };
  shim.callMethod = shim; shim.loaded = true; shim.version = '2.0'; shim.queue = [];
  window.fbq = shim; window._fbq = shim;
})();`;

async function installPixelStub(page: Page) {
  await page.route("https://connect.facebook.net/**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: PIXEL_LIBRARY_STUB }),
  );
  await page.route("https://www.facebook.com/**", (route: Route) => route.fulfill({ status: 200, body: "" }));
}

async function drawerExits(page: Page) {
  return page.evaluate(() =>
    (window.__fbqCalls ?? []).filter((call) => call[0] === "trackCustom" && call[1] === "CartDrawerExit").map((call) => call[2]),
  );
}

async function openDrawer(page: Page) {
  await page.getByRole("button", { name: /^Giỏ hàng/ }).filter({ visible: true }).first().click();
  const drawer = page.getByRole("dialog", { name: "Giỏ hàng" });
  await expect(drawer.getByRole("link", { name: "Tiến hành đặt hàng", exact: true })).toBeVisible();
  return drawer;
}

test.beforeAll(async () => {
  await cleanup();
  const now = new Date();
  for (let index = 0; index < LINES; index += 1) {
    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP_ID, pancakeProductId: `${PREFIX}${index}`, slug: `${PREFIX}${index}`, name: `Váy thử ${index + 1}`, syncedAt: now,
        variants: { create: { pancakeVariationId: `${PREFIX}${index}`, color: "Trắng", size: "M", syncedAt: now, pancakeRetailPrice: 500_000, pancakeRetailPriceAfterDiscount: 500_000,
          warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: now } } } },
      },
      include: { variants: true },
    });
    await prisma.productCategoryMembership.create({ data: { productId: product.id, categoryKey: "vayDam" } });
    variantIds.push(product.variants[0]!.id);
  }
  const gift = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID, pancakeProductId: `${PREFIX}gift`, slug: `${PREFIX}gift`, name: "Khăn quà", syncedAt: now,
      variants: { create: { pancakeVariationId: `${PREFIX}gift`, color: "Trắng", size: "M", syncedAt: now, pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: now } } } },
    },
    include: { variants: true },
  });
  // Seven in the basket, a gift at eight: the drawer shows "Mua thêm 1 sản phẩm…" after seven lines.
  await prisma.giftQuantityCampaign.create({ data: { id: `${PREFIX}gift`, kind: "GIFT_ITEM", name: "Mua 8 tặng khăn", isEnabled: true, enabledAt: now,
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], giftTrigger: "QUANTITY", minimumQuantity: LINES + 1, maxGiftsPerOrder: 1, allowDuplicateGifts: true,
    giftOptions: { create: { variantId: gift.variants[0]!.id } } } });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test/cart-drawer-exit",
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: "123456789012345",
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP_ID),
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`cart exit test server exited\n${serverOutput}`);
    try { if ((await fetch(`${BASE_URL}/cart`)).ok) return; } catch { /* compiling */ }
    await delay(500);
  }
  throw new Error(`Timed out waiting for cart exit test server\n${serverOutput}`);
});

test.beforeEach(async ({ context, page }) => {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP_ID } } } } } });
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: variantIds.map((variantId) => ({ variantId, quantity: 1 })) } } })).id;
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  await installPixelStub(page);
  await page.setViewportSize({ width: 390, height: 700 });
});

test.afterAll(async () => {
  await stopServer();
  await cleanup();
  await prisma.$disconnect();
});

test("the next milestone stays in view in the fixed footer, however long the basket", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop`);
  const drawer = await openDrawer(page);
  // Seven lines overflow the drawer body; the milestone is in the footer, so it is on screen anyway.
  const nudge = drawer.locator('[data-promotion-state="progress"]');
  await expect(nudge).toHaveCount(1);
  await expect(nudge).toBeInViewport({ ratio: 0.5 });
  await expect(nudge).toContainText("Mua thêm 1 sản phẩm");
  await expect(drawer.getByText("Không bắt buộc")).toHaveCount(0);

  await drawer.getByRole("link", { name: "Tiến hành đặt hàng", exact: true }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  // A client navigation: the recorded pixel calls survive it.
  expect(await drawerExits(page)).toEqual([
    { exit_to: "checkout", gift_nudge_available: true, gift_nudge_seen: true, can_checkout: true },
  ]);
});

test("a basket with no milestone left reports no nudge, on every way out", async ({ page }) => {
  // Seven reach the gift and the campaign gives one: nothing is left to nudge toward.
  await prisma.giftQuantityCampaign.update({ where: { id: `${PREFIX}gift` }, data: { minimumQuantity: LINES } });
  try {
    await page.goto(`${BASE_URL}/shop`);
    let drawer = await openDrawer(page);
    await expect(drawer.locator('[data-promotion-state="progress"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    drawer = await openDrawer(page);
    await drawer.getByRole("button", { name: "Đóng giỏ hàng" }).click();
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => drawerExits(page)).toEqual([
      { exit_to: "close", gift_nudge_available: false, gift_nudge_seen: false, can_checkout: true },
      { exit_to: "close", gift_nudge_available: false, gift_nudge_seen: false, can_checkout: true },
    ]);
  } finally {
    await prisma.giftQuantityCampaign.update({ where: { id: `${PREFIX}gift` }, data: { minimumQuantity: LINES + 1 } });
  }
});

test("the drawer's trust line under the order button is a single line", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop`);
  const drawer = await openDrawer(page);
  const trust = drawer.locator("[data-order-trust]");
  await expect(trust).toBeVisible();
  await expect(trust).toContainText("COD");
  await expect(trust).toContainText("Được kiểm hàng");
  await expect(trust).toContainText("Đổi trả 15 ngày");
  const box = await trust.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(24);
});

test("the mobile sticky order bar carries the short trust line while the order button is off screen", async ({ page }) => {
  await page.goto(`${BASE_URL}/cart`);
  await expect(page.locator("#cart-checkout-cta")).not.toBeInViewport();
  const bar = page.locator("[data-mobile-sticky-cta]");
  await expect(bar).toBeVisible();
  await expect(bar.locator("[data-mobile-sticky-footnote]")).toHaveText(ORDER_TRUST_SHORT);
  // One line: the bar does not grow into a second block.
  const box = await bar.locator("[data-mobile-sticky-footnote]").boundingBox();
  expect(box?.height ?? 0).toBeLessThan(24);
});

test("a Flash Sale that ends while the drawer is open re-reads the cart, without closing it", async ({ page }) => {
  const now = new Date();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionCampaign" ("id","kind","name","discountType","fixedPriceVnd","startsAt","endsAt","isEnabled","enabledAt","createdAt","updatedAt")
     VALUES ($1,'FLASH_SALE'::"PromotionCampaignKind",'Flash ngắn','FIXED_PRICE'::"PromotionDiscountType",300000,$2,$3,true,$4,$4,$4)`,
    `${PREFIX}flash`, new Date(now.getTime() - 60_000), new Date(now.getTime() + 12_000), now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PromotionTarget" ("id","campaignId","variantId","createdAt") VALUES ($1,$2,$3,$4)`,
    `${PREFIX}flash-target`, `${PREFIX}flash`, variantIds[0]!, now,
  );
  try {
    await page.goto(`${BASE_URL}/shop`);
    const drawer = await openDrawer(page);
    const line = drawer.locator("li").filter({ hasText: "Váy thử 1" });
    await expect(line.locator("[data-cart-flash]")).toContainText("FLASH SALE");
    await expect(line).toContainText("300.000");

    // The drawer stays open across the deadline: the ended clock re-reads the view by itself.
    await expect(line.locator("[data-cart-flash]")).toHaveCount(0, { timeout: 30_000 });
    await expect(line).toContainText("500.000");
    await expect(line).not.toContainText("300.000");
    await expect(drawer).toBeVisible();
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM "PromotionCampaign" WHERE "id" = $1`, `${PREFIX}flash`);
  }
});
