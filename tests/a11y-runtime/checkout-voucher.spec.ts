import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * Voucher v1 V18 in a real browser: the checkout page names the vouchers, never prices them itself and never lets an
 * offered-but-not-held voucher be ordered by accident; the hold is one deliberate click; the bill adds up; what the
 * shopper typed survives the refresh that follows; the cart shows its total before and after vouchers honestly.
 *
 * The order itself (acceptance, consume, refund, POS body) is held to a real database in
 * `tests/database/voucher-checkout.test.ts`; this spec holds the browser to what the shopper sees and can do.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const HOST = "127.0.0.1";
const PORT = 3362 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0);
const BASE = `http://${HOST}:${PORT}`;
// The address lists come from the same Pancake fixture the checkout specs use (it answers for this shop and key).
const SHOP = 920_007;
const TEST_API_KEY = "checkout-a11y-test-key";
const TRUSTED_CLIENT_IP = "203.0.113.45";
const PANCAKE_FETCH_FIXTURE = resolve(import.meta.dirname, "pancake-fetch-fixture.cjs");
const PREFIX = "vchr-co-";
const runtimeId = `${Date.now()}-${process.pid}`;

let server: ChildProcess | undefined;
let output = "";
let cartId = "";
let variantId = "";

async function cleanup() {
  await prisma.rateLimit.deleteMany({});
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
    await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function startServer() {
  output = "";
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP),
      PANCAKE_API_KEY: TEST_API_KEY,
      PANCAKE_A11Y_BENEFIT_ORDER: "true",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${PANCAKE_FETCH_FIXTURE}`].filter(Boolean).join(" "),
      LA_VOUCHER_ENABLED: "true",
      LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-VCHRTST",
      BETTER_AUTH_URL: BASE,
      APP_DOMAIN: `${HOST}:${PORT}`,
      BETTER_AUTH_IP_HEADER: "x-ci-client-ip",
      ...nextServerEnv(`.next-test/voucher-checkout-${runtimeId}`),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  server.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  for (let attempt = 0; attempt < 700; attempt += 1) {
    try { if ((await fetch(`${BASE}/cart`)).ok && (await fetch(`${BASE}/api/auth/get-session`)).ok) return; } catch { /* compiling */ }
    if (server.exitCode !== null) throw new Error(output);
    await delay(500);
  }
  throw new Error(output);
}

test.beforeAll(async () => {
  test.setTimeout(420_000);
  await startServer();
});
test.afterAll(async () => {
  const running = server;
  if (running && running.exitCode === null) {
    running.kill("SIGTERM");
    await Promise.race([new Promise((done) => running.once("exit", done)), delay(8_000)]);
    if (running.exitCode === null) running.kill("SIGKILL");
  }
  await cleanup();
  await prisma.$disconnect();
});

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": TRUSTED_CLIENT_IP });
  await cleanup();
  const now = new Date();
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${PREFIX}dress`, slug: `${PREFIX}dress`, name: "Đầm voucher", isActive: true, isPresent: true, syncedAt: now,
      variants: { create: { pancakeVariationId: `${PREFIX}dress-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: now, pancakeRetailPrice: 450_000, pancakeRetailPriceAfterDiscount: 450_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 20, syncedAt: now } } } },
    },
    include: { variants: true },
  });
  variantId = created.variants[0]!.id;
  await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: "vayDam" } });
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId, quantity: 2 } } } })).id;
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: now, name: "Giảm 50K", fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});


// Optional review screenshots (H4): written only when H4_SHOTS_DIR is set; CI never sets it, so this changes nothing there.
const SHOTS_DIR = process.env.H4_SHOTS_DIR;
async function shot(page: Page, name: string, fullPage = false) {
  if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/${name}.png`, fullPage });
}

const dropHolds = () =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: SHOP } } });
  });
const holds = () => prisma.voucherHold.findMany({ where: { campaign: { pancakeShopId: SHOP }, state: "HELD" } });
const submit = (page: Page) => page.getByRole("button", { name: "Đặt hàng COD", exact: true });
const panel = (page: Page) => page.locator("[data-checkout-vouchers]");

