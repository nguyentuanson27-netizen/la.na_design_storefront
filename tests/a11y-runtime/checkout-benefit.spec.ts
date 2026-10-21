import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * GQ19 -- the buyer's checkout for a cart with gifts: gift lines at 0đ, the unclaimed-slot account,
 * the never-pre-checked acknowledgement, and the cart link that is offered only where the POS shop is
 * verified for line-level pricing.
 *
 * The submit itself (proof, tick, order) is held to a real database in
 * `tests/database/benefit-checkout-snapshot.test.ts`; this spec holds the browser to what the buyer sees.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const HOST = "127.0.0.1";
// The address lists come from the same Pancake fixture the checkout spec uses (it answers for this shop
// and key); without them the form keeps its submit button disabled on a geo failure.
const SHOP = 920_007;
const TEST_API_KEY = "checkout-a11y-test-key";
const TRUSTED_CLIENT_IP = "203.0.113.45";
const PANCAKE_FETCH_FIXTURE = resolve(import.meta.dirname, "pancake-fetch-fixture.cjs");
const PREFIX = "gq19-browser-";
const runtimeId = `${Date.now()}-${process.pid}`;
const campaignId = `${PREFIX}gift`;

let server: ChildProcess | undefined;
let output = "";
let baseUrl = "";
let cartId = "";
let giftVariantId = "";

async function cleanup() {
  await prisma.rateLimit.deleteMany({});
  const orders = await prisma.orderMirror.findMany({where:{pancakeShopId:SHOP, lines:{some:{pancakeVariationId:{startsWith:PREFIX}}}},select:{id:true}});
  for(const {id} of orders) await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`DELETE FROM "OrderPreorderLineSnapshot" WHERE "snapshotId" IN (SELECT "id" FROM "OrderPreorderSnapshot" WHERE "orderId" = ${id})`;
    await tx.$executeRaw`DELETE FROM "OrderPreorderSnapshot" WHERE "orderId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteDiscountStep" WHERE "lineRowId" IN (SELECT l."id" FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId" WHERE s."orderId" = ${id})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteLine" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ${id})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteEntitlement" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ${id})`;
    await tx.$executeRaw`DELETE FROM "OrderQuoteSnapshot" WHERE "orderId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "CapacityReservationResource" WHERE "reservationId" IN (SELECT "id" FROM "VariantCapacityReservation" WHERE "orderId" = ${id})`;
    await tx.$executeRaw`DELETE FROM "VariantCapacityReservation" WHERE "orderId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "OrderLineSnapshot" WHERE "orderId" = ${id}`;
    await tx.$executeRaw`DELETE FROM "OrderMirror" WHERE "id" = ${id}`;
  });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function startServer(port: number, verified: boolean) {
  port += Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0);
  baseUrl = `http://${HOST}:${port}`;
  output = "";
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", HOST, "--port", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP),
      PANCAKE_API_KEY: TEST_API_KEY,
      PANCAKE_A11Y_BENEFIT_ORDER: "true",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${PANCAKE_FETCH_FIXTURE}`].filter(Boolean).join(" "),
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: verified ? String(SHOP) : "",
      BETTER_AUTH_URL: baseUrl,
      BETTER_AUTH_IP_HEADER: "x-ci-client-ip",
      NEXT_DIST_DIR: `.next-test/gq19-${port}-${runtimeId}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  server.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/cart`)).ok && (await fetch(`${baseUrl}/api/auth/get-session`)).ok) return;
    } catch {
      // still compiling
    }
    if (server.exitCode !== null) throw new Error(output);
    await delay(500);
  }
  throw new Error(output);
}

async function stopServer() {
  const running = server;
  server = undefined;
  if (!running || running.exitCode !== null) return;
  running.kill("SIGTERM");
  await Promise.race([new Promise((done) => running.once("exit", done)), delay(8_000)]);
  if (running.exitCode === null) running.kill("SIGKILL");
}

test.beforeEach(async ({ context }) => {
  // The geo reads are rate-limited per client, and the client is only known from the trusted proxy header.
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": TRUSTED_CLIENT_IP });
  await cleanup();
  const now = new Date();
  async function product(suffix: string, name: string) {
    return prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP, pancakeProductId: `${PREFIX}${suffix}`, slug: `${PREFIX}${suffix}`, name, syncedAt: now,
        variants: { create: { pancakeVariationId: `${PREFIX}${suffix}`, color: "Trắng", size: "M", syncedAt: now, pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000, warehouseStocks: { create: { pancakeWarehouseId: "gq19-wh", quantity: 10, syncedAt: now } } } },
      },
      include: { variants: true },
    });
  }
  const paid = await product("paid", "Áo mua");
  const gift = await product("gift", "Khăn quà");
  giftVariantId = gift.variants[0]!.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId: paid.variants[0]!.id, quantity: 2 } } } })).id;
  // 2 x 100.000đ = 200.000đ; one gift slot per full 100.000đ, so two slots are earned.
  await prisma.giftQuantityCampaign.create({
    data: {
      id: campaignId, kind: "GIFT_ITEM", name: "Quà", isEnabled: true, enabledAt: now, scopeMode: "GLOBAL_ALL_PAID_LINES",
      giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD",
      maxGiftsPerOrder: 3, allowDuplicateGifts: true, giftOptions: { create: { variantId: giftVariantId } },
    },
  });
  await context.addCookies([{ name: "la_cart", value: cartId, url: `http://${HOST}:3350`, httpOnly: true, sameSite: "Lax" }]);
  await context.addCookies([{ name: "la_cart", value: cartId, url: `http://${HOST}:3351`, httpOnly: true, sameSite: "Lax" }]);
});

