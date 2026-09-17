import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch";

const HOST = "127.0.0.1";
const PORT = 3214;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const PANCAKE_FETCH_FIXTURE = resolve(import.meta.dirname, "pancake-fetch-fixture.cjs");
const SHOP_ID = 920_007;
const TRUSTED_CLIENT_IP = "203.0.113.44";
const TEST_API_KEY = "checkout-a11y-test-key";
const PROVINCE_LEGACY = "province-legacy";
const PROVINCE_CURRENT = "province-current";
const DISTRICT_LEGACY = "district-legacy";
const DISTRICT_SLOW = "district-slow";
const DISTRICT_CURRENT = "district-current";
const COMMUNE_LEGACY = "commune-legacy";
const COMMUNE_STALE = "commune-stale";
const COMMUNE_CURRENT = "commune-current";

const runId = `${Date.now()}-${process.pid}`;
const productExternalId = `checkout-a11y-product-${runId}`;
const variationExternalId = `checkout-a11y-variation-${runId}`;
const warehouseExternalId = `checkout-a11y-warehouse-${runId}`;
const productSlug = `checkout-a11y-product-${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";
let cartId = "";
let testVariantId = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js checkout a11y server exited with ${server.exitCode}\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for Next.js checkout a11y server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    once(server, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  if (!(await waitForServerExit(5_000))) {
    server.kill("SIGKILL");
    await waitForServerExit(5_000);
  }
  server = undefined;
}

async function startServer({
  apiKey,
  mockPancake,
}: {
  apiKey: string;
  mockPancake: boolean;
}) {
  await stopServer();
  serverOutput = "";
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    mockPancake ? `--require=${PANCAKE_FETCH_FIXTURE}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: nodeOptions,
      PANCAKE_API_KEY: apiKey,
      PANCAKE_SHOP_ID: String(SHOP_ID),
      PANCAKE_A11Y_PRODUCT_ID: productExternalId,
      PANCAKE_A11Y_VARIATION_ID: variationExternalId,
      PANCAKE_A11Y_WAREHOUSE_ID: warehouseExternalId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
}

async function cleanupRateLimits() {
  await prisma.rateLimit.deleteMany({});
}

async function cleanupDatabase() {
  await prisma.orderLineSnapshot.deleteMany({}).catch(() => {});
  await prisma.orderMirror.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.productMirror.deleteMany({
    where: { pancakeProductId: productExternalId },
  });
  await cleanupRateLimits();
}

async function createTestCart(): Promise<string> {
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(Date.now() + 10 * 60_000),
      items: {
        create: {
          variantId: testVariantId,
          quantity: 1,
        },
      },
    },
  });
  cartId = cart.id;
  return cart.id;
}

async function prepareBrowser(context: BrowserContext) {
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": TRUSTED_CLIENT_IP });
  await context.addCookies([{ name: "la_cart", value: cartId, url: BASE_URL }]);
}

/**
 * Instrument the page before it navigates: the console and response listeners, and the document
 * title watch `assertCheckoutAccessibility` reads. The watch has to be installed before the first
 * navigation, so it belongs here rather than at the point the scan wants an answer.
 */