async function fillReceiving(page: Page) {
  await page.getByLabel("Họ và tên", { exact: false }).fill("Nguyễn Văn A");
  await page.getByLabel("Số điện thoại", { exact: false }).fill("0901234567");
  await page.getByLabel("Tỉnh / Thành phố", { exact: false }).selectOption({ label: "Tỉnh Current" });
  await page.getByLabel("Phường / Xã", { exact: false }).selectOption({ label: "Phường Current" });
  await page.getByLabel("Số nhà, tên đường", { exact: false }).fill("12 Đường A");
  await page.getByLabel("Ghi chú", { exact: false }).fill("Giữ nguyên ghi chú");
}

test("an offered voucher is not applied and blocks the order until the shopper confirms; confirming holds it once and the bill adds up", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await dropHolds();
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}/checkout`);
    await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "offered");
    await expect(panel(page)).toContainText("Giảm 50.000đ");
    await expect(page.locator("[data-checkout-voucher-total]")).toContainText("880.000");
    await shot(page, `checkout-offered-${viewport.width}`, true);
    // Nothing is held, nothing is priced: the order cannot be placed with an unconfirmed offer.
    expect(await holds()).toHaveLength(0);
    await expect(submit(page)).toBeDisabled();
    // The untouched address selects are the form's own (pre-existing) placeholder state; the panel is held to axe here and the whole page once filled.
    expect((await new AxeBuilder({ page }).include("[data-checkout-vouchers]").withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);

    await fillReceiving(page);
    await panel(page).getByRole("button", { name: "Áp dụng và giữ ưu đãi" }).click();
    await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "held");
    expect(await holds()).toHaveLength(1);
    await expect(panel(page).locator("[data-checkout-voucher-line]")).toContainText("−");
    await expect(page.locator("[data-checkout-voucher-held-until]")).toContainText(/phút/);
    // The bill: 2 x 425.000 after the voucher, plus the 30.000 fee.
    const bill = page.locator('dl[data-order-summary="page"]:visible').first();
    await expect(bill).toContainText("Giảm 50K");
    await expect(bill).toContainText("−50.000");
    await expect(bill.locator("dd").last()).toContainText("880.000");
    await expect(submit(page)).toBeEnabled();
    await shot(page, `checkout-held-${viewport.width}`, true);
    // The refresh that applied the voucher kept what the shopper had typed.
    await expect(page.getByLabel("Họ và tên", { exact: false })).toHaveValue("Nguyễn Văn A");
    await expect(page.getByLabel("Số nhà, tên đường", { exact: false })).toHaveValue("12 Đường A");
    await expect(page.getByLabel("Ghi chú", { exact: false })).toHaveValue("Giữ nguyên ghi chú");
    expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  }
});

test("a hold that no longer describes the cart is not applied: the checkout says so and offers the voucher again", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  await panel(page).getByRole("button", { name: "Áp dụng và giữ ưu đãi" }).click();
  await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "held");
  // The cart changes under the hold (a third unit): what the hold promised is no longer the quote.
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 3 } });
  await page.goto(`${BASE}/checkout`);
  await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "offered");
  await expect(panel(page)).toContainText("Nàng xác nhận lại ưu đãi");
  await expect(submit(page)).toBeDisabled();
});

test("the cart says its total is before vouchers and shows the expected total after them, never as a promise", async ({ page }) => {
  await page.goto(`${BASE}/cart`);
  await expect(page.getByText("Tổng (chưa tính ưu đãi)").first()).toBeVisible();
  await expect(page.getByText("Dự kiến sau ưu đãi").first()).toBeVisible();
  expect(await holds()).toHaveLength(0);
  // The product link's name is the cart's own (pre-existing); the totals this change adds are held to axe.
  expect((await new AxeBuilder({ page }).include("[data-cart-voucher-total]").withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});

test("review f3eed3a: a code applied in the picker updates the cart's expected total as soon as the dialog closes", async ({ page }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}/cart`);
    const expected = page.locator("[data-cart-voucher-total]").first();
    // AUTO: the 50.000đ voucher (900.000 - 50.000 + the 30.000đ fee).
    await expect(expected).toContainText("880.000");
    await page.locator("[data-voucher-picker] > button").click();
    const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
    await dialog.getByLabel("Nhập mã khuyến mãi").fill("kol70");
    await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
    await expect(dialog.getByRole("radio", { name: /Giảm 70.000đ/ })).toBeChecked();
    // The dialog is open on purpose and the page behind it is not touched yet; closing it settles the totals.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(expected).toContainText("860.000");
    // The mobile bar says the same.
    if (viewport.width < 600) await expect(page.getByText("Dự kiến sau ưu đãi").last()).toBeVisible();
  }
});