test.afterEach(async () => {
  await stopServer();
});

test.afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const chooseGift = (quantity: number) =>
  prisma.cartGiftSelection.upsert({
    where: { cartId_campaignId_variantId: { cartId, campaignId, variantId: giftVariantId } },
    create: { cartId, campaignId, variantId: giftVariantId, quantity, campaignRevision: 1 },
    update: { quantity },
  });

async function fillReceiving(page: import("@playwright/test").Page) {
  await page.getByLabel("Họ và tên", {exact:false}).fill("Nguyễn Văn A");
  await page.getByLabel("Số điện thoại", {exact:false}).fill("0901234567");
  await page.getByLabel("Tỉnh / Thành phố", {exact:false}).selectOption({label:"Tỉnh Current"});
  await page.getByLabel("Phường / Xã", {exact:false}).selectOption({label:"Phường Current"});
  await page.getByLabel("Số nhà, tên đường", {exact:false}).fill("12 Đường A");
  await page.getByLabel("Ghi chú", {exact:false}).fill("Giữ nguyên ghi chú");
}
async function expectReceiving(page: import("@playwright/test").Page) {
  await expect(page.getByLabel("Họ và tên", {exact:false})).toHaveValue("Nguyễn Văn A");
  await expect(page.getByLabel("Số điện thoại", {exact:false})).toHaveValue("0901234567");
  await expect(page.getByLabel("Tỉnh / Thành phố", {exact:false})).toHaveValue("84_VN902");
  await expect(page.getByLabel("Phường / Xã", {exact:false})).toHaveValue("84_VN90201");
  await expect(page.getByLabel("Số nhà, tên đường", {exact:false})).toHaveValue("12 Đường A");
  await expect(page.getByLabel("Ghi chú", {exact:false})).toHaveValue("Giữ nguyên ghi chú");
}
async function refreshQuote(page: import("@playwright/test").Page) {
  const before=await page.locator("form").getAttribute("data-checkout-render");
  const response = page.waitForResponse((r) => r.url().includes("/checkout?") && r.request().headers()["rsc"] === "1");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await response;
  await expect.poll(async()=> (await page.locator("form").getAttribute("data-checkout-render")) !== before).toBe(true);
}

