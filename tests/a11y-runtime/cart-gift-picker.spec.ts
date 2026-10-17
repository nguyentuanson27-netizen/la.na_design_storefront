import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const ROOT = resolve(import.meta.dirname, "../..");
const URL = "http://127.0.0.1:3348";
const SHOP = 920_014;
const PREFIX = "gq14-browser-";
const campaignId = `${PREFIX}gift`;
let server: ChildProcess;
let output = "";
let cartId: string, paidId: string, giftId: string;
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
async function openPicker(picker: Locator) {
  const toggle = picker.locator("button[aria-controls]");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const product = picker.getByRole("button", {name: "Khăn quà", exact: true});
  if (await product.count() && await product.getAttribute("aria-expanded") === "false") await product.click();
}
test("cart has one functional gift picker above paid products on mobile and desktop", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${URL}/cart`);

    const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
    await expect(picker).toHaveCount(1);
    await expect(page.locator("#cart-gifts")).toHaveCount(1);
    await expect(page.locator('[data-promotion-banner="full"] [data-promotion-kind="GIFT"][data-promotion-state="achieved"]')).toHaveCount(0);
    await expect(page.locator('[data-promotion-banner="full"] a[href="#cart-gifts"]')).toHaveCount(0);

    const beforePaidLines = await picker.evaluate((region) => {
      const paidLine = [...document.querySelectorAll("article")].find((item) => item.textContent?.includes("Áo mua"));
      return paidLine !== undefined && (region.compareDocumentPosition(paidLine) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(beforePaidLines).toBe(true);

    const toggle = picker.getByRole("button", { name: "Chọn quà ngay" });
    await expect(page.getByRole("button", { name: "Chọn quà ngay", exact: true })).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(picker.getByRole("button", { name: "Khăn quà", exact: true })).toBeVisible();
  }

  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await picker.getByRole("button", { name: "Khăn quà", exact: true }).click();
  await picker.getByRole("button", { name: "Nhận quà này" }).click();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  await expect.poll(() => prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  await page.reload();
  await expect(page.getByRole("region", { name: "Quà tặng trong giỏ" })).toHaveCount(1);
  await expect(page.locator('[data-promotion-banner="full"] [data-promotion-kind="GIFT"][data-promotion-state="achieved"]')).toHaveCount(0);
});

test("mobile keyboard picker saves partial/full/zero choices without changing paid items; Axe clean", async ({ page }) => {
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Đã thêm 0/2");
  await openPicker(picker);
  await picker.getByRole("button", {name: "Trắng / M", exact:true}).focus();
  await page.keyboard.press("Enter");
  await expect(picker).toContainText("Chưa thêm vào đơn");
  expect(await prisma.cartGiftSelection.count({where:{cartId}})).toBe(0);
  await picker.getByRole("button", { name: "Nhận quà này" }).focus();
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("status")).toContainText("Đã thêm vào đơn");
  await expect(picker).toContainText("Đã thêm 1/2");
  await picker.getByRole("button", { name: "Nhận quà này" }).click();
  await expect(picker).toContainText("Đã thêm 2/2");
  await expect(picker.getByRole("button", { name: "Nhận quà này" })).toBeDisabled();
  await expect.poll(() => prisma.cartItem.count({ where: { cartId } })).toBe(1);
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/gq14-mobile.png", fullPage: true });
  await picker.getByRole("button", { name: /^Bỏ 1 chiếc/ }).click();
  await expect(picker).toContainText("Đã thêm 1/2");
  await picker.getByRole("button", { name: /^Bỏ quà để chọn lại/ }).click();
  await expect(picker).toContainText("Đã thêm 0/2");
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
  await openPicker(picker);
  await expect(picker).toContainText("2 quà");
  await picker.getByRole("button", { name: /^Bỏ toàn bộ/ }).click();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});

test("F4: keyboard removal of one gift preserves the other gift and focus in the gift area", async ({ page }) => {
  const other = await prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: PREFIX + "other", slug: PREFIX + "other", name: "Quà còn lại", syncedAt: new Date(),
    variants: { create: { pancakeVariationId: PREFIX + "other", color: "Xanh", size: "M", syncedAt: new Date(),
      warehouseStocks: { create: { pancakeWarehouseId: "gq14-wh", quantity: 10, syncedAt: new Date() } } } } }, include: { variants: true } });
  const otherId = other.variants[0].id;
  await prisma.giftOption.create({ data: { campaignId, variantId: otherId } });
  await prisma.cartGiftSelection.createMany({ data: [giftId, otherId].map(variantId => ({ cartId, campaignId, variantId, campaignRevision: 1, quantity: 1 })) });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  const orders = await prisma.orderMirror.count(), holds = await prisma.variantCapacityReservation.count();
  const remove = picker.locator(`[data-gift-selection="${campaignId}/${giftId}"]`).getByRole("button", { name: /^Bỏ quà để chọn lại/ });
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("status")).toContainText("Đã bỏ 1 quà");
  await expect(remove).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker.locator("button[aria-controls]")).toHaveAttribute("aria-expanded", "true");
  expect(await prisma.cartGiftSelection.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: otherId, quantity: 1 })]);
  expect(await prisma.cartItem.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: paidId, quantity: 2 })]);
  expect(await prisma.orderMirror.count()).toBe(orders);
  expect(await prisma.variantCapacityReservation.count()).toBe(holds);
});

test("F4: keyboard reduction from two gifts to one restores focus after the reduce button disappears", async ({ page }) => {
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, campaignRevision: 1, quantity: 2 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  const reduce = picker.getByRole("button", { name: /^Bỏ 1 chiếc/ });
  await reduce.focus();
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("status")).toContainText("Đã bỏ 1 quà");
  await expect(reduce).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  expect(await prisma.cartGiftSelection.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: giftId, quantity: 1 })]);
  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});

test("F4: a refused reduction keeps the saved quantity, reports refusal and retains a usable control", async ({ page }) => {
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, campaignRevision: 1, quantity: 2 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { revision: 2 } });
  const reduce = picker.getByRole("button", { name: /^Bỏ 1 chiếc/ });
  await reduce.focus();
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("status")).toContainText("Chưa bỏ quà");
  await expect(picker.getByRole("status")).not.toContainText("Đã bỏ");
  await expect(reduce).toBeEnabled();
  await expect(reduce).toBeFocused();
  expect(await prisma.cartGiftSelection.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: giftId, campaignRevision: 1, quantity: 2 })]);
});
test("all-out gifts show stock shortage and allow leaving choices empty", async ({ page }) => {
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Hiện chưa có lựa chọn phù hợp cho 2 suất quà");
  await openPicker(picker);
  await expect(picker.getByRole("button", { name: "Nhận quà này" })).toBeDisabled();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
test("stock changed after rendering refuses the click and announces an error", async ({ page }) => {
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await picker.getByRole("button", { name: "Nhận quà này" }).click();
  await expect(picker.getByRole("status")).toContainText("Chưa thêm quà");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
test("duplicate product policy disables selecting the same gift again", async ({ page }) => {
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { allowDuplicateGifts: false } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Hiện chưa có lựa chọn phù hợp cho 1 suất");
  await expect(picker).not.toContainText("Thiếu tồn kho");
  await expect(picker).toContainText("Mỗi mẫu được chọn 1 lần");
  await openPicker(picker);
  expect(await prisma.warehouseStock.findFirst({where:{variantId:giftId}})).toHaveProperty("quantity",10);
  await picker.getByRole("button", { name: "Nhận quà này" }).click();
  await expect(picker).toContainText("Đã thêm 1");
  await expect(picker.getByRole("button", { name: "Nhận quà này" })).toBeDisabled();
});

test("F3: unavailable size explains disabled receive, another size stays browsable and chip-only never saves", async ({ page }) => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({ where: { id: giftId } });
  await prisma.variantMirror.update({ where: { id: giftId }, data: { size: "S" } });
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  const medium = await prisma.variantMirror.create({ data: { productId: gift.productId, pancakeVariationId: PREFIX + "gift-M", color: "Trắng", size: "M", syncedAt: new Date(),
    pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000, warehouseStocks: { create: { pancakeWarehouseId: "gq14-wh", quantity: 10, syncedAt: new Date() } } } });
  await prisma.giftOption.create({ data: { campaignId, variantId: medium.id } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  const receive = picker.getByRole("button", { name: "Nhận quà này", exact: true });
  await expect(receive).toBeDisabled();
  await expect(receive).toHaveAccessibleDescription("Chọn phiên bản trước khi nhận quà.");
  await picker.getByRole("button", { name: "Trắng / S", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(receive).toBeDisabled();
  await expect(receive).toHaveAccessibleDescription("Phiên bản này không còn số lượng có thể nhận thêm. Hãy chọn phiên bản khác.");
  await picker.getByRole("button", { name: "Trắng / M", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(receive).toBeEnabled();
  await expect(receive).not.toHaveAttribute("aria-describedby");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 0/2");
  await receive.click();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  await receive.click();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 2/2");
  await picker.getByRole("button", { name: "Trắng / S", exact: true }).click();
  await expect(receive).toHaveAccessibleDescription(/Đã đủ suất/);
  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});

test("F3: duplicate-product restriction describes the chosen model, not stock exhaustion", async ({ page }) => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({ where: { id: giftId } });
  const medium = await prisma.variantMirror.create({ data: { productId: gift.productId, pancakeVariationId: PREFIX + "gift-S", color: "Trắng", size: "S", syncedAt: new Date(),
    warehouseStocks: { create: { pancakeWarehouseId: "gq14-wh", quantity: 10, syncedAt: new Date() } } } });
  await prisma.giftOption.create({ data: { campaignId, variantId: medium.id } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { allowDuplicateGifts: false } });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, campaignRevision: 1, quantity: 1 } });
  await page.goto(`${URL}/cart`);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await openPicker(picker);
  await picker.getByRole("button", { name: "Trắng / S", exact: true }).click();
  const receive = picker.getByRole("button", { name: "Nhận quà này", exact: true });
  await expect(receive).toBeDisabled();
  await expect(receive).toHaveAccessibleDescription("Bạn đã chọn mẫu này. Mỗi mẫu chỉ được nhận một lần, kể cả khác màu hoặc kích cỡ.");
  await expect(picker).not.toContainText("không còn số lượng có thể nhận thêm");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
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
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toBeVisible();
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: giftId, quantity: 1, campaignRevision: 1 } });
  await prisma.cartItem.deleteMany({ where: { cartId } });
  await page.reload();
  await expect(page.getByText("Giỏ hàng của bạn đang trống.")).toBeVisible();
  await expect(picker.getByRole("alert")).toBeVisible();
  await openPicker(picker);
  await picker.getByRole("button", { name: /^Bỏ quà để chọn lại/ }).click();
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
  // GQ19: held back only because this shop has no line-level pricing evidence (the env list is empty here);
  // where the shop is verified the checkout re-quotes the dropped tier itself (checkout-benefit.spec.ts).
  await expect(page.getByText(/chưa thể đặt trực tuyến/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await prisma.giftQuantityCampaign.update({ where: { id: tierId }, data: { isEnabled: false } });
  await page.reload();
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toBeVisible();
  await expect(page.getByText(/giảm giá theo số lượng không còn áp dụng/)).toHaveCount(0);
});