test("review 1bb0d61 / AC-35: the picker's 'Tiếp tục với voucher này' removes the gift the shopper gave up, in the same step", async ({ page }) => {
  const gift = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}gift2`, slug: `${PREFIX}gift2`, name: "Khăn quà", isActive: true, isPresent: true, syncedAt: new Date(),
      variants: { create: { pancakeVariationId: `${PREFIX}gift2-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: new Date(), pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: new Date() } } } } },
    include: { variants: true },
  });
  const campaignId = `${PREFIX}gift2`;
  // 900.000đ earns the gift (threshold 880.000đ); 850.000đ after the voucher does not.
  await prisma.giftQuantityCampaign.create({
    data: {
      id: campaignId, kind: "GIFT_ITEM", name: "Quà 880K", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 880_000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE",
      maxGiftsPerOrder: 1, allowDuplicateGifts: false, giftOptions: { create: { variantId: gift.variants[0]!.id } },
    },
  });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: gift.variants[0]!.id, quantity: 1, campaignRevision: 1 } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  // First press only asks again; nothing is saved or removed by it.
  await dialog.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }).click();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  await dialog.getByRole("button", { name: /Tiếp tục với voucher này/ }).click();
  await expect(dialog).toBeHidden();
  // The confirmed choice was carried out together with the voucher.
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(1);
});

test("review 5a62d20 / AC-35: a typed code that costs the shopper a gift is shown, not saved, until they confirm; confirming saves the code and removes the gift together", async ({ page }) => {
  const gift = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}gift3`, slug: `${PREFIX}gift3`, name: "Khăn quà", isActive: true, isPresent: true, syncedAt: new Date(),
      variants: { create: { pancakeVariationId: `${PREFIX}gift3-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: new Date(), pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: new Date() } } } } },
    include: { variants: true },
  });
  const campaignId = `${PREFIX}gift3`;
  await prisma.giftQuantityCampaign.create({
    data: {
      id: campaignId, kind: "GIFT_ITEM", name: "Quà 880K", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 880_000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE",
      maxGiftsPerOrder: 1, allowDuplicateGifts: false, giftOptions: { create: { variantId: gift.variants[0]!.id } },
    },
  });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: gift.variants[0]!.id, quantity: 1, campaignRevision: 1 } });
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  // Start from NO voucher so the only thing that can cost the gift is the code the shopper types.
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await prisma.cartVoucherSelection.create({ data: { cartId, expiresAt: new Date(Date.now() + 86_400_000), merchandiseMode: "MANUAL", merchandiseVoucherId: null, shippingMode: "AUTO" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("kol70");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  // Valid, but it costs the chosen gift: shown with the warning, NOT saved.
  await expect(dialog).toContainText("Mã hợp lệ");
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  await shot(page, "picker-code-costs-a-gift-390");
  expect((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).toBeNull();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  // The shopper's yes saves the code and removes the gift in one step.
  await dialog.getByRole("button", { name: /Tiếp tục với voucher này/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).not.toBeNull();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});

test("review 8bdb2f0: editing the code box abandons a code waiting for the shopper's yes; the confirm button never carries the old code", async ({ page }) => {
  const gift = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}gift4`, slug: `${PREFIX}gift4`, name: "Khăn quà", isActive: true, isPresent: true, syncedAt: new Date(),
      variants: { create: { pancakeVariationId: `${PREFIX}gift4-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: new Date(), pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: new Date() } } } } },
    include: { variants: true },
  });
  const campaignId = `${PREFIX}gift4`;
  await prisma.giftQuantityCampaign.create({
    data: {
      id: campaignId, kind: "GIFT_ITEM", name: "Quà 880K", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 880_000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE",
      maxGiftsPerOrder: 1, allowDuplicateGifts: false, giftOptions: { create: { variantId: gift.variants[0]!.id } },
    },
  });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: gift.variants[0]!.id, quantity: 1, campaignRevision: 1 } });
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL71", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 71K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await prisma.cartVoucherSelection.create({ data: { cartId, expiresAt: new Date(Date.now() + 86_400_000), merchandiseMode: "MANUAL", merchandiseVoucherId: null, shippingMode: "AUTO" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  const box = dialog.getByLabel("Nhập mã khuyến mãi");
  await box.fill("kol71");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog).toContainText("Mã hợp lệ");
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toBeVisible();
  // The shopper changes their mind and types another code: the waiting confirmation belongs to the first one and is gone.
  await box.fill("sai-ma-khac");
  await expect(dialog).not.toContainText("Mã hợp lệ");
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Mã không hợp lệ");
  expect((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).toBeNull();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
});