test("AC06/08/10/19: validation precedes one reminder; Escape restores focus and creates no order", async ({ page }) => {
  await startServer(3350, true);
  await chooseGift(1);
  await page.goto(`${baseUrl}/checkout`);
  const ordersBefore = await prisma.orderMirror.count();
  const holdsBefore = await prisma.variantCapacityReservation.count();
  const submit = page.getByRole("button", {name:"Đặt hàng COD",exact:true});
  await submit.click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByLabel("Họ và tên", {exact:false})).toBeFocused();
  await fillReceiving(page);
  await submit.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toBeFocused();
  await expect(page.getByRole("checkbox", {name:/không nhận/})).toHaveCount(0);
  expect(await prisma.orderMirror.count()).toBe(ordersBefore);
  expect(await prisma.variantCapacityReservation.count()).toBe(holdsBefore);
  await page.keyboard.press("Enter");
  expect(await prisma.orderMirror.count()).toBe(ordersBefore);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(submit).toBeFocused();
  await expectReceiving(page);
  expect((await new AxeBuilder({page}).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});

for (const [quantity, width] of [[0,390],[1,1440],[2,390]] as const) {
  test(`AC25/26: popup → picker → ${quantity === 0 ? "chip only" : `receive ${quantity}`} → payment → one explicit order (${width}px)`, async ({page}) => {
    await startServer(3350, true);
    await page.setViewportSize({width,height:900});
    await page.goto(`${baseUrl}/checkout`);
    await fillReceiving(page);
    const ordersBefore = await prisma.orderMirror.count();
    const holdsBefore = await prisma.variantCapacityReservation.count();
    await page.getByRole("button", {name:"Đặt hàng COD",exact:true}).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"Chọn quà ngay",exact:true}).click();
    const picker = page.getByRole("region", {name:"Quà tặng trong giỏ"});
    await expect(picker).toBeFocused();
    await picker.getByRole("button", {name:"Khăn quà",exact:true}).click();
    await picker.getByRole("button", {name:"Trắng / M",exact:true}).click();
    await expect(picker).toContainText("Chưa thêm vào đơn");
    expect(await prisma.cartGiftSelection.count({where:{cartId}})).toBe(0);
    for(let n=1;n<=quantity;n++) {
      await picker.getByRole("button",{name:"Nhận quà này",exact:true}).click();
      await expect(picker.locator("[data-gift-progress]")).toContainText(`Đã thêm ${n}/2`);
      await expect(picker).toHaveAttribute("aria-busy","false");
    }
    // Receiving the last gift never collapses management.
    await expect(picker.getByRole("button",{name:"Thu gọn quà tặng",exact:true})).toHaveAttribute("aria-expanded","true");
    await picker.getByRole("button",{name:"Quay lại thanh toán",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Tổng kết thanh toán",exact:true})).toBeFocused();
    await expectReceiving(page);
    if(quantity===0) await expect(page.locator("[data-payment-gift-draft]")).toContainText("chưa được thêm");
    expect(await prisma.orderMirror.count()).toBe(ordersBefore);
    expect(await prisma.variantCapacityReservation.count()).toBe(holdsBefore);
    await page.screenshot({path:`test-results/gift-checkout-${width}-${quantity}.png`,fullPage:true});
    await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect.poll(() => prisma.orderMirror.count()).toBe(ordersBefore+1);
    const order = await prisma.orderMirror.findFirstOrThrow({where:{sourceCartId:cartId},orderBy:{createdAt:"desc"},include:{quoteSnapshot:{include:{lines:true,entitlements:true}}}});
    expect(order.quoteSnapshot!.lines.filter(l=>l.role==="GIFT").reduce((sum,l)=>sum+l.quantity,0)).toBe(quantity);
    expect(order.quoteSnapshot!.entitlements[0]!.selected).toBe(quantity);
    // The real submit/quote/proof/snapshot pipeline ran, not a UI counter.
    expect(order.guestName).toBe("Nguyễn Văn A");
    expect(order.note).toBe("Giữ nguyên ghi chú");
    await expect.poll(async () => { const row=await prisma.orderMirror.findUniqueOrThrow({where:{id:order.id}});return {state:row.state,code:row.syncErrorCode}; }).toEqual({state:"CONFIRMED",code:null});
    await expect(page).toHaveURL(/checkout\/success/);
  });
}

test("AC21: invalid gifts retain all receiving data across route refresh and can be removed without proof", async({page}) => {
  await startServer(3350,true);
  await chooseGift(1);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await page.keyboard.press("Escape");
  await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{isEnabled:false,revision:2}});
  await refreshQuote(page);
  await expect(page.locator('input[name="quoteProof"]')).toHaveValue("");
  await expectReceiving(page);
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeDisabled();
  const picker=page.getByRole("region",{name:"Quà tặng trong giỏ"});
  await picker.getByRole("button",{name:"Kiểm tra quà đã chọn",exact:true}).click();
  await picker.getByRole("button",{name:/^Bỏ quà để chọn lại/}).click();
  await expect(page.locator('input[name="quoteProof"]')).not.toHaveValue("");
  await expectReceiving(page);
  expect(await prisma.cartGiftSelection.count({where:{cartId}})).toBe(0);
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeEnabled();
});

