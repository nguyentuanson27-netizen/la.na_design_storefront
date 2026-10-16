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
const campaignId = `${PREFIX}gift`;

let server: ChildProcess | undefined;
let output = "";
let baseUrl = "";
let cartId = "";
let giftVariantId = "";

async function cleanup() {
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
      NEXT_DIST_DIR: `.next-test/gq19-${port}`,
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
  const response = page.waitForResponse((r) => r.url().includes("/checkout?") && r.request().headers()["rsc"] === "1");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await response;
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
    const order = await prisma.orderMirror.findFirstOrThrow({orderBy:{createdAt:"desc"},include:{quoteSnapshot:{include:{lines:true,entitlements:true}}}});
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
  const order=await prisma.orderMirror.findFirstOrThrow({orderBy:{createdAt:"desc"},include:{quoteSnapshot:true}});
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
  expect(await prisma.orderMirror.count()).toBe(1);
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
  await expect(proof).not.toHaveValue(old);
  await expectReceiving(page);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await prisma.orderMirror.count()).toBe(0);
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