test("review 8bdb2f0: a choice that WAS saved but cannot be re-read right now is never shown as a failure", async ({ page }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL72", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 72K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  // Deterministic injection: the moment the selection is written the cart is emptied in the same transaction, so the quote the
  // server derives AFTER the save (to answer the picker) is unavailable while the save itself stands.
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION vchr_co_empty_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "CartItem" WHERE "cartId" = NEW."cartId"; RETURN NULL; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER vchr_co_empty_cart_t AFTER INSERT OR UPDATE ON "CartVoucherSelection" FOR EACH ROW EXECUTE FUNCTION vchr_co_empty_cart()`);
  try {
    await dialog.getByLabel("Nhập mã khuyến mãi").fill("kol72");
    await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
    await expect(dialog).toContainText("Đã áp dụng mã ưu đãi");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    const row = await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } });
    expect(row.merchandiseMode).toBe("MANUAL");
    expect(row.merchandiseVoucherId).not.toBeNull();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS vchr_co_empty_cart_t ON "CartVoucherSelection"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS vchr_co_empty_cart()`);
  }
});

test("review beca608: a picker left open on an old choice is refused when another page has changed it; it is shown what is saved and chooses again", async ({ page }) => {
  // 60K is the best saving, so "automatic" already means 60K; the other page deliberately locks the LOWER one (50K).
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "Giảm 60K", fixedAmountVnd: BigInt(60_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  const fifty = await prisma.voucherCampaign.findFirstOrThrow({ where: { pancakeShopId: SHOP, name: "Giảm 50K" } });
  await page.setViewportSize({ width: 390, height: 844 });
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await other.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  await other.locator("[data-voucher-picker] > button").click();
  const dialogA = page.getByRole("dialog", { name: "Ưu đãi" });
  const dialogB = other.getByRole("dialog", { name: "Ưu đãi" });
  await expect(dialogA).toBeVisible();
  await expect(dialogB).toBeVisible();

  // The other page locks 50K and applies: saved.
  await dialogB.getByRole("radio", { name: /Giảm 50\.000đ/ }).click();
  await expect(dialogB.getByRole("radio", { name: /Giảm 50\.000đ/ })).toBeChecked();
  await dialogB.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }).click();
  await expect(dialogB).toBeHidden();
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).toBe(fifty.id);

  // This page still thinks nothing was chosen; it picks "no voucher" and applies. It must NOT overwrite what the other page saved.
  await dialogA.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ }).click();
  await expect(dialogA.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ })).toBeChecked();
  await dialogA.getByRole("button", { name: "Bỏ qua ưu đãi và tiếp tục" }).click();
  await expect(dialogA.getByRole("alert")).toContainText("vừa được thay đổi ở một trang khác");
  expect((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).toBe(fifty.id);
  // It now shows what is saved, and applying from there works.
  await expect(dialogA.getByRole("radio", { name: /Giảm 50\.000đ/ })).toBeChecked();
  await dialogA.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }).click();
  await expect(dialogA).toBeHidden();
});

test("review beca608: dropping a voucher while the price cannot be derived is saved, and the shopper is told the price is not known", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ }).click();
  await expect(dialog.getByRole("radio", { name: /Không dùng voucher giảm tiền hàng/ })).toBeChecked();
  // Pricing goes away before the shopper presses "Áp dụng": the server cannot derive a quote for the commit.
  await prisma.cartItem.deleteMany({ where: { cartId } });
  await dialog.getByRole("button", { name: "Bỏ qua ưu đãi và tiếp tục" }).click();
  await expect(dialog).toContainText("Hiện chưa tính được giá");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const row = await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } });
  expect([row.merchandiseMode, row.merchandiseVoucherId]).toEqual(["MANUAL", null]);
});