test("F2: one invalid gift is identified; removing it preserves the valid gift, form, reminder and fresh proof", async ({ page }) => {
  const other = await prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: PREFIX + "other-gift", slug: PREFIX + "other-gift", name: "Quà còn hợp lệ", syncedAt: new Date(),
    variants: { create: { pancakeVariationId: PREFIX + "other-gift", color: "Xanh", size: "M", pancakeRetailPrice: 1_000, pancakeRetailPriceAfterDiscount: 1_000, syncedAt: new Date(),
      warehouseStocks: { create: { pancakeWarehouseId: PREFIX + "wh", quantity: 10, syncedAt: new Date() } } } } }, include: { variants: true } });
  const validId = other.variants[0].id;
  await prisma.giftOption.create({ data: { campaignId, variantId: validId } });
  await chooseGift(1);
  await startServer(3350, true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button", { name: "Đặt hàng COD", exact: true }).click();
  await page.keyboard.press("Escape");
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId, variantId: validId, campaignRevision: 1, quantity: 1 } });
  await prisma.warehouseStock.updateMany({ where: { variantId: giftVariantId }, data: { quantity: 0 } });
  await refreshQuote(page);
  const orders = await prisma.orderMirror.count(), holds = await prisma.variantCapacityReservation.count();
  await expect(page.locator('input[name="quoteProof"]')).toHaveValue("");
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await picker.getByRole("button", { name: "Kiểm tra quà đã chọn", exact: true }).click();
  const bad = picker.locator(`[data-gift-selection="${campaignId}/${giftVariantId}"]`);
  const good = picker.locator(`[data-gift-selection="${campaignId}/${validId}"]`);
  await expect(bad.locator("[data-gift-problem]")).toContainText("tạm hết hàng");
  await expect(good.locator("[data-gift-problem]")).toHaveCount(0);
  await bad.getByRole("button", { name: /^Bỏ quà để chọn lại/ }).click();
  await expect(page.locator('input[name="quoteProof"]')).not.toHaveValue("");
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  await expectReceiving(page);
  await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
  expect(await prisma.cartGiftSelection.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: validId, quantity: 1 })]);
  expect(await prisma.orderMirror.count()).toBe(orders);
  expect(await prisma.variantCapacityReservation.count()).toBe(holds);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("la-checkout-gift-reminder-v1")!).seen)).toBe(true);
});

for (const readback of [false, true]) {
  test(`F4: final invalid gift removal retains a named focus anchor without entitlement (${readback ? "lost response and retry" : "confirmed response"})`, async ({ page }) => {
    await chooseGift(1);
    await startServer(3350, true);
    await page.goto(`${baseUrl}/checkout`);
    await fillReceiving(page);
    await page.getByRole("button", { name: "Đặt hàng COD", exact: true }).click();
    await page.keyboard.press("Escape");
    await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false } });
    await refreshQuote(page);
    await expect(page.locator('input[name="quoteProof"]')).toHaveValue("");
    const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
    await picker.getByRole("button", { name: "Kiểm tra quà đã chọn", exact: true }).click();
    const orders = await prisma.orderMirror.count(), holds = await prisma.variantCapacityReservation.count();
    let writes = 0, mutationId: string | undefined, failRead = true;
    if (readback) await page.route("**/checkout", async route => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
      const action = request.headers()["next-action"];
      if (!mutationId || action === mutationId) {
        mutationId = action; writes++;
        await route.fetch();
        return route.abort("failed");
      }
      return failRead ? route.abort("failed") : route.continue();
    });
    const remove = picker.getByRole("button", { name: /^Bỏ quà để chọn lại/ });
    await remove.focus();
    await page.keyboard.press("Enter");
    if (readback) {
      const retry = picker.getByRole("button", { name: "Kiểm tra lại quà trong đơn", exact: true });
      await expect(retry).toBeVisible();
      await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeDisabled();
      await expect(picker.getByRole("status")).not.toContainText("Đã bỏ");
      failRead = false;
      await retry.focus();
      await page.keyboard.press("Enter");
    }
    await expect(page.locator('input[name="quoteProof"]')).not.toHaveValue("");
    await expect(remove).toHaveCount(0);
    await expect(picker).toBeVisible();
    await expect(picker).toBeFocused();
    await expect(picker.getByRole("status")).toContainText(readback ? "Đã kiểm tra lại quà" : "Đã bỏ 1 quà");
    await expect(picker.getByRole("heading", { name: "Quà dành cho nàng" })).toHaveCount(0);
    await expect(picker.locator("article")).toHaveCount(0);
    await expectReceiving(page);
    expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
    expect(await prisma.orderMirror.count()).toBe(orders);
    expect(await prisma.variantCapacityReservation.count()).toBe(holds);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("la-checkout-gift-reminder-v1")!).seen)).toBe(true);
    if (readback) expect(writes).toBe(1);
    await page.unroute("**/checkout");
  });
}

