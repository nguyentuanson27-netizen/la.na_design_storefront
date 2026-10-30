import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

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
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), NEXT_SERVER_COMMAND, "--hostname", "127.0.0.1", "--port", "3390"], {
    cwd: ROOT, env: { ...process.env, ...nextServerEnv(".next-test/promotion-upsell"), PANCAKE_SHOP_ID: String(SHOP), PANCAKE_API_KEY: "checkout-a11y-test-key", NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${resolve(import.meta.dirname, "pancake-fetch-fixture.cjs")}`].filter(Boolean).join(" "), LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PROMOTION_UPSELL_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP), APP_DOMAIN: "127.0.0.1:3390", SEARCH_INDEXING_ENABLED: "false", BETTER_AUTH_URL: BASE, BETTER_AUTH_IP_HEADER: "x-ci-client-ip", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
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
test("slow optional upsell cannot hold checkout HTML, shipping fields or the submit button", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let intercepted = 0;
  await page.route("**/api/checkout/upsell", async (route) => {
    intercepted++;
    await held;
    await route.continue();
  });
  try {
    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Thông tin nhận hàng" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
    await expect.poll(() => intercepted).toBe(1);
    await expect(page.getByRole("region", { name: "Gợi ý mua thêm" })).toHaveCount(0);
    release();
    await expect(page.getByRole("region", { name: "Gợi ý mua thêm" })).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("province fetch failure does not start optional upsell", async ({ page }) => {
  let started = 0;
  await page.route("**/api/checkout/upsell", async (route) => { started++; await route.continue(); });
  await page.route(BASE + "/checkout", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto(BASE + "/checkout", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
  await expect(page.locator("#checkout-province")).toBeDisabled();
  await page.waitForTimeout(150);
  expect(started).toBe(0);
});

test("upsell POST rejects requests from a foreign origin without exposing data", async ({ page }) => {
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  const response = await page.request.post(`${BASE}/api/checkout/upsell`, {
    data: { quoteProof: "invalid.proof" },
    headers: { origin: "https://foreign.example" },
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toBeNull();
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("AM-01/A: the compact banner names the proven offer, links to verified eligible products and offers no inline add", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer, output).toBeVisible();
  await expect(offer.getByRole("heading", { name: "Thêm 1 món để nhận ưu đãi" })).toBeVisible();
  await expect(offer).toContainText("Mua 3 tặng khăn");
  await expect(offer.getByRole("combobox")).toHaveCount(0);
  await expect(offer.getByRole("button", { name: "Thêm 1 chiếc" })).toHaveCount(0);
  await expect(offer.getByRole("link", { name: "Chọn thêm món" })).toHaveAttribute("href", `/offers/eligible?campaign=${encodeURIComponent(campaignId)}`);
  // UX-08: the offer never locks submit.
  await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
  expect(await page.locator("form").count()).toBe(1);
  // Scan the settled page: the province list loads after hydration, and the field's colour transition
  // from its loading (disabled) look must finish before contrast is measured.
  await expect(page.getByLabel("Tỉnh / Thành phố", { exact: false })).toBeEnabled();
  await page.waitForFunction(() => document.getElementById("checkout-province")?.getAnimations().length === 0);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The campaign title and action must occupy separate rows, not overlap at narrow widths.
    const nameRect = await offer.getByText("Mua 3 tặng khăn", { exact: true }).boundingBox();
    const actionRect = await offer.getByRole("link", { name: "Chọn thêm món" }).boundingBox();
    expect(nameRect).not.toBeNull();
    expect(actionRect).not.toBeNull();
    expect(actionRect!.y).toBeGreaterThanOrEqual(nameRect!.y + nameRect!.height);
    expect((await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze()).violations).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/upsell-checkout-banner.png", fullPage: true });
  // Current decision: the link goes to the eligible-product browse route, without a leave warning, even when
  // receiving details were typed. Nothing typed is written to storage on the way.
  await page.getByLabel("Họ và tên", { exact: false }).fill("Nàng La.na");
  await page.getByLabel("Số điện thoại", { exact: false }).fill("0901234567");
  await offer.getByRole("link", { name: "Chọn thêm món" }).click();
  await expect(page).toHaveURL(`${BASE}/offers/eligible?campaign=${encodeURIComponent(campaignId)}`);
  await expect(page.getByRole("heading", { name: "Sản phẩm áp dụng ưu đãi" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Áo candidate/ })).toBeVisible();
  await expect(page.getByText("Áo paid")).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("0901234567");
  expect(stored).not.toContain("Nàng La.na");
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("GET without a cart cookie never consumes the shared POST upsell budget", async ({ page, context }) => {
  await context.clearCookies();
  const url = `${BASE}/offers/eligible?campaign=${encodeURIComponent(campaignId)}`;
  const headers = { "x-ci-client-ip": "203.0.113.222", "sec-fetch-site": "same-origin" };
  for (let i = 0; i < 25; i++) {
    const response = await page.request.get(url, { headers });
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toContain("Áo candidate");
  }
  const post = await page.request.post(`${BASE}/api/checkout/upsell`, {
    headers: { ...headers, origin: BASE },
    data: { quoteProof: "abc.def" },
  });
  expect(post.status()).toBe(200);
});

test("forged but well-formed cart UUIDs use a separate bounded GET budget, never the POST bucket", async ({ page, context }) => {
  await context.clearCookies();
  await context.addCookies([{ name: "la_cart", value: "11111111-1111-4111-8111-111111111111", url: BASE, httpOnly: true, sameSite: "Lax" }]);
  const url = `${BASE}/offers/eligible?campaign=${encodeURIComponent(campaignId)}`;
  const headers = { "x-ci-client-ip": "203.0.113.223", "sec-fetch-site": "same-origin" };
  for (let i = 0; i < 10; i++) {
    const response = await page.request.get(url, { headers });
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toContain("Gợi ý ưu đãi đang có quá nhiều lượt truy cập");
  }
  const excess = await page.request.get(url, { headers });
  expect(await excess.text()).toContain("Gợi ý ưu đãi đang có quá nhiều lượt truy cập");
  const post = await page.request.post(`${BASE}/api/checkout/upsell`, {
    headers: { ...headers, origin: BASE },
    data: { quoteProof: "abc.def" },
  });
  expect(post.status()).toBe(200);
});

test("cart-backed GETs are bounded separately and retain a shared POST quote budget", async ({ page }) => {
  const url = `${BASE}/offers/eligible?campaign=${encodeURIComponent(campaignId)}`;
  const headers = { "x-ci-client-ip": "203.0.113.224", "sec-fetch-site": "same-origin" };
  for (let i = 0; i < 10; i++) {
    const response = await page.request.get(url, { headers });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Áo candidate");
  }
  const excess = await page.request.get(url, { headers });
  expect(await excess.text()).toContain("Gợi ý ưu đãi đang có quá nhiều lượt truy cập");
  const post = await page.request.post(`${BASE}/api/checkout/upsell`, {
    headers: { ...headers, origin: BASE },
    data: { quoteProof: "abc.def" },
  });
  expect(post.status()).toBe(200, "GET browse cannot consume every POST banner slot on a shared IP");
});

test("cross-site or speculative GET cannot reveal cart offers or touch the POST budget", async ({ page }) => {
  const url = `${BASE}/offers/eligible?campaign=${encodeURIComponent(campaignId)}`;
  const headers = {
    "x-ci-client-ip": "203.0.113.225",
    "sec-fetch-site": "cross-site",
    referer: "https://foreign.example/offers",
  };
  const response = await page.request.get(url, { headers });
  expect(await response.text()).not.toContain("Áo candidate");
  const speculative = await page.request.get(url, {
    headers: { "x-ci-client-ip": "203.0.113.225", "sec-fetch-site": "same-origin", purpose: "prefetch" },
  });
  expect(await speculative.text()).not.toContain("Áo candidate");
  const post = await page.request.post(`${BASE}/api/checkout/upsell`, {
    headers: { "x-ci-client-ip": "203.0.113.225", origin: BASE, "sec-fetch-site": "same-origin" },
    data: { quoteProof: "abc.def" },
  });
  expect(post.status()).toBe(200);
});

test("Review P2-2: while an order is being placed the banner link cannot take the buyer away", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer, output).toBeVisible();
  await page.getByLabel("Họ và tên", { exact: false }).fill("Nàng La.na");
  await page.getByLabel("Số điện thoại", { exact: false }).fill("0901234567");
  await page.getByLabel("Tỉnh / Thành phố", { exact: false }).selectOption({ label: "Tỉnh Current" });
  await page.getByLabel("Phường / Xã", { exact: false }).selectOption({ label: "Phường Current" });
  await page.getByLabel("Số nhà, tên đường", { exact: false }).fill("12 Nguyễn Trãi");

  // Hold the order submission in flight; it never reaches the server, so no order is created.
  let held = false;
  await page.route(`${BASE}/checkout`, async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) { held = true; return; }
    await route.continue();
  });
  const submit = page.locator("#checkout-submit");
  await expect(submit).toHaveText("Đặt hàng COD");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => held).toBe(true);
  await expect(submit).toHaveText("Đang đặt hàng…");
  await expect(submit).toBeDisabled();
  await expect(offer.getByRole("link", { name: "Chọn thêm món" })).toHaveCount(0);
  const locked = offer.locator("[data-upsell-link-locked]");
  await expect(locked).toHaveAttribute("aria-disabled", "true");
  await locked.click();
  await expect(page).toHaveURL(`${BASE}/checkout`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
test("TG-11: skip survives reload, paid A→B→A resets it, new checkout attempt resets it", async ({ page, context }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("heading", { name: "Thông tin nhận hàng" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 1 } });
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 2 } });
  await page.reload(); await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  // Checkout has no breadcrumb now: leave through the header cart, then come back from the cart page.
  await page.getByRole("button", { name: /^Giỏ hàng/ }).click();
  await page.getByRole("dialog", { name: "Giỏ hàng" }).getByRole("link", { name: "Xem chi tiết giỏ hàng" }).click();
  await page.waitForURL((url) => url.pathname === "/cart");
  await page.getByRole("link", { name: "Tiến hành đặt hàng" }).click();
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  const newCart = await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } });
  await context.addCookies([{ name: "la_cart", value: newCart.id, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  await page.reload(); await expect(offer).toBeVisible();
});
test("D-06/FR-10: commune lookup failure and retry preserve a dismissed upsell", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await expect(page.getByLabel("Tỉnh / Thành phố", { exact: false })).toBeEnabled();

  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  await expect(offer).toHaveCount(0);
  const savedDismiss = await page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"));
  expect(savedDismiss).toBeTruthy();
  expect(JSON.parse(savedDismiss!).dismissed).toBe(true);

  // Provinces already loaded. Fail just the first commune Server Action request.
  let failNextCommuneRead = true;
  await page.route(`${BASE}/checkout`, async (route) => {
    if (failNextCommuneRead && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      failNextCommuneRead = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Tỉnh / Thành phố", { exact: false }).selectOption({ label: "Tỉnh Current" });
  await expect.poll(() => failNextCommuneRead).toBe(false);
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"))).toBe(savedDismiss);

  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByLabel("Phường / Xã", { exact: false })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Thử lại" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"))).toBe(savedDismiss);
  await expect(offer).toHaveCount(0);
});

test("D-06/FR-10: a temporarily unquotable cart preserves the dismissed offer", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  const proof = page.locator('input[name="quoteProof"]');
  await expect(offer).toBeVisible();
  const originalProof = await proof.inputValue();
  expect(originalProof).not.toBe("");
  await offer.getByRole("button", { name: "Đóng gợi ý ưu đãi" }).click();
  await expect(offer).toHaveCount(0);
  const dismissed = await page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"));
  expect(JSON.parse(dismissed ?? "null")).toEqual(expect.objectContaining({ dismissed: true }));

  // The checkout page's visibilitychange refresh uses client RSC navigation (not a document reload),
  // which is the path that previously unmounted the banner and erased its session storage.
  async function refreshRender() {
    const before = await page.locator("form").getAttribute("data-checkout-render");
    const rsc = page.waitForResponse((response) =>
      response.url().includes("/checkout?") && response.request().headers()["rsc"] === "1");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await rsc;
    await expect.poll(() => page.locator("form").getAttribute("data-checkout-render")).not.toBe(before);
  }

  // Stock is external quote input; changing/restoring it must not bump the paid-cart revision.
  await prisma.warehouseStock.updateMany({ where: { variantId: paidId }, data: { quantity: 0 } });
  try {
    await refreshRender();
    await expect(proof).toHaveValue("");
    await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeDisabled();
    await expect(offer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"))).toBe(dismissed);
  } finally {
    await prisma.warehouseStock.updateMany({ where: { variantId: paidId }, data: { quantity: 20 } });
  }

  const recommender = page.waitForResponse((response) =>
    response.url().endsWith("/api/checkout/upsell") && response.request().method() === "POST");
  await refreshRender();
  await expect(proof).not.toHaveValue("");
  await recommender;
  await expect(offer).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("la-checkout-upsell-attempt-v1"))).toBe(dismissed);
  expect(await prisma.cartItem.count({ where: { cartId } })).toBe(1);
});

test("D-06: a withdrawn offer shows no invitation and leaves checkout usable", async ({ page }) => {
  await page.goto(`${BASE}/checkout`);
  const offer = page.getByRole("region", { name: "Gợi ý mua thêm" });
  await expect(offer).toBeVisible();
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: { increment: 1 } } });
  await page.goto(`${BASE}/cart`);
  await page.goto(`${BASE}/checkout`);
  await expect(page.getByRole("heading", { name: "Thông tin nhận hàng" })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đặt hàng COD", exact: true })).toBeEnabled();
});