/** A cart holding a chosen gift (earned at 880K), and a private code that would cost it: the shopper has to say yes before it is saved. */
async function seedCodeThatCostsAGift(code: string) {
  const gift = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}gift5`, slug: `${PREFIX}gift5`, name: "Khăn quà", isActive: true, isPresent: true, syncedAt: new Date(),
      variants: { create: { pancakeVariationId: `${PREFIX}gift5-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: new Date(), pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: new Date() } } } } },
    include: { variants: true },
  });
  const campaignId = `${PREFIX}gift5`;
  await prisma.giftQuantityCampaign.create({
    data: {
      id: campaignId, kind: "GIFT_ITEM", name: "Quà 880K", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 880_000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE",
      maxGiftsPerOrder: 1, allowDuplicateGifts: false, giftOptions: { create: { variantId: gift.variants[0]!.id } },
    },
  });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: gift.variants[0]!.id, quantity: 1, campaignRevision: 1 } });
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code, discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: code, fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
}

test("review 54cb476: a marketing link to a code that would cost a chosen gift saves nothing; the picker offers it and only the shopper's consent applies it", async ({ page }) => {
  await seedCodeThatCostsAGift("KOL73");
  await page.setViewportSize({ width: 390, height: 844 });
  // The shopper has a cart with the gift chosen and follows the link. The GET must not touch the choice or the gift.
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL73`);
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  await page.goto(`${BASE}/cart`);
  // This server has tracking on (GTM): the code must not be anywhere in what the cart page sends the browser.
  expect(await (await page.request.get(`${BASE}/cart`)).text()).not.toMatch(/KOL73/i);
  expect(await page.content()).not.toMatch(/KOL73/i);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await expect(dialog.getByLabel("Nhập mã khuyến mãi")).toHaveValue("");
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  // The code is valid but costs the gift: shown with the warning, still NOT saved.
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  expect(await page.content()).not.toMatch(/KOL73/i);
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  // Declining (closing the picker) keeps everything as it was, and the code is still on offer.
  await dialog.getByRole("button", { name: "Quay lại, giữ lựa chọn cũ" }).click();
  await expect(dialog).toBeHidden();
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "la_voucher_code")).toBe(true);
  // Now the shopper agrees: the code, the removal of the gift and the end of the offer all follow from that one yes.
  await page.locator("[data-voucher-picker] > button").click();
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  await dialog.getByRole("button", { name: /Tiếp tục với voucher này/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).not.toBeNull();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await expect.poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "la_voucher_code")).toBe(false);
});

test("review b948f0e: the consent step notices a replaced offer too -- A confirms KOL73's cost, B opens another link, A's yes saves nothing and the old confirmation is dropped", async ({ page, context }) => {
  await seedCodeThatCostsAGift("KOL73");
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL74", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 74K", fixedAmountVnd: BigInt(60_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL73`);
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  // A's first click: the code is valid but costs the gift, so A is asked to confirm it. Nothing is saved.
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  // B (same browser) opens a newer link: the shared cookie now holds KOL74.
  const other = await context.newPage();
  await other.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL74`);
  expect((await context.cookies()).find((cookie) => cookie.name === "la_voucher_code")?.value).toBe("KOL74");
  await other.close();
  // A says yes to what A was shown. The server refuses (the offer is not that one any more): nothing saved, gift kept.
  await dialog.getByRole("button", { name: /Tiếp tục với voucher này/ }).click();
  await expect(dialog).toContainText("vừa được thay bằng một mã khác");
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  // The old offer's confirmation is gone: the dialog shows what is SAVED again (the cart's own automatic 50K choice, not the 70K code that
  // was being confirmed), there is no confirm button for the old offer, and the current offer is shown instead.
  await expect(dialog.getByRole("radio", { name: /Giảm 50.000đ/ })).toBeChecked();
  await expect(dialog).not.toContainText("Giảm 70.000đ");
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Dùng mã từ liên kết" })).toBeVisible();
  // The page re-renders in the background with the new offer's handle; wait for it before the deliberate second click.
  await page.waitForLoadState("networkidle");
  // A may now choose to apply the new offer (KOL74 also costs the gift, so it asks again), and only then is anything saved.
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await expect(dialog).toContainText("Mã hợp lệ. Nàng xem ưu đãi");
  await expect(dialog.getByRole("radio", { name: /Giảm 60.000đ/ })).toBeChecked();
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  await dialog.getByRole("button", { name: /Tiếp tục với voucher này/ }).click();
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).not.toBeNull();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});

/** The cart of seedCodeThatCostsAGift plus KOL10: a small private code (10K) that leaves the subtotal above the gift's 880K, so it costs nothing. */
async function seedSmallCodes(...codes: string[]) {
  for (const [index, code] of codes.entries()) {
    await prisma.voucherCampaign.create({
      data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code, discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: code, fixedAmountVnd: BigInt(10_000 + index * 1_000), minEligibleSubtotalVnd: BigInt(600_000) },
    });
  }
}

test("review 735ff62: a linked code that applies cleanly replaces a typed code waiting for its yes -- the footer no longer carries the typed code", async ({ page }) => {
  await seedCodeThatCostsAGift("KOL73");
  await seedSmallCodes("KOL10");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL10`);
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  // The shopper types KOL73, which costs the gift: it is shown and waits for their yes.
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("KOL73");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toBeVisible();
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  // Then they use the linked offer instead (KOL10 costs nothing, so it is saved at once).
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await expect(dialog).toContainText("Đã áp dụng mã ưu đãi");
  const kol10 = await prisma.voucherCampaign.findFirstOrThrow({ where: { code: "KOL10" }, select: { id: true } });
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).toBe(kol10.id);
  // What is shown is KOL10's result; KOL73's confirmation is gone with its footer button.
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /Giảm 10.000đ/ })).toBeChecked();
  // The footer commits what is displayed: KOL73 is never sent, the gift stays.
  await dialog.getByRole("button", { name: /Áp dụng • 1 ưu đãi/ }).click();
  await expect(dialog).toBeHidden();
  expect((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).toBe(kol10.id);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
});

