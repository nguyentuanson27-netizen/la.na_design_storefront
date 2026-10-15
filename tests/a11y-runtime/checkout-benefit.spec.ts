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

test("verified shop: gift lines at 0đ, unclaimed slots stated, the acknowledgement starts unticked and is required", async ({ page }) => {
  await startServer(3350, true);
  await chooseGift(1);

  await page.goto(`${baseUrl}/cart`);
  await expect(page.getByRole("link", { name: "Tiến hành đặt hàng" })).toBeVisible();
  await page.getByRole("link", { name: "Tiến hành đặt hàng" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  const benefits = page.getByRole("region", { name: "Quà tặng và ưu đãi" });
  await expect(benefits).toContainText("hưởng 2 suất quà, đã chọn 1, chưa nhận 1");

  // The summary: one paid line, the gift at 0đ; the gift is not in the subtotal.
  const summary = page.locator("aside.checkout-order-panel");
  if (await summary.isVisible()) {
    await expect(summary.locator('[data-line-role="gift"]')).toContainText("Khăn quà");
    await expect(summary.locator('[data-line-role="gift"]')).toContainText("0");
    await expect(summary).toContainText("200.000");
    await expect(summary).toContainText("Quà tặng (1)");
  } else {
    await page.getByRole("button", { name: /Đơn hàng \(3\)/ }).click();
    await expect(page.locator('[data-line-role="gift"]').first()).toContainText("Khăn quà");
  }

  const box = benefits.getByRole("checkbox", { name: /không nhận 1 suất quà/ });
  await expect(box).not.toBeChecked();

  // Placing the order without the tick is refused in the page, with the reason next to the box.
  await page.getByRole("button", { name: "Đặt hàng COD" }).click();
  await expect(benefits.getByText("Hãy tích xác nhận không nhận đủ quà tặng")).toBeVisible();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await box.check();
  await expect(box).toBeChecked();
  await expect(box).not.toHaveAttribute("aria-invalid", "true");

  // Keyboard: Space toggles it back off, and the box is reachable in tab order.
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).not.toBeChecked();

  expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/gq19-checkout-mobile.png", fullPage: true });
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
  await expect(page.getByRole("button", { name: "Đặt hàng COD" })).toHaveCount(0);
  await expect(page.getByText(/hiện chưa thể đặt trực tuyến/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Quay lại giỏ hàng/ })).toBeVisible();
});