async function captureBrowserFailures(page: Page) {
  await watchDocumentTitle(page);

  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      browserErrors.push(`console: ${message.text()} @ ${location.url || "unknown"}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  return { browserErrors, failedResponses };
}

async function assertCheckoutAccessibility(page: Page) {
  // A checkout scan can follow a Server Action, whose revalidation re-streams the dynamic head and
  // leaves the document briefly untitled. Waiting for the title to have been continuously present
  // is the guard; asserting it is present once is not, because the swap happens after that passes.
  await expectSettledDocumentTitle(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  const accessibilityScan = await new AxeBuilder({ page })
    .withTags(BUYER_AXE_TAGS)
    .analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

async function waitForConfirmedOrder() {
  let observed: {
    state: string;
    syncErrorCode: string | null;
    pancakeOrderId: string | null;
  } | null = null;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    observed = await prisma.orderMirror.findFirst({
      where: { sourceCartId: cartId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { state: true, syncErrorCode: true, pancakeOrderId: true },
    });
    if (observed?.state === "CONFIRMED") return;
    if (observed && ["DRAFT", "REJECTED", "SYNC_UNKNOWN"].includes(observed.state)) break;
    await delay(100);
  }

  throw new Error(
    `Checkout did not reach CONFIRMED. Observed order: ${JSON.stringify(observed)}\nServer output:\n${serverOutput}`,
  );
}

test.beforeAll(async () => {
  await cleanupDatabase();
  const syncedAt = new Date();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug: productSlug,
      name: "Checkout A11y Product",
      isPresent: true,
      isActive: true,
      syncedAt,
      variants: {
        create: {
          pancakeVariationId: variationExternalId,
          pancakeRetailPrice: 500_000,
          pancakeRetailPriceAfterDiscount: 500_000,
          color: "Đen",
          size: "M",
          isPresent: true,
          isActive: true,
          syncedAt,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: warehouseExternalId,
              quantity: 5,
              syncedAt,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  const variantId = product.variants[0]?.id;
  expect(variantId).toBeTruthy();
  testVariantId = variantId!;

  await createTestCart();
});

test.afterEach(async () => {
  await stopServer();
  await cleanupRateLimits();
  if (cartId) {
    await prisma.orderLineSnapshot.deleteMany({
      where: { order: { sourceCartId: cartId } },
    }).catch(() => {});
    await prisma.orderMirror.deleteMany({ where: { sourceCartId: cartId } });
    await prisma.cartItem.deleteMany({ where: { cartId } });
    await prisma.cart.deleteMany({ where: { id: cartId } });
  }
});

test.afterAll(async () => {
  await stopServer();
  await cleanupDatabase();
  await prisma.$disconnect();
});

test("trusted checkout geo read reaches the limiter before an empty Pancake key fails safely", async ({
  page,
  context,
}) => {
  await startServer({ apiKey: "", mockPancake: false });
  await createTestCart();
  await prepareBrowser(context);
  const { browserErrors, failedResponses } = await captureBrowserFailures(page);

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Giao hàng COD" })).toBeVisible();
  await expect(page.getByLabel("Tỉnh / Thành phố")).toBeVisible();

  const geoStatus = page.getByRole("status").filter({
    hasText: "Chưa tải được danh sách tỉnh/thành. Vui lòng thử lại.",
  });
  await expect(geoStatus).toBeVisible();
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đặt hàng COD" })).toBeDisabled();

  expect(
    await prisma.rateLimit.count({
      where: { id: { startsWith: "checkout-geo-client:" } },
    }),
  ).toBe(1);

  await assertCheckoutAccessibility(page);
  expect(
    browserErrors,
    `browser console errors; failed responses: ${JSON.stringify(failedResponses)}`,
  ).toEqual([]);
  expect(failedResponses).toEqual([]);
});

for (const { name, viewport } of [
  { name: "mobile (390px)", viewport: { width: 390, height: 844 } },
  { name: "desktop (1440px)", viewport: { width: 1440, height: 900 } },
]) {
  test(`guest checkout (${name}) cascades geo, submits confirmed COD order, and tracks order`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await cleanupRateLimits();
    await startServer({ apiKey: TEST_API_KEY, mockPancake: true });
    await createTestCart();
    await prepareBrowser(context);
    const { browserErrors, failedResponses } = await captureBrowserFailures(page);

    await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });

    const province = page.getByLabel("Tỉnh / Thành phố");
    const district = page.getByLabel("Quận / Huyện");
    const commune = page.getByLabel("Phường / Xã");
    const submit = page.getByRole("button", { name: "Đặt hàng COD" });

    await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Giao hàng COD" })).toBeVisible();
    await expect(
      page.getByText("Danh sách tỉnh/thành gồm cả dữ liệu địa giới cũ và mới từ Pancake."),
    ).toBeVisible();
    await expect(province.locator(`option[value="${PROVINCE_LEGACY}"]`)).toHaveText("Tỉnh Legacy");
    await expect(province.locator(`option[value="${PROVINCE_CURRENT}"]`)).toHaveText("Tỉnh Current");

    await province.selectOption(PROVINCE_LEGACY);
    await expect(district.locator(`option[value="${DISTRICT_LEGACY}"]`)).toHaveText("Huyện Legacy");
    await district.selectOption(DISTRICT_LEGACY);
    await expect(commune.locator(`option[value="${COMMUNE_LEGACY}"]`)).toHaveText("Xã Legacy");
    await commune.selectOption(COMMUNE_LEGACY);

    await province.selectOption(PROVINCE_CURRENT);
    await expect(district).toHaveValue("");
    await expect(commune).toHaveValue("");
    await expect(commune).toBeDisabled();
    await expect(district.locator(`option[value="${DISTRICT_SLOW}"]`)).toHaveText("Quận Chậm");
    await expect(district.locator(`option[value="${DISTRICT_CURRENT}"]`)).toHaveText("Quận Current");

    await district.selectOption(DISTRICT_SLOW);
    await district.selectOption(DISTRICT_CURRENT);
    await expect(commune.locator(`option[value="${COMMUNE_CURRENT}"]`)).toHaveText("Phường Current");
    await page.waitForTimeout(350);
    await expect(commune.locator(`option[value="${COMMUNE_STALE}"]`)).toHaveCount(0);
    await commune.selectOption(COMMUNE_CURRENT);

    await page.getByLabel("Họ và tên").fill("Nguyễn Văn A");
    await page.getByLabel("Số điện thoại").fill("0901234567");
    await page.getByLabel("Số nhà, tên đường").fill("12 Đường A");
    await expect(submit).toBeEnabled();

    await assertCheckoutAccessibility(page);

    await submit.click();
    await page.waitForURL((url) => {
      return url.pathname === "/checkout/success" && Boolean(url.searchParams.get("order"));
    });
    await waitForConfirmedOrder();

    await expect(page.getByRole("heading", { level: 1, name: "ĐẶT HÀNG THÀNH CÔNG" })).toBeVisible();
    const successStatus = page.getByRole("status").filter({ hasText: "Cảm ơn bạn đã đặt hàng." });
    await expect(successStatus).toContainText("Mã đơn LA-");
    expect((await context.cookies(BASE_URL)).some(({ name }) => name === "la_cart")).toBe(false);

    const confirmed = await prisma.orderMirror.findFirstOrThrow({
      where: { sourceCartId: cartId, state: "CONFIRMED" },
      select: {
        publicCode: true,
        pancakeOrderId: true,
        provinceRef: true,
        districtRef: true,
        communeRef: true,
        guestName: true,
        guestPhone: true,
        addressDetail: true,
      },
    });
    expect(confirmed.pancakeOrderId).toMatch(/^\d+$/);
    expect(confirmed.provinceRef).toBe(PROVINCE_CURRENT);
    expect(confirmed.districtRef).toBe(DISTRICT_CURRENT);
    expect(confirmed.communeRef).toBe(COMMUNE_CURRENT);
    expect(confirmed.guestName).toBe("Nguyễn Văn A");
    expect(confirmed.guestPhone).toBe("0901234567");
    expect(confirmed.addressDetail).toBe("12 Đường A");
    expect(confirmed.publicCode).toMatch(/^LA-/);

    await assertCheckoutAccessibility(page);

    // Follow through to order tracking using the confirmed order code
    const trackOrderLink = page.getByRole("link", { name: "Tra cứu đơn hàng" });
    await expect(trackOrderLink).toBeVisible();
    await trackOrderLink.click();
    await expect(page).toHaveURL(`${BASE_URL}/track-order`);
    await expect(page.getByRole("heading", { level: 1, name: "TRA CỨU ĐƠN HÀNG" })).toBeVisible();
    await assertCheckoutAccessibility(page);

    await page.getByLabel("Mã đơn hàng").fill(confirmed.publicCode);
    await page.getByLabel("Số điện thoại").fill("0901234567");
    await page.getByRole("button", { name: "Tra cứu đơn hàng" }).click();

    const trackingStatus = page.locator('[data-ui-state="success"]');
    await expect(trackingStatus).toBeVisible();
    await expect(trackingStatus.getByText(confirmed.publicCode)).toBeVisible();
    await expect(trackingStatus.getByText(/500\.000.*₫|530\.000.*₫/)).toBeVisible();
    await assertCheckoutAccessibility(page);

    expect(
      browserErrors,
      `browser console errors; failed responses: ${JSON.stringify(failedResponses)}`,
    ).toEqual([]);
    expect(failedResponses).toEqual([]);
  });
}

test("empty bag and empty checkout states render accessible empty UI and breadcrumb links", async ({
  page,
  context,
}) => {
  await startServer({ apiKey: TEST_API_KEY, mockPancake: true });
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": TRUSTED_CLIENT_IP });
  const { browserErrors, failedResponses } = await captureBrowserFailures(page);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "GIỎ HÀNG" })).toBeVisible();
  await expect(page.locator('[data-ui-state="empty"]')).toBeVisible();
  await expect(page.getByText("Giỏ hàng của bạn đang trống.")).toBeVisible();
  await assertCheckoutAccessibility(page);

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "THANH TOÁN" })).toBeVisible();
  await expect(page.locator('[data-ui-state="empty"]')).toBeVisible();
  await expect(page.getByText("Giỏ hàng của bạn đang trống.")).toBeVisible();
  await assertCheckoutAccessibility(page);

  expect(browserErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test("P9a a price change between render and submit forces an explicit second confirmation", async ({
  page,
  context,
}) => {
  await cleanupRateLimits();
  await startServer({ apiKey: TEST_API_KEY, mockPancake: true });
  await createTestCart();
  await prepareBrowser(context);

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });

  const submit = page.getByRole("button", { name: "Đặt hàng COD" });
  const totalValue = page.locator("dl > div").filter({ hasText: "Tổng dự kiến" }).locator("dd");
  const quotedTotal = (await totalValue.textContent())?.trim() ?? "";
  expect(quotedTotal).not.toEqual("");

  await page.getByLabel("Tỉnh / Thành phố").selectOption(PROVINCE_CURRENT);
  await page.getByLabel("Quận / Huyện").selectOption(DISTRICT_CURRENT);
  await page.getByLabel("Phường / Xã").selectOption(COMMUNE_CURRENT);
  await page.getByLabel("Họ và tên").fill("Nguyễn Văn A");
  await page.getByLabel("Số điện thoại").fill("0901234567");
  await page.getByLabel("Số nhà, tên đường").fill("12 Đường A");
  await expect(submit).toBeEnabled();
  const proofBefore = await page.locator('input[name="quoteProof"]').inputValue();

  // The price moves behind the buyer's back, after the page — and its proof — were rendered.
  await prisma.variantMirror.update({
    where: { id: testVariantId },
    data: { pancakeRetailPrice: 700_000, pancakeRetailPriceAfterDiscount: 700_000 },
  });

  await submit.click();

  await expect(page.getByRole("status")).toContainText("Giá đã thay đổi");
  expect(
    await prisma.orderMirror.count({ where: { sourceCartId: cartId } }),
    "a quote the buyer has not acknowledged must create no order at all",
  ).toBe(0);

  // The ordering is the point: the summary must be showing the new money before the buyer is able
  // to confirm it. The proof this form carries binds line identities and quantities as well as the
  // total, so re-enabling submit against the old render would let a fast second click confirm a
  // basket that was never displayed.
  await expect(totalValue).not.toHaveText(quotedTotal);
  await expect(submit).toBeEnabled();

  // The proof the form now carries is the refreshed render's, over the money on screen — not the
  // one the buyer was originally shown. That rotation is what makes the next confirmation an
  // acknowledgement of the new price rather than of the old one.
  const proofAfter = await page.locator('input[name="quoteProof"]').inputValue();
  expect(proofAfter).not.toEqual(proofBefore);
  expect(Buffer.from(proofAfter.split(".")[0] ?? "", "base64url").toString("utf8")).toContain(
    "700000",
  );

  // Deliberately not asserted here: that the second confirmation reaches CONFIRMED. This fixture's
  // Pancake catalog is pinned to the old 500.000 and refuses a create-order at any other price, so
  // that leg would be exercising P9b/P10's reconciliation against a fresher Pancake base rather
  // than P9a's question of whether the buyer acknowledged the website's price. That the acknowledged
  // proof is accepted and the acknowledged price persisted is covered against the real snapshot
  // transaction in tests/database/guest-checkout-p9a-quote-proof.test.ts.
});