test("review 735ff62: a replaced offer also drops a typed code that was waiting for its yes", async ({ page, context }) => {
  await seedCodeThatCostsAGift("KOL73");
  await seedSmallCodes("KOL10", "KOL11");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL10`);
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("KOL73");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toBeVisible();
  // Another tab opens a newer link; this tab's offer is no longer the one the server holds.
  const other = await context.newPage();
  await other.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL11`);
  await other.close();
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await expect(dialog).toContainText("vừa được thay bằng một mã khác");
  // Nothing saved, and the typed code's confirmation went with it: no footer button that would send KOL73.
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  // Whatever the footer does now, it acts on what is DISPLAYED (the saved choice), never on the typed KOL73 that was waiting.
  const kol73 = await prisma.voucherCampaign.findFirstOrThrow({ where: { code: "KOL73" }, select: { id: true } });
  await dialog.getByRole("button", { name: /Áp dụng/ }).last().click();
  const confirm = dialog.getByRole("button", { name: /Tiếp tục với voucher này/ });
  if (await confirm.isVisible()) await confirm.click();
  await expect(dialog).toBeHidden();
  expect((await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).not.toBe(kol73.id);
});

/**
 * Holds the NEXT Server Action POST until released, so a test can close the dialog while it is still running. `how` says what then happens
 * to it: it goes on normally, it never reaches the server ("abort"), or the server handles it and the response is lost ("lose-response").
 */
async function holdNextServerAction(page: Page, how: "continue" | "abort" | "lose-response" = "continue") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const reached = new Promise<void>((resolve) => { held = resolve; });
  let used = false;
  await page.route("**/cart", async (route) => {
    const request = route.request();
    if (used || request.method() !== "POST" || request.headers()["next-action"] === undefined) return route.fallback();
    used = true;
    held();
    await gate;
    if (how === "abort") return route.abort("failed");
    if (how === "lose-response") {
      await route.fetch();
      return route.abort("failed");
    }
    await route.fallback();
  });
  return { release, reached };
}

test("review 5a22b12: closing the dialog while a TYPED code is being applied still refreshes the cart behind it when the action resolves", async ({ page }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  const expected = page.locator("[data-cart-voucher-total]").first();
  await expect(expected).toContainText("880.000");
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("KOL70");
  const action = await holdNextServerAction(page);
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await action.reached;
  // While the write is running the dialog says so: leaving does NOT cancel it.
  await expect(dialog.getByText("yêu cầu vẫn tiếp tục")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đóng — yêu cầu áp dụng vẫn tiếp tục" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Quay lại, giữ lựa chọn cũ" })).toHaveCount(0);
  // The shopper leaves while the server is still working.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  action.release();
  // Nothing else is opened or closed: the saved choice and the totals outside the dialog catch up on their own.
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).not.toBeNull();
  await expect(expected).toContainText("860.000");
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toHaveCount(0);
  // Once it has landed, the plain wording is back.
  await page.locator("[data-voucher-picker] > button").click();
  await expect(dialog.getByRole("button", { name: "Quay lại, giữ lựa chọn cũ" })).toBeVisible();
  await expect(dialog.getByText("yêu cầu vẫn tiếp tục")).toHaveCount(0);
});

