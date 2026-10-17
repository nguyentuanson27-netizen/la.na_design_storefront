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
let cartId = "", paidId = "";
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
  paidId = paid.variants[0]!.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, name: "Mua 3 tặng khăn", kind: "GIFT_ITEM", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", targets: { create: [paid.id, candidate.id].map((productId) => ({ productId, role: "INCLUDE" })) }, giftTrigger: "QUANTITY", minimumQuantity: 3, maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: { variantId: gift.variants[0]!.id } } } });
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE, httpOnly: true, sameSite: "Lax" }]);
});
test.afterAll(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise((r) => server.once("exit", r)), delay(5000)]); if (server.exitCode === null) server.kill("SIGKILL"); }
  await cleanup(); await prisma.$disconnect();
});

// PR #178 replaced inline upsell mutations with a compact reminder; PR #180 sends shopping
// to /sale. Keep browser coverage on the shipped flow. Proof/atomic-add/stale-stock/recovery-marker
// semantics remain exercised by tests/database/promotion-upsell.test.ts and the gift checkout suite.
test("compact upsell preserves checkout fields and quote without inline purchase controls", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer, output).toBeVisible();
  await page.getByLabel("Họ và tên", { exact: false }).fill("Nàng La.na");
  await page.getByLabel("Số điện thoại", { exact: false }).fill("0901234567");
  await page.getByLabel("Số nhà", { exact: false }).fill("171 đường hoa");
  const proof = await page.locator('input[name="quoteProof"]').inputValue();
  const paid = await prisma.cartItem.findMany({ where: { cartId } });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(offer.getByRole("heading", { name: "Mua 3 tặng khăn" })).toBeVisible();
    await expect(offer).toContainText("thêm đúng 1 sản phẩm phù hợp");
    await expect(offer.getByRole("link", { name: "Tiếp tục mua sắm" })).toHaveAttribute("href", "/sale");
    await expect(offer.locator("select, input, img")).toHaveCount(0);
    await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toHaveCount(0);
    expect(await page.locator("form").count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
    if (width !== 320) await page.screenshot({ path: `test-results/upsell-banner-${width}.png`, fullPage: true });
  }
  // Hydration may read gift state through a Server Action. Count only the dismiss gesture,
  // after the rendered checkout is settled; the DB and proof assertions also pin no mutation.
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && request.headers()["next-action"]) writes++; });
  await offer.getByRole("button", { name: "Không mua thêm, tiếp tục thanh toán" }).click();
  await expect(offer).toHaveCount(0);
  await expect(page.getByLabel("Họ và tên", { exact: false })).toHaveValue("Nàng La.na");
  await expect(page.getByLabel("Số điện thoại", { exact: false })).toHaveValue("0901234567");
  await expect(page.getByLabel("Số nhà", { exact: false })).toHaveValue("171 đường hoa");
  await expect(page.locator('input[name="quoteProof"]')).toHaveValue(proof);
  expect(await prisma.cartItem.findMany({ where: { cartId } })).toEqual(paid);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  expect(writes).toBe(0);
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

test("the shopping link is keyboard operable and navigates to sale without changing the cart", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  const link = offer.getByRole("link", { name: "Tiếp tục mua sắm" });
  await expect(link).toHaveAttribute("href", "/sale");
  const paid = await prisma.cartItem.findMany({ where: { cartId } });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${BASE}/sale`);
  await expect(page.getByRole("main")).toBeVisible();
  expect(await prisma.cartItem.findMany({ where: { cartId } })).toEqual(paid);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});

test("the close control dismisses with the keyboard and persists through reload", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).focus();
  await page.keyboard.press("Enter");
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("an inactive campaign no longer shows a reminder after the next server render", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: { increment: 1 } } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("reaching the milestone offers the real manual gift picker without an automatic gift", async ({ page }) => {
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 3 } });
  await page.goto(`${BASE}/checkout`);
  await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Gợi ý mua thêm" })).toHaveCount(0);
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toContainText("Đã thêm 0/1");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  await page.getByLabel("Họ và tên", { exact: false }).fill("Giữ tên khi chọn quà");
  await picker.getByRole("button", { name: "Chọn quà ngay", exact: true }).click();
  await picker.getByRole("button", { name: "Áo gift", exact: true }).click();
  await picker.getByRole("button", { name: "Nhận quà này" }).click();
  await expect(picker).toContainText("Đã thêm 1/1");
  await expect(page.getByLabel("Họ và tên", { exact: false })).toHaveValue("Giữ tên khi chọn quà");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(1);
  expect((await prisma.cartItem.findMany({ where: { cartId } })).map(row => ({ variantId: row.variantId, quantity: row.quantity }))).toEqual([{ variantId: paidId, quantity: 3 }]);
});

test("a cart more than one unit below the milestone has no upsell reminder", async ({ page }) => {
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 1 } });
  await page.goto(`${BASE}/checkout`);
  await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Gợi ý mua thêm" })).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
});
