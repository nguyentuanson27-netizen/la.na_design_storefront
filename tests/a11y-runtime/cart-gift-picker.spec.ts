import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const ROOT = resolve(import.meta.dirname, "../..");
const URL = "http://127.0.0.1:3348";
const SHOP = 920_014;
const PREFIX = "gq14-browser-";
const campaignId = `${PREFIX}gift`;
let server: ChildProcess;
let output = "";
let cartId: string, paidId: string, giftId: string, giftProductId: string;
async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
test.beforeAll(async () => {
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3348"], {
    cwd: ROOT, env: { ...process.env, PANCAKE_SHOP_ID: String(SHOP), LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_TRACKING_MODE: "preview", LA_GTM_CONTAINER_ID: "GTM-GQ14TEST", BETTER_AUTH_URL: URL, NEXT_DIST_DIR: ".next-test/gq14", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  server.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${URL}/cart`)).ok && (await fetch(`${URL}/api/auth/get-session`)).ok) return; } catch { /* compiling */ }
    if (server.exitCode !== null) throw new Error(output);
    await delay(500);
  }
  throw new Error(output);
});
test.beforeEach(async ({ context }) => {
  await cleanup();
  const now = new Date();
  async function product(suffix: string) {
    return prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}${suffix}`, slug: `${PREFIX}${suffix}`, name: suffix === "gift" ? "Khăn quà" : "Áo mua",
      syncedAt: now, variants: { create: { pancakeVariationId: `${PREFIX}${suffix}`, color: "Trắng", size: "M", syncedAt: now, pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
        warehouseStocks: { create: { pancakeWarehouseId: "gq14-wh", quantity: 10, syncedAt: now } } } } }, include: { variants: true } });
  }
  paidId = (await product("paid")).variants[0].id;
  const gift = await product("gift");
  giftId = gift.variants[0].id;
  giftProductId = gift.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, kind: "GIFT_ITEM", name: "Quà", isEnabled: true, enabledAt: now, scopeMode: "GLOBAL_ALL_PAID_LINES",
    giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: 3, allowDuplicateGifts: true,
    giftOptions: { create: { variantId: giftId } } } });
  await context.addCookies([{ name: "la_cart", value: cartId, url: URL, httpOnly: true, sameSite: "Lax" }]);
});
test.afterAll(async () => {
  server?.kill("SIGTERM");
  await cleanup();
  await prisma.$disconnect();
});
test("mobile keyboard picker saves partial/full/zero choices without changing paid items; Axe clean", async ({ page }) => {
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Được nhận 2 · Đã chọn 0 · Chưa chọn 2");
  const select = picker.getByLabel("Sản phẩm quà");
  await select.focus();
  await select.selectOption(giftProductId);
  await page.keyboard.press("Tab");
  await expect(picker.getByRole("button", { name: "Chọn Trắng / M" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("status")).toHaveText("Đã lưu lựa chọn quà.");
  await expect(picker).toContainText("Đã chọn 1 · Chưa chọn 1");
  await picker.getByRole("button", { name: "Chọn Trắng / M" }).click();
  await expect(picker).toContainText("Đã chọn 2 · Chưa chọn 0");
  await expect(picker.getByRole("button", { name: "Chọn Trắng / M" })).toBeDisabled();
  await expect.poll(() => prisma.cartItem.count({ where: { cartId } })).toBe(1);
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/gq14-mobile.png", fullPage: true });
  await picker.getByRole("button", { name: /^Giảm / }).click();
  await expect(picker).toContainText("Đã chọn 1 · Chưa chọn 1");
  await picker.getByRole("button", { name: /^Bỏ / }).click();
  await expect(picker).toContainText("Đã chọn 0 · Chưa chọn 2");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("stale selection is retained and announced after paid reduction or rule change", async ({ page }) => {
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, quantity: 2, campaignRevision: 1 } });
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 1 } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { revision: 2 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker.getByRole("alert")).toContainText("không còn phù hợp");
  await expect(picker).toContainText("2 quà");
  await picker.getByRole("button", { name: /^Bỏ / }).click();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
test("all-out gifts show stock shortage and allow leaving choices empty", async ({ page }) => {
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Thiếu tồn kho cho 2 suất quà");
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  await expect(picker.getByRole("button", { name: "Chọn Trắng / M" })).toBeDisabled();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
test("stock changed after rendering refuses the click and announces an error", async ({ page }) => {
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await picker.getByRole("button", { name: "Chọn Trắng / M" }).click();
  await expect(picker.getByRole("status")).toContainText("Không thể lưu quà");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
test("duplicate product policy disables selecting the same gift again", async ({ page }) => {
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { allowDuplicateGifts: false } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Không đủ lựa chọn quà hợp lệ cho 1 suất");
  await expect(picker).not.toContainText("Thiếu tồn kho");
  await expect(picker).toContainText("Mỗi sản phẩm được chọn tối đa 1 chiếc quà");
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  await expect(picker).toContainText("Còn 10");
  await picker.getByRole("button", { name: "Chọn Trắng / M" }).click();
  await expect(picker).toContainText("Đã chọn 1");
  await expect(picker.getByRole("button", { name: "Chọn Trắng / M" })).toBeDisabled();
});
test("view_cart retains the no-tier paid total once across refresh, and emits nothing for EX-17", async ({ page }) => {
  const events = () => page.evaluate(() => ((window as { dataLayer?: { event?: string; ecommerce?: { value?: number } }[] }).dataLayer ?? []).filter((entry) => entry.event === "view_cart"));
  await page.goto(`${URL}/cart`);
  await expect.poll(events).toHaveLength(1);
  expect((await events())[0].ecommerce?.value).toBe(200_000);
  const refresh = page.waitForResponse((response) => response.url().includes("/cart?") && response.request().headers()["rsc"] === "1");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refresh;
  await expect.poll(events).toHaveLength(1);
  await prisma.variantMirror.update({ where: { id: paidId }, data: { pancakeRetailPrice: 100_001, pancakeRetailPriceAfterDiscount: 100_001 } });
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 3 } });
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId } });
  await prisma.productCategoryMembership.create({ data: { productId: paid.productId, categoryKey: "vayDam" } });
  await prisma.giftQuantityCampaign.create({ data: { id: `${PREFIX}tier`, kind: "QUANTITY_TIER", name: "Tier", isEnabled: true, enabledAt: new Date(),
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "FROM_REACHED_THRESHOLD",
    tierSelectionPriority: "CHEAPEST_FIRST", tiers: { create: { minQuantity: 3, discountValue: 10 } } } });
  await page.reload();
  await expect(page.getByText("290.003", { exact: false }).first()).toBeVisible();
  expect(await events()).toEqual([]);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { minimumSubtotalVnd: null } });
  await page.reload();
  await expect(page.getByText("Chưa thể tính").first()).toBeVisible();
  expect(await events()).toEqual([]);
});
test("below-threshold shows shortfall; empty paid cart still shows stale gift to remove", async ({ page }) => {
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { minimumSubtotalVnd: 300_000 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Được nhận 0");
  await expect(picker).toContainText("Mua thêm 100.000");
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toBeVisible();
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, quantity: 1, campaignRevision: 1 } });
  await prisma.cartItem.deleteMany({ where: { cartId } });
  await page.reload();
  await expect(page.getByText("Giỏ hàng của bạn đang trống.")).toBeVisible();
  await expect(picker.getByRole("alert")).toBeVisible();
  await picker.getByRole("button", { name: /^Bỏ / }).click();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await prisma.cart.delete({ where: { id: cartId } });
});
test("EX-21 after price sync with no gifts blocks checkout even at the legacy total; no-drop restores it", async ({ page }) => {
  await prisma.giftQuantityCampaign.delete({ where: { id: campaignId } });
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 1 } });
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId } });
  await prisma.productCategoryMembership.create({ data: { productId: paid.productId, categoryKey: "vayDam" } });
  const tierId = `${PREFIX}tier`;
  await prisma.giftQuantityCampaign.create({ data: { id: tierId, kind: "QUANTITY_TIER", name: "Tier", isEnabled: true, enabledAt: new Date(),
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "FIXED_AMOUNT_PER_UNIT_VND", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
    tiers: { create: { minQuantity: 1, discountValue: 50_000 } } } });
  await page.goto(`${URL}/cart`);
  await expect(page.getByText("50.000", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  await prisma.variantMirror.update({ where: { id: paidId }, data: { pancakeRetailPrice: 40_000, pancakeRetailPriceAfterDiscount: 40_000 } });
  await page.reload();
  await expect(page.getByText("40.000", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/giảm giá theo số lượng không còn áp dụng.*giá hiện tại không hợp lệ/)).toBeVisible();
  await expect(page.getByText(/Cần kiểm tra và xác nhận lại báo giá/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await prisma.giftQuantityCampaign.update({ where: { id: tierId }, data: { isEnabled: false } });
  await page.reload();
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toBeVisible();
  await expect(page.getByText(/giảm giá theo số lượng không còn áp dụng/)).toHaveCount(0);
});
