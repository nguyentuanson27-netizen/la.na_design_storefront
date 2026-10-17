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

// AM-01 (OD-01 = A): checkout shows the proven opportunity and the way to /sale; it never adds a
// paid unit itself. The +1 action, its proof and its races stay covered by
// tests/database/promotion-upsell.test.ts, which this browser suite no longer duplicates.
test("AM-01/A: the banner names the proven offer, links to /sale and offers no inline add", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer, output).toBeVisible();
  await expect(offer.getByRole("heading", { name: "Thêm 1 sản phẩm phù hợp để đạt ưu đãi" })).toBeVisible();
  await expect(offer).toContainText("Chương trình: Mua 3 tặng khăn");
  await expect(offer).toContainText("Không phải mọi sản phẩm ở trang Sale đều thuộc chương trình");
  await expect(offer.getByRole("combobox")).toHaveCount(0);
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toHaveCount(0);
  await expect(offer.getByRole("link", { name: "Tiếp tục mua sắm" })).toHaveAttribute("href", "/sale");
  // UX-08: the offer never sits in front of a blocking reason or locks submit.
  await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
  expect(await page.locator("form").count()).toBe(1);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/upsell-checkout-banner.png", fullPage: true });
  // Nothing typed: the link simply goes.
  await offer.getByRole("link", { name: "Tiếp tục mua sắm" }).click();
  await expect(page).toHaveURL(`${BASE}/sale`);
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("AC-07: leaving a filled form warns first; staying keeps fields and focus; continuing reaches /sale", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  const fields = [page.getByLabel("Họ và tên", { exact: false }), page.getByLabel("Số điện thoại", { exact: false }), page.getByLabel("Số nhà", { exact: false })];
  await fields[0]!.fill("Nàng La.na");
  await fields[1]!.fill("0901234567");
  await fields[2]!.fill("171 đường hoa");
  const exit = offer.getByRole("link", { name: "Tiếp tục mua sắm" });
  await exit.focus();
  await page.keyboard.press("Enter");
  const warning = offer.getByRole("group", { name: "Rời trang thanh toán?" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("chưa được gửi và sẽ không được lưu");
  await expect(page).toHaveURL(`${BASE}/checkout`);
  await expect(warning.getByText("Rời trang thanh toán?")).toBeFocused();
  await warning.getByRole("button", { name: "Ở lại thanh toán" }).click();
  await expect(warning).toHaveCount(0);
  await expect(exit).toBeFocused();
  await expect(fields[0]!).toHaveValue("Nàng La.na"); await expect(fields[1]!).toHaveValue("0901234567"); await expect(fields[2]!).toHaveValue("171 đường hoa");
  // The details live only in the mounted form: nothing typed is written to storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("0901234567");
  expect(stored).not.toContain("Nàng La.na");
  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  await exit.click();
  await warning.getByRole("link", { name: "Vẫn đến trang Sale" }).click();
  await expect(page).toHaveURL(`${BASE}/sale`);
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
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
test("D-06: the close button dismisses like the skip link; a withdrawn offer shows no invitation", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: { increment: 1 } } });
  await page.goto(`${BASE}/cart`);
  await page.goto(`${BASE}/checkout`);
  await expect(page.getByRole("heading", { name: "Giao hàng COD" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
});