for (const scenario of ["delayed", "committed-readback", "uncommitted-readback", "tab-away"] as const) {
  test(`F4: ${scenario} removal never steals focus after the buyer leaves gift management`, async ({ page }) => {
    await chooseGift(1);
    await startServer(3350, true);
    await page.goto(`${baseUrl}/checkout`);
    await fillReceiving(page);
    await page.getByRole("button", { name: "Đặt hàng COD", exact: true }).click();
    await page.keyboard.press("Escape");
    const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
    await picker.getByRole("button", { name: "Chọn quà ngay", exact: true }).click();
    const orders = await prisma.orderMirror.count(), holds = await prisma.variantCapacityReservation.count();
    const before = await page.locator("form").getAttribute("data-checkout-render");
    let release!: () => void, responseReady!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { responseReady = resolve; });
    let mutationId: string | undefined, writes = 0;
    await page.route("**/checkout", async route => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
      const action = request.headers()["next-action"];
      if (!mutationId || mutationId === action) {
        mutationId = action; writes++;
        if (scenario === "uncommitted-readback") return route.abort("failed");
        const response = await route.fetch();
        if (scenario === "committed-readback") return route.abort("failed");
        responseReady();
        await held;
        return route.fulfill({ response });
      }
      const response = await route.fetch(); // Hold the read response, not another write.
      responseReady();
      await held;
      return route.fulfill({ response });
    });
    try {
      await picker.getByRole("button", { name: /^Bỏ quà để chọn lại/ }).focus();
      await page.keyboard.press("Enter");
      await ready;
      const destination = scenario === "uncommitted-readback"
        ? page.getByLabel("Ghi chú", { exact: false })
        : scenario === "tab-away" ? page.getByLabel("Họ và tên", { exact: false })
          : page.getByRole("heading", { name: "Tổng kết thanh toán", exact: true });
      if (scenario === "uncommitted-readback") await destination.click();
      else {
        await picker.getByRole("button", { name: "Quay lại thanh toán", exact: true }).focus();
        await page.keyboard.press(scenario === "tab-away" ? "Tab" : "Enter");
      }
      await expect(destination).toBeFocused();
      await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeDisabled();
      release();
      await expect(picker).toHaveAttribute("aria-busy", "false");
      await expect.poll(async () => (await page.locator("form").getAttribute("data-checkout-render")) !== before).toBe(true);
      await expect(destination).toBeFocused();
      await expectReceiving(page);
      await expect(page.locator('input[name="quoteProof"]')).not.toHaveValue("");
      if (scenario === "uncommitted-readback") {
        await expect(picker.getByRole("status")).not.toContainText("Đã bỏ");
        expect(await prisma.cartGiftSelection.findMany({ where: { cartId } })).toEqual([expect.objectContaining({ variantId: giftVariantId, quantity: 1 })]);
      } else expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
      expect(writes).toBe(1);
      expect(await prisma.orderMirror.count()).toBe(orders);
      expect(await prisma.variantCapacityReservation.count()).toBe(holds);
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("la-checkout-gift-reminder-v1")!).seen)).toBe(true);
    } finally { release(); await page.unroute("**/checkout"); }
  });
}