test("review 5a22b12: closing the dialog while the LINKED code is being applied still refreshes the cart and clears the used offer", async ({ page, context }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL70`);
  await page.goto(`${BASE}/cart`);
  const expected = page.locator("[data-cart-voucher-total]").first();
  await expect(expected).toContainText("880.000");
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  const action = await holdNextServerAction(page);
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await action.reached;
  // The back button no longer promises to "keep the old choice" while the request is still going to land.
  await expect(dialog.getByRole("button", { name: "Quay lại, giữ lựa chọn cũ" })).toHaveCount(0);
  await expect(dialog.getByText("yêu cầu vẫn tiếp tục")).toBeVisible();
  await dialog.getByRole("button", { name: "Đóng — yêu cầu áp dụng vẫn tiếp tục" }).click();
  await expect(dialog).toBeHidden();
  action.release();
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).not.toBeNull();
  // The offer that was used is cleared, and the totals outside the dialog are the server's.
  await expect.poll(async () => (await context.cookies()).some((cookie) => cookie.name === "la_voucher_code")).toBe(false);
  await expect(expected).toContainText("860.000");
});

test("review a772560: a typed code refused after the dialog was closed is not promised while pending, and the refusal is shown outside the dialog", async ({ page }) => {
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("WRONG123");
  const action = await holdNextServerAction(page);
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await action.reached;
  // While it runs the dialog promises the request continues, never that the voucher will apply.
  await expect(dialog.getByText("yêu cầu vẫn tiếp tục")).toBeVisible();
  await expect(dialog.getByText("ưu đãi chỉ có hiệu lực khi được xác nhận")).toBeVisible();
  await expect(dialog).not.toContainText("vẫn được áp dụng");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  action.release();
  // The server refuses: nothing is saved, and the cart says so without the shopper having to reopen anything.
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toBeVisible();
  expect(await prisma.cartVoucherSelection.count({ where: { cartId, merchandiseMode: "MANUAL" } })).toBe(0);
  // Reopening shows the reason and clears the notice.
  await page.locator("[data-voucher-picker] > button").click();
  await expect(dialog).toContainText("Mã không hợp lệ");
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toHaveCount(0);
});

test("review a772560: a code that still needs the shopper's consent is not applied when they leave; the cart says it is not done", async ({ page }) => {
  await seedCodeThatCostsAGift("KOL73");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("KOL73");
  const action = await holdNextServerAction(page);
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await action.reached;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  action.release();
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toBeVisible();
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  // Reopening shows the code waiting for the shopper's yes, with what it costs.
  await page.locator("[data-voucher-picker] > button").click();
  await expect(dialog.getByRole("button", { name: /Tiếp tục với voucher này/ })).toBeVisible();
  await expect(dialog).toContainText("quà đã chọn sẽ được bỏ khỏi giỏ hàng");
});

test("review 8bfe958: a typed code whose request never reaches the server, with the dialog closed, is reported as unknown and nothing is saved or replayed", async ({ page }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  const expected = page.locator("[data-cart-voucher-total]").first();
  await expect(expected).toContainText("880.000");
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await dialog.getByLabel("Nhập mã khuyến mãi").fill("KOL70");
  const action = await holdNextServerAction(page, "abort");
  await dialog.getByRole("button", { name: "Áp dụng mã" }).click();
  await action.reached;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  action.release();
  // Neither "applied" nor "not done": the outcome is unknown, and the page is still a working cart (no error screen).
  await expect(page.locator("[data-voucher-picker] > p", { hasText: "Chưa xác định được kết quả" })).toBeVisible();
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toHaveCount(0);
  await expect(expected).toContainText("880.000");
  expect(await prisma.cartVoucherSelection.count({ where: { cartId, merchandiseMode: "MANUAL" } })).toBe(0);
  // Reopening shows the same neutral message, the notice goes away, and the shopper can try again by hand.
  await page.locator("[data-voucher-picker] > button").click();
  await expect(dialog).toContainText("Chưa xác định được kết quả");
  await expect(dialog.getByRole("button", { name: "Áp dụng mã" })).toBeVisible();
});

test("review 8bfe958: a linked code whose response is lost after the server saved it, with the dialog closed, ends with the cart showing the saved choice and no false success or refusal", async ({ page }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL70", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 70K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await prisma.cartVoucherSelection.deleteMany({ where: { cartId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/shop/${PREFIX}dress?voucher=KOL70`);
  await page.goto(`${BASE}/cart`);
  const expected = page.locator("[data-cart-voucher-total]").first();
  await expect(expected).toContainText("880.000");
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  const action = await holdNextServerAction(page, "lose-response");
  await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
  await action.reached;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  action.release();
  // The server saved it; the browser never heard. The cart re-reads the truth by itself and says the outcome was not known.
  await expect.poll(async () => (await prisma.cartVoucherSelection.findUnique({ where: { cartId } }))?.merchandiseVoucherId ?? null).not.toBeNull();
  await expect(expected).toContainText("860.000");
  await expect(page.locator("[data-voucher-picker] > p", { hasText: "Chưa xác định được kết quả" })).toBeVisible();
  await expect(page.getByText("Yêu cầu áp dụng ưu đãi chưa được thực hiện")).toHaveCount(0);
  // Nothing was replayed: exactly one saved choice for the cart.
  expect(await prisma.cartVoucherSelection.count({ where: { cartId } })).toBe(1);
});

