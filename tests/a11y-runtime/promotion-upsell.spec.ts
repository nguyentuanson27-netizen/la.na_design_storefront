import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = "http://127.0.0.1:3390";
const SHOP = 920007;
const P = "upsell-browser-";
const campaignId = `${P}gift`;
let server: ChildProcess; let output = "";
let cartId = "", paidId = "", giftProductId = "";
async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
test.beforeAll(async () => {
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3390"], {
    cwd: ROOT, env: { ...process.env, NEXT_DIST_DIR: ".next-test/promotion-upsell", PANCAKE_SHOP_ID: String(SHOP), PANCAKE_API_KEY: "checkout-a11y-test-key", NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${resolve(import.meta.dirname, "pancake-fetch-fixture.cjs")}`].filter(Boolean).join(" "), LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PROMOTION_UPSELL_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP), APP_DOMAIN: "127.0.0.1:3390", SEARCH_INDEXING_ENABLED: "false", BETTER_AUTH_URL: BASE, BETTER_AUTH_IP_HEADER: "x-ci-client-ip", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (c) => { output = (output + c).slice(-16000); });
  server.stderr?.on("data", (c) => { output = (output + c).slice(-16000); });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${BASE}/cart`)).ok) return; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error(output);
    await delay(200);
  }
  throw new Error(output);
});
test.beforeEach(async ({ context }) => {
  await cleanup();
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": "203.0.113.171" });
  async function product(id: string, price: number, sizes = ["S"]) {
    return prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: P + id, slug: P + id, name: `Áo ${id}`, syncedAt: new Date(), variants: { create: sizes.map((size, n) => ({ pancakeVariationId: P + id + size, color: "Hồng", size, pancakeRetailPrice: price + n * 10000, pancakeRetailPriceAfterDiscount: price + n * 10000, syncedAt: new Date(), warehouseStocks: { create: { pancakeWarehouseId: P + "wh", quantity: 20, syncedAt: new Date() } } })) } }, include: { variants: true } });
  }
  const paid = await product("paid", 100000); const candidate = await product("candidate", 100000, ["S", "M"]); const gift = await product("gift", 1000);
  paidId = paid.variants[0]!.id; giftProductId = gift.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, name: "Mua 3 tặng khăn", kind: "GIFT_ITEM", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", targets: { create: [paid.id, candidate.id].map((productId) => ({ productId, role: "INCLUDE" })) }, giftTrigger: "QUANTITY", minimumQuantity: 3, maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: { variantId: gift.variants[0]!.id } } } });
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});
test.afterAll(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise((r) => server.once("exit", r)), delay(5000)]); if (server.exitCode === null) server.kill("SIGKILL"); }
  await cleanup(); await prisma.$disconnect();
});