test("verified shop: every slot taken means no acknowledgement is asked", async ({ page }) => {
  await startServer(3350, true);
  await chooseGift(2);
  await page.goto(`${baseUrl}/checkout`);
  await expect(page.getByRole("button", { name: "Đặt hàng COD" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /không nhận/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Quà tặng và ưu đãi" })).toHaveCount(0);
});

test("a shop without line-level pricing evidence: the cart withholds the link and checkout says why", async ({ page }) => {
  await startServer(3351, false);
  await chooseGift(1);
  await page.goto(`${baseUrl}/cart`);
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toHaveCount(0);
  await expect(page.getByText(/chưa thể đặt trực tuyến/)).toBeVisible();

  // Typing the URL does not get around it: the page offers no form for a quote the POS would close.
  await page.goto(`${baseUrl}/checkout`);
  await expect(page.getByRole("button", { name: "Đặt hàng COD" })).toBeDisabled();
  await expect(page.getByText(/hiện chưa thể đặt trực tuyến/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Quay lại giỏ hàng/ })).toBeVisible();
});

test("AC07/18: dialog continuation shares the submit lock and confirms one order with current quote acknowledgement", async({page}) => {
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  const before=await prisma.orderMirror.count();
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  const proceed=page.getByRole("dialog").getByRole("button",{name:"Vẫn đặt hàng",exact:true});
  await expect(proceed).toBeEnabled();
  await proceed.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page).toHaveURL(/checkout\/success/);
  expect(await prisma.orderMirror.count()).toBe(before+1);
  const order=await prisma.orderMirror.findFirstOrThrow({where:{sourceCartId:cartId},orderBy:{createdAt:"desc"},include:{quoteSnapshot:true}});
  expect(order.state).toBe("CONFIRMED");
  expect(order.quoteSnapshot!.nonclaimAcknowledged).toBe(true);
  expect(order.quoteSnapshot!.acknowledgedAt).not.toBeNull();
});

test("AC12/13: quote refresh and reload keep only reminder metadata; client navigation ends the visit", async({page}) => {
  await startServer(3350,true);
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await page.keyboard.press("Escape");
  const readMetadata=()=>page.evaluate(()=>sessionStorage.getItem("la-checkout-gift-reminder-v1"));
  const metadata=JSON.parse((await readMetadata())!);
  expect(Object.keys(metadata).sort()).toEqual(["key","seen","version"]);
  expect(metadata.seen).toBe(true);
  await chooseGift(1);
  await refreshQuote(page);
  await expectReceiving(page);
  expect(JSON.parse((await readMetadata())!).key).toBe(metadata.key);
  await page.reload();
  await expect(page.getByLabel("Ghi chú",{exact:false})).toHaveValue("");
  await expect.poll(readMetadata).not.toBeNull();
  expect(JSON.parse((await readMetadata())!).seen).toBe(true);
  await page.locator('aside a[href="/cart"]:visible').click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect.poll(readMetadata).toBeNull();
  await page.getByRole("link",{name:"Tiến hành đặt hàng",exact:true}).click();
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("AC13: blocked tab storage falls back to memory without repeating the reminder in the same mount", async({page}) => {
  await page.addInitScript(()=>{
    Storage.prototype.setItem=()=>{throw new DOMException("blocked","SecurityError");};
    Storage.prototype.getItem=()=>{throw new DOMException("blocked","SecurityError");};
  });
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page).toHaveURL(/checkout\/success/);
  expect(await prisma.orderMirror.count({where:{sourceCartId:cartId}})).toBe(1);
});

test("AC14: changed quote is displayed and waits for a fresh explicit submit without another reminder", async({page}) => {
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await page.keyboard.press("Escape");
  const proof=page.locator('input[name="quoteProof"]');
  const old=await proof.inputValue();
  const paid=await prisma.cartItem.findFirstOrThrow({where:{cartId}});
  await prisma.variantMirror.update({where:{id:paid.variantId},data:{pancakeRetailPrice:110000,pancakeRetailPriceAfterDiscount:110000}});
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByText("Giá đã thay đổi",{exact:true})).toBeVisible();
  await expect.poll(async()=> (await proof.inputValue()) !== old).toBe(true);
  await expectReceiving(page);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await prisma.orderMirror.count({where:{sourceCartId:cartId}})).toBe(0);
});

test("AC11/22/25: committed gift with lost responses stays locked until readback; never repeat the write", async({page}) => {
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  const picker=page.getByRole("region",{name:"Quà tặng trong giỏ"});
  await picker.getByRole("button",{name:"Chọn quà ngay",exact:true}).click();
  await picker.getByRole("button",{name:"Khăn quà",exact:true}).click();
  let mutationId:string|undefined; let writes=0; let loseRead=true;
  await page.route("**/checkout",async route=>{
    const req=route.request();
    if(req.method()!=="POST") return route.continue();
    const action=req.headers()["next-action"];
    if(!mutationId || action===mutationId) {
      mutationId=action; writes++;
      await route.fetch();
      return route.abort("failed");
    }
    if(loseRead) return route.abort("failed");
    return route.continue();
  });
  await picker.getByRole("button",{name:"Nhận quà này",exact:true}).click();
  const retry=picker.getByRole("button",{name:"Kiểm tra lại quà trong đơn",exact:true});
  await expect(retry).toBeVisible();
  await expect(picker.getByRole("button", { name: "Nhận quà này", exact: true })).toHaveAccessibleDescription("Chưa xác nhận được kết quả lưu quà. Nàng kiểm tra lại quà trong đơn trước khi tiếp tục nhé.");
  await expect(picker.getByText("Đã thêm vào đơn", { exact: true })).toHaveCount(0);
  expect(await prisma.cartGiftSelection.count({where:{cartId}})).toBe(1);
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 0/2");
  await picker.getByRole("button",{name:"Quay lại thanh toán",exact:true}).click();
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeDisabled();
  loseRead=false;
  await retry.click();
  await expect(picker).toHaveAttribute("aria-busy","false");
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  expect(writes).toBe(1);
  await expectReceiving(page);
});