test("review 04dea8b: the linked code applied while pricing cannot be re-read is a success the shopper is told about, not a closed dialog", async ({ page, context }) => {
  await prisma.voucherCampaign.create({
    data: { pancakeShopId: SHOP, kind: "MERCHANDISE", issuance: "CODE", visibility: "PRIVATE", code: "KOL74", discountType: "FIXED_AMOUNT_VND", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date(), name: "KOL 74K", fixedAmountVnd: BigInt(70_000), minEligibleSubtotalVnd: BigInt(600_000) },
  });
  await context.addCookies([{ name: "la_voucher_code", value: "KOL74", url: BASE, httpOnly: true, sameSite: "Lax" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/cart`);
  await page.locator("[data-voucher-picker] > button").click();
  const dialog = page.getByRole("dialog", { name: "Ưu đãi" });
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION vchr_co_empty_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "CartItem" WHERE "cartId" = NEW."cartId"; RETURN NULL; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER vchr_co_empty_cart_t AFTER INSERT OR UPDATE ON "CartVoucherSelection" FOR EACH ROW EXECUTE FUNCTION vchr_co_empty_cart()`);
  try {
    await dialog.getByRole("button", { name: "Dùng mã từ liên kết" }).click();
    await expect(dialog).toContainText("Đã áp dụng mã ưu đãi");
    await expect(dialog.locator("p[role='alert']")).toHaveCount(0);
    expect((await prisma.cartVoucherSelection.findUniqueOrThrow({ where: { cartId } })).merchandiseVoucherId).not.toBeNull();
    await expect(dialog).toBeVisible();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS vchr_co_empty_cart_t ON "CartVoucherSelection"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS vchr_co_empty_cart()`);
  }
});

test("a voucher that costs a gift needs the shopper's own consent before it can be held", async ({ page }) => {
  const gift = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}gift`, slug: `${PREFIX}gift`, name: "Khăn quà", isActive: true, isPresent: true, syncedAt: new Date(),
      variants: { create: { pancakeVariationId: `${PREFIX}gift-var`, color: "Trắng", size: "M", isActive: true, isPresent: true, syncedAt: new Date(), pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}wh`, quantity: 10, syncedAt: new Date() } } } } },
    include: { variants: true },
  });
  // The gift needs the whole 900.000đ; the voucher takes the cart to 850.000đ.
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${PREFIX}gift`, kind: "GIFT_ITEM", name: "Quà 900K", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 900_000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE",
      maxGiftsPerOrder: 1, allowDuplicateGifts: false, giftOptions: { create: { variantId: gift.variants[0]!.id } },
    },
  });
  await page.goto(`${BASE}/checkout`);
  await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "offered");
  await expect(page.locator("[data-checkout-voucher-gift-loss]")).toBeVisible();
  const confirm = panel(page).getByRole("button", { name: "Áp dụng và giữ ưu đãi" });
  await expect(confirm).toBeDisabled();
  expect(await holds()).toHaveLength(0);
  await panel(page).getByRole("checkbox", { name: /Tôi đồng ý/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(panel(page)).toHaveAttribute("data-checkout-vouchers", "held");
  expect(await holds()).toHaveLength(1);
});