test("TG-07/08/10/12: sizes, atomic add, inline gift and quote refresh preserve receiving fields in one form", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer, output).toBeVisible();
  await page.getByLabel("Họ và tên", { exact: false }).fill("Nàng La.na");
  await page.getByLabel("Số điện thoại", { exact: false }).fill("0901234567");
  await page.getByLabel("Số nhà", { exact: false }).fill("171 đường hoa");
  const fields = [page.getByLabel("Họ và tên", { exact: false }), page.getByLabel("Số điện thoại", { exact: false }), page.getByLabel("Số nhà", { exact: false })];
  const oldProof = await page.locator('input[name="quoteProof"]').inputValue();
  const select = offer.getByLabel("Phân loại / màu / kích cỡ");
  await select.selectOption({ label: "Hồng / S" });
  await expect(offer).toContainText("+70.000");
  await select.selectOption({ label: "Hồng / M" });
  await expect(offer).toContainText("+80.000");
  await select.focus(); await page.keyboard.press("Tab");
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(offer).toHaveCount(0);
  await expect.poll(() => prisma.cartItem.count({ where: { cartId } })).toBe(2);
  await expect(page.locator('input[name="quoteProof"]')).not.toHaveValue(oldProof);
  await expect(fields[0]).toHaveValue("Nàng La.na"); await expect(fields[1]).toHaveValue("0901234567"); await expect(fields[2]).toHaveValue("171 đường hoa");
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toBeVisible();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  await picker.getByRole("button", { name: "Chọn Hồng / S" }).click();
  await expect(picker).toContainText("Đã chọn 1 · Chưa chọn 0");
  await expect(fields[0]).toHaveValue("Nàng La.na");
  expect(await page.locator("form").count()).toBe(1);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/upsell-checkout-desktop.png", fullPage: true });
});
test("TG-11: skip survives reload, paid A→B→A resets it, new checkout attempt resets it", async ({ page, context }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Không mua thêm, tiếp tục thanh toán" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 1 } });
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 2 } });
  await page.reload(); await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Không mua thêm, tiếp tục thanh toán" }).click();
  await page.getByRole("link", { name: "Giỏ hàng", exact: true }).click();
  await page.getByRole("link", { name: "Tiến hành đặt hàng" }).click();
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Không mua thêm, tiếp tục thanh toán" }).click();
  const newCart = await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } });
  await context.addCookies([{ name: "la_cart", value: newCart.id, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  await page.reload(); await expect(offer).toBeVisible();
});
test("TG-10: a committed add with a lost response recovers manual gifts on reload", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toBeEnabled();
  await page.route(`${BASE}/checkout`, async (route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
    await route.fetch(); // Let the server commit, then lose the entire action/refresh response.
    await route.abort("failed");
  });
  await offer.getByRole("button", { name: "Thêm 1 chiếc" }).click();
  await expect(page.getByText("Chưa xác nhận được kết quả thêm hàng.", { exact: false })).toBeVisible();
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(2);
  await page.unroute(`${BASE}/checkout`);
  await page.reload();
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toBeVisible();
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  await picker.getByRole("button", { name: "Chọn Hồng / S" }).click();
  await expect(picker).toContainText("Đã chọn 1 · Chưa chọn 0");
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(2);
});
test("TG-08/10: gift and upsell transitions share a lock until the refreshed quote arrives", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toBeEnabled();
  await offer.getByRole("button", { name: "Thêm 1 chiếc" }).click();
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toBeVisible();
  const other = await prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: P + "other", slug: P + "other", name: "Áo thêm", syncedAt: new Date(), variants: { create: { pancakeVariationId: P + "otherS", color: "Hồng", size: "S", pancakeRetailPrice: 100000, pancakeRetailPriceAfterDiscount: 100000, syncedAt: new Date(), warehouseStocks: { create: { pancakeWarehouseId: P + "wh", quantity: 20, syncedAt: new Date() } } } } } });
  const paidProducts = await prisma.cartItem.findMany({ where: { cartId }, select: { variant: { select: { productId: true } } } });
  const gift = await prisma.giftOption.findFirstOrThrow({ where: { campaignId } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { stackingEnabled: true, stackPeers: { create: { peerKind: "GIFT_ITEM", peerCampaignId: P + "next" } } } });
  await prisma.giftQuantityCampaign.create({ data: { id: P + "next", name: "Mua 4 tặng khăn", kind: "GIFT_ITEM", isEnabled: true, enabledAt: new Date(), stackingEnabled: true, stackPeers: { create: { peerKind: "GIFT_ITEM", peerCampaignId: campaignId } }, scopeMode: "DYNAMIC_CATEGORY", targets: { create: [...paidProducts.map((p) => p.variant.productId), other.id].map((productId) => ({ productId, role: "INCLUDE" })) }, giftTrigger: "QUANTITY", minimumQuantity: 4, maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: { variantId: gift.variantId } } } });
  await page.reload();
  await expect(offer).toBeVisible();
  await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
  const add = offer.getByRole("button", { name: "Thêm 1 chiếc" });
  await expect(add).toBeEnabled();
  await picker.getByLabel("Sản phẩm quà").selectOption(giftProductId);
  const choose = picker.getByRole("button", { name: "Chọn Hồng / S" });
  const submit = page.locator('button[type="submit"]');
  await expect(submit).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>((r) => release = r);
  let responseReady!: () => void;
  const ready = new Promise<void>((r) => responseReady = r);
  let requests = 0;
  await page.route(`${BASE}/checkout`, async (route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
    requests++;
    const response = await route.fetch();
    responseReady(); await held;
    await route.fulfill({ response });
  });
  try {
    await choose.click(); await ready;
    await expect(add).toBeDisabled(); await expect(submit).toBeDisabled();
    await add.evaluate((button: HTMLButtonElement) => button.click());
    expect(requests).toBe(1);
    release();
    await expect(picker).toContainText("Đã chọn 1 · Chưa chọn 0");
    await expect(submit).toBeEnabled();
    await page.unroute(`${BASE}/checkout`);
    // The inverse direction also locks gift controls while the paid add is pending.
    await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
    await expect(add).toBeEnabled();
    let releaseAdd!: () => void;
    const heldAdd = new Promise<void>((r) => releaseAdd = r);
    await page.route(`${BASE}/checkout`, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.continue();
      const response = await route.fetch();
      await heldAdd; await route.fulfill({ response });
    });
    try {
      await add.click();
      await expect(picker.getByRole("button", { name: /^Bỏ / })).toBeDisabled();
      await expect(submit).toBeDisabled();
    } finally { releaseAdd(); }
    await expect(offer).toHaveCount(0);
    await expect(submit).toBeEnabled();
  } finally { release(); await page.unroute(`${BASE}/checkout`); }
});
test("TG-01/09: stale offer fails without adding or discarding entered fields", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await page.getByLabel("Họ và tên", { exact: false }).fill("Giữ tên nàng");
  await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toBeEnabled();
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: { increment: 1 } } });
  await offer.getByRole("button", { name: "Thêm 1 chiếc" }).click();
  await expect(offer).toHaveCount(0);
  await expect(page.getByLabel("Họ và tên", { exact: false })).toHaveValue("Giữ tên nàng");
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("TG-07: negative payable delta remains an estimate for a paid unit", async ({ page }) => {
  const ids = await prisma.giftQuantityTarget.findMany({ where: { campaignId }, select: { productId: true } });
  await prisma.giftQuantityCampaign.delete({ where: { id: campaignId } });
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, kind: "QUANTITY_TIER", name: "Mua 3 giảm 90%", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", targets: { create: ids.map(({ productId }) => ({ productId, role: "INCLUDE" })) }, tiers: { create: { minQuantity: 3, discountValue: 90 } } } });
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await offer.getByLabel("Phân loại / màu / kích cỡ").selectOption({ label: "Hồng / S" });
  await expect(offer).toContainText("-200.000");
  await expect(offer).toContainText("Đây là sản phẩm mua thêm");
  await expect(offer).not.toContainText("miễn phí");
});