test("AC20/24/28: one gift area, responsive states and useful expanded/collapsed management", async({page}) => {
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  const picker=page.getByRole("region",{name:"Quà tặng trong giỏ"});
  for(const width of [320,375,390,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    expect(await page.locator("#cart-gifts").count()).toBe(1);
    expect(await page.locator("form form").count()).toBe(0);
    expect(await picker.locator('[data-line-role="paid"]').count()).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if(width===390 || width===1440) await page.screenshot({path:`test-results/gift-layout-${width}-unopened.png`,fullPage:true});
  }
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:900});
    await prisma.cartGiftSelection.deleteMany({where:{cartId}});
    await refreshQuote(page);
    const toggle=picker.locator("button[aria-controls]");
    if(await toggle.getAttribute("aria-expanded")==="false") await toggle.click();
    const card=picker.getByRole("button",{name:"Khăn quà",exact:true});
    if(await card.getAttribute("aria-expanded")==="false") await card.click();
    await page.screenshot({path:`test-results/gift-layout-${width}-choosing.png`,fullPage:true});
    await chooseGift(2);
    await refreshQuote(page);
    await expect(toggle).toHaveAttribute("aria-expanded","true");
    await page.screenshot({path:`test-results/gift-layout-${width}-full-open.png`,fullPage:true});
    await toggle.click();
    await expect(picker.getByRole("button",{name:/^Bỏ /})).toHaveCount(0);
    await expect(picker.locator('[data-gift-progress]')).toContainText("Đã thêm 2/2");
    const summary=page.locator('.checkout-order-summary button[aria-controls]');
    if(width===390 && await summary.getAttribute("aria-expanded")==="false") await summary.click();
    await expect(page.locator('[data-line-role="gift"]:visible')).toHaveCount(1);
    await page.screenshot({path:`test-results/gift-layout-${width}-full-collapsed.png`,fullPage:true});
    await chooseGift(1);
    await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{allowDuplicateGifts:false}});
    await refreshQuote(page);
    await expect(picker).toContainText("Hiện chưa có lựa chọn phù hợp cho 1 suất");
    await expect(picker.getByRole("button",{name:"Chọn quà ngay",exact:true})).toHaveCount(0);
    await page.screenshot({path:`test-results/gift-layout-${width}-limited.png`,fullPage:true});
    await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{isEnabled:false}});
    await refreshQuote(page);
    await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeDisabled();
    await expectReceiving(page);
    await page.screenshot({path:`test-results/gift-layout-${width}-repair.png`,fullPage:true});
    await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{isEnabled:true,allowDuplicateGifts:true}});
    await refreshQuote(page);
  }
  await page.setViewportSize({width:390,height:900});
  await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
  const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].map(el => { const r=el.getBoundingClientRect(); return {tag:el.tagName,cls:String(el.className).slice(0,180),right:Math.round(r.right),width:Math.round(r.width)}; }).filter(r=>r.width>0 && r.right>window.innerWidth+1).sort((a,b)=>b.right-a.right).slice(0,8));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),JSON.stringify(overflow)).toBe(true);
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});
  expect((await new AxeBuilder({page}).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
});

test("AC16/21: gift invalidated at submit refreshes into inline repair rather than locking the buyer out", async({page}) => {
  await startServer(3350,true);
  await chooseGift(1);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await page.keyboard.press("Escape");
  await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{isEnabled:false}});
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByText("Kiểm tra lại quà đã chọn",{exact:true})).toBeVisible();
  await expect.poll(async()=> Boolean(await page.locator('input[name="quoteProof"]').inputValue())).toBe(false);
  await expectReceiving(page);
  const picker=page.getByRole("region",{name:"Quà tặng trong giỏ"});
  await picker.getByRole("button",{name:"Kiểm tra quà đã chọn",exact:true}).click();
  await picker.getByRole("button",{name:/^Bỏ quà để chọn lại/}).click();
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeEnabled();
  await expectReceiving(page);
  expect(await prisma.orderMirror.count({where:{sourceCartId:cartId}})).toBe(0);
});

test("AC21: several invalid gift rows keep the form and proof closed until the last explicit removal", async({page}) => {
  const now=new Date();
  const other=await prisma.productMirror.create({data:{pancakeShopId:SHOP,pancakeProductId:`${PREFIX}other`,slug:`${PREFIX}other`,name:"Quà thứ hai",syncedAt:now,variants:{create:{pancakeVariationId:`${PREFIX}other`,color:"Kem",size:"S",pancakeRetailPrice:100000,pancakeRetailPriceAfterDiscount:100000,syncedAt:now,warehouseStocks:{create:{pancakeWarehouseId:"gq19-wh",quantity:10,syncedAt:now}}}}},include:{variants:true}});
  await prisma.giftOption.create({data:{campaignId,variantId:other.variants[0]!.id}});
  await chooseGift(1);
  await prisma.cartGiftSelection.create({data:{cartId,campaignId,variantId:other.variants[0]!.id,campaignRevision:1,quantity:1}});
  await startServer(3350,true);
  await page.goto(`${baseUrl}/checkout`);
  await fillReceiving(page);
  await prisma.giftQuantityCampaign.update({where:{id:campaignId},data:{isEnabled:false}});
  await refreshQuote(page);
  const picker=page.getByRole("region",{name:"Quà tặng trong giỏ"});
  await picker.getByRole("button",{name:"Kiểm tra quà đã chọn",exact:true}).click();
  const remove=picker.getByRole("button",{name:/^Bỏ quà để chọn lại/});
  await expect(remove).toHaveCount(2);
  await remove.first().click();
  await expect.poll(()=>prisma.cartGiftSelection.count({where:{cartId}})).toBe(1);
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeDisabled();
  await expectReceiving(page);
  await remove.first().click();
  await expect(page.getByRole("button",{name:"Đặt hàng COD",exact:true})).toBeEnabled();
  await expectReceiving(page);
  await expect(page.getByRole("status").filter({hasText:/Đã bỏ 1 quà/})).toBeVisible();
  expect(await prisma.cartGiftSelection.count({where:{cartId}})).toBe(0);
});

test("AC12/19: browser back while modal is open releases the modal and a return starts a new reminder visit", async({page}) => {
  await startServer(3350,true);
  await page.goto(`${baseUrl}/cart`);
  await page.getByRole("link",{name:"Tiến hành đặt hàng",exact:true}).click();
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole("link",{name:"Tiến hành đặt hàng",exact:true}).click();
  await fillReceiving(page);
  await page.getByRole("button",{name:"Đặt hàng COD",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await prisma.orderMirror.count({where:{sourceCartId:cartId}})).toBe(0);
});

test("UX-10/AC-11: the line above the button names unchosen gifts and opens the picker without counting as the reminder", async ({ page }) => {
  await startServer(3350, true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${baseUrl}/checkout`);
  const hint = page.locator("[data-checkout-gift-hint]");
  await expect(hint).toContainText("Nàng còn 2 món quà chưa chọn.");
  await hint.getByRole("button", { name: "Chọn quà", exact: true }).click();
  const picker = page.getByRole("region", { name: "Quà tặng trong giỏ" });
  await expect(picker).toBeFocused();
  await expect(picker.locator("button[aria-controls]")).toHaveAttribute("aria-expanded", "true");
  expect(await prisma.cartGiftSelection.count({ where: { cartId } })).toBe(0);
  // Information only: the one-time reminder still opens on the first valid submit -- here asked for from
  // the mobile bottom bar, which goes through the same submit pipeline as the primary button.
  await fillReceiving(page);
  await page.getByLabel("Ghi chú", { exact: false }).blur();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("[data-mobile-sticky-cta]").getByRole("button", { name: "Đặt hàng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await picker.getByRole("button", { name: "Khăn quà", exact: true }).click();
  await picker.getByRole("button", { name: "Trắng / M", exact: true }).click();
  await picker.getByRole("button", { name: "Nhận quà này", exact: true }).click();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 1/2");
  await expect(hint).toContainText("Nàng còn 1 món quà chưa chọn.");
  await picker.getByRole("button", { name: "Nhận quà này", exact: true }).click();
  await expect(picker.locator("[data-gift-progress]")).toContainText("Đã thêm 2/2");
  await expect(hint).toHaveCount(0);
  await expectReceiving(page);
  expect(await prisma.orderMirror.count({ where: { sourceCartId: cartId } })).toBe(0);
});
