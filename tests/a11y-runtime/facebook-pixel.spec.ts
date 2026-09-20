import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page, type Route } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";

/**
 * Browser tracking path with the pixel actually enabled.
 *
 * The rest of CI builds without a pixel id, so nothing else here exercises the snippet, the
 * pre-load queue, the SPA PageView tracker or the once-per-browser Purchase guard. This spec runs
 * its own server with an id configured and stands in for `fbevents.js`, which is unreachable from
 * CI and must not be contacted from a test anyway.
 */

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown; queue?: unknown[] };
    /** Recorded by the library stub below, not by anything the app ships. */
    __fbqCalls?: unknown[][];
    /** Installed by this spec only, to observe timers the page schedules. */
    __timers?: { created: Array<{ id: number; delay: number }>; cleared: number[] };
  }
}

const HOST = "127.0.0.1";
const PORT = 3222;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_022;
const PIXEL_ID = "123456789012345";
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-29T04:00:00.000Z");

const productSlug = `pixel-shirt-${runId}`;
const productName = `Pixel Test Shirt ${runId}`;
/**
 * Purchasable, priced, and unnameable: a blank mirrored name resolves to a line the cart accepts
 * but the canonical item builder must refuse. This is the split that the previous head got wrong.
 */
const namelessSlug = `pixel-nameless-${runId}`;
const NAMELESS_UNIT_PRICE = 512_000;
const orderCode = `PIXEL-${runId}`;
const UNIT_PRICE = 449_000;
const ORDER_TOTAL = 928_000;

let pixelVariantId = "";
let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js pixel test server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for pixel test server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await Promise.race([once(server, "exit"), delay(5_000)]);
  }
  server = undefined;
}

async function cleanup() {
  // I6b — reservations reference their order and variant with `onDelete: Restrict` (ADR 0014 §13),
  // deliberately: cascading them away would silently free capacity that is still counting. Now that
  // a real checkout takes a hold, a fixture that deletes orders or products has to clear the ledger
  // first, or the delete is refused.
  await prisma.variantCapacityReservation.deleteMany({});
  await prisma.orderMirror.deleteMany({ where: { publicCode: orderCode } });
  await prisma.cartItem.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP_ID } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/**
 * Stands in for `fbevents.js`. It preserves whatever the inline snippet already queued, then
 * records every later call — the same handover the real library performs, which is what the client
 * detects through `callMethod`.
 */
const PIXEL_LIBRARY_STUB = `(function(){
  var original = window.fbq;
  window.__fbqCalls = (original && original.queue) ? [].slice.call(original.queue) : [];
  var shim = function(){ window.__fbqCalls.push([].slice.call(arguments)); };
  shim.callMethod = shim; shim.loaded = true; shim.version = '2.0'; shim.queue = [];
  window.fbq = shim; window._fbq = shim;
})();`;

type PixelCall = unknown[];

/** Matches the client's poll cadence; nothing else in the app schedules one. */
const PIXEL_POLL_INTERVAL_MS = 250;

/** Records timers so a test can prove the page left none of ours running. */
async function recordTimers(page: Page) {
  await page.addInitScript(() => {
    const created: Array<{ id: number; delay: number }> = [];
    const cleared: number[] = [];
    window.__timers = { created, cleared };

    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, timeout, ...args) as unknown as number;
      created.push({ id, delay: timeout ?? 0 });
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) cleared.push(id);
      return nativeClearInterval(id);
    }) as typeof window.clearInterval;
  });
}

function readLivePixelPolls(page: Page): Promise<number[]> {
  return page.evaluate((pollDelay) => {
    const timers = window.__timers ?? { created: [], cleared: [] };
    return timers.created
      .filter((timer) => timer.delay === pollDelay && !timers.cleared.includes(timer.id))
      .map((timer) => timer.id);
  }, PIXEL_POLL_INTERVAL_MS);
}

/**
 * @param libraryDelayMs how long `fbevents.js` takes to arrive, or `null` to never serve it, which
 *   is what an ad blocker looks like from the page's point of view.
 */
async function installPixelStub(page: Page, libraryDelayMs: number | null = 0) {
  await page.route("https://connect.facebook.net/**", async (route: Route) => {
    if (libraryDelayMs === null) {
      await route.abort();
      return;
    }
    if (libraryDelayMs > 0) await delay(libraryDelayMs);
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: PIXEL_LIBRARY_STUB,
    });
  });
  // The noscript beacon and the pixel's own transport must never leave the test runner.
  await page.route("https://www.facebook.com/**", (route: Route) =>
    route.fulfill({ status: 200, body: "" }),
  );
}

function readCalls(page: Page): Promise<PixelCall[]> {
  return page.evaluate(() => (window.__fbqCalls ?? []).map((call) => Array.from(call)));
}

function trackedEventNames(calls: PixelCall[]): string[] {
  return calls.filter((call) => call[0] === "track").map((call) => String(call[1]));
}

function findEvent(calls: PixelCall[], name: string): PixelCall | undefined {
  return calls.find((call) => call[0] === "track" && call[1] === name);
}

async function waitForEvent(page: Page, name: string, timeoutMs = 15_000): Promise<PixelCall> {
  await expect
    .poll(async () => trackedEventNames(await readCalls(page)).includes(name), {
      timeout: timeoutMs,
    })
    .toBe(true);
  return findEvent(await readCalls(page), name)!;
}

test.beforeAll(async () => {
  await cleanup();

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `pixel-product-${runId}`,
      slug: productSlug,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", collectionSlugs: [] } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `pixel-variant-${runId}`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: UNIT_PRICE,
      pancakeRetailPriceAfterDiscount: UNIT_PRICE,
      syncedAt,
    },
  });
  pixelVariantId = variant.id;
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `pixel-warehouse-${runId}`,
      quantity: 5,
      syncedAt,
    },
  });

  const namelessProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `pixel-nameless-product-${runId}`,
      slug: namelessSlug,
      // Whitespace only: every commerce fact resolves, but no vendor item can be named from it.
      name: "   ",
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", collectionSlugs: [] } },
    },
  });
  const namelessVariant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `pixel-nameless-variant-${runId}`,
      productId: namelessProduct.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: NAMELESS_UNIT_PRICE,
      pancakeRetailPriceAfterDiscount: NAMELESS_UNIT_PRICE,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: namelessVariant.id,
      pancakeWarehouseId: `pixel-nameless-warehouse-${runId}`,
      quantity: 5,
      syncedAt,
    },
  });

  const order = await prisma.orderMirror.create({
    data: {
      publicCode: orderCode,
      state: "CONFIRMED",
      checkoutSnapshottedAt: syncedAt,
      guestName: "Nguyễn Văn An",
      guestPhone: "0912345678",
      provinceRef: "1",
      districtRef: "2",
      communeRef: "3",
      addressDetail: "12 Nguyễn Huệ",
      note: "",
      merchandiseSubtotalVnd: BigInt(898_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(ORDER_TOTAL),
    },
  });
  await prisma.orderLineSnapshot.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      productName,
      color: "Ink",
      size: "M",
      quantity: 2,
      unitPriceVnd: BigInt(UNIT_PRICE),
      lineTotalVnd: BigInt(898_000),
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/facebook-pixel",
      // The whole point of this spec: the rest of CI builds without one.
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: PIXEL_ID,
      // Both destinations observable on one server, so a test can prove they succeed and fail
      // independently rather than assuming it from two separately-passing specs. Publishing the
      // dataLayer still loads no container: that interlock is separate and still closed.
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-TESTONLY",
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      APP_DOMAIN: `${HOST}:${PORT}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureServerOutput);
  server.stderr?.on("data", captureServerOutput);
  await waitForServer();
});

test.afterAll(async () => {
  await stopServer();
  await cleanup();
  await prisma.$disconnect();
});

test("a configured pixel initialises once and reports the first page view", async ({ page }) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });

  await waitForEvent(page, "PageView");
  const calls = await readCalls(page);

  expect(calls.filter((call) => call[0] === "init")).toEqual([["init", PIXEL_ID]]);
  expect(trackedEventNames(calls).filter((name) => name === "PageView")).toHaveLength(1);
});

test("a client-side navigation reports its own page view without repeating the first", async ({
  page,
}) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });
  await waitForEvent(page, "PageView");

  // App Router never reloads the snippet, so without the route tracker only the entry page counts.
  // The shopping column is a disclosure at this project's 390px viewport, so open it first. The
  // retry covers a click that lands before hydration, which leaves the group closed.
  const newArrivals = page.locator("footer").getByRole("link", { name: "Hàng mới về", exact: true });
  await expect(async () => {
    await page.locator("footer").getByRole("button", { name: "Mua sắm", exact: true }).click();
    await expect(newArrivals).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await newArrivals.click();
  await page.waitForURL("**/new-arrivals");

  await expect
    .poll(async () => trackedEventNames(await readCalls(page)).filter((n) => n === "PageView").length)
    .toBe(2);
  // One navigation, one extra PageView — the initial render must not be counted twice.
  await delay(1_000);
  expect(trackedEventNames(await readCalls(page)).filter((n) => n === "PageView")).toHaveLength(2);
});

test("the product page reports ViewContent, and adding to the bag reports AddToCart", async ({
  page,
}) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });

  const viewContent = await waitForEvent(page, "ViewContent");
  expect(viewContent[2]).toMatchObject({
    content_ids: [productSlug],
    content_name: productName,
    content_type: "product",
    currency: "VND",
    value: UNIT_PRICE,
  });

  // AddToCart must follow the server confirming the line, not the click.
  expect(trackedEventNames(await readCalls(page))).not.toContain("AddToCart");
  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  const addToCart = await waitForEvent(page, "AddToCart");
  expect(addToCart[2]).toMatchObject({
    content_ids: [productSlug],
    currency: "VND",
    value: UNIT_PRICE,
  });
});

test("U18 AddToCart reports the price the server committed, once, not the rendered one", async ({
  page,
}) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();

  // The catalog moves after this page was rendered. Meta's AddToCart value used to come from the
  // price captured in the browser before the request; it now comes from the mutation's own
  // committed snapshot, so this must report the new price rather than the stale one.
  const raisedPriceVnd = UNIT_PRICE + 100_000;
  await prisma.variantMirror.update({
    where: { id: pixelVariantId },
    data: {
      pancakeRetailPrice: raisedPriceVnd,
      pancakeRetailPriceAfterDiscount: raisedPriceVnd,
    },
  });

  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  const addToCart = await waitForEvent(page, "AddToCart");
  expect(addToCart[2]).toMatchObject({
    // Content identity semantics are unchanged; only the value's source moved.
    content_ids: [productSlug],
    content_name: productName,
    content_type: "product",
    currency: "VND",
    value: raisedPriceVnd,
  });

  const addToCartCalls = trackedEventNames(await readCalls(page)).filter(
    (name) => name === "AddToCart",
  );
  expect(addToCartCalls.length, "one accepted add reports exactly one Meta event").toBe(1);

  await prisma.variantMirror.update({
    where: { id: pixelVariantId },
    data: {
      pancakeRetailPrice: UNIT_PRICE,
      pancakeRetailPriceAfterDiscount: UNIT_PRICE,
    },
  });
});

test("U18 an accepted add whose canonical item is unbuildable still reports Meta, and only Meta", async ({
  page,
  context,
}) => {
  // The regression that matters for the client branch: `reportAcceptedAdd` must decide the two
  // destinations separately. A server-side result-shape test cannot reach this — it was exactly
  // this branch that previously let the canonical item's failure silence Meta as well.
  await context.clearCookies();
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop/${namelessSlug}`, { waitUntil: "networkidle" });

  const canonicalEvents = () =>
    page.evaluate(() => {
      const layer = (window as { dataLayer?: unknown[] }).dataLayer ?? [];
      return layer
        .filter((entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && "event" in entry)
        .map((entry) => String(entry.event));
    });

  // The dataLayer is live on this server, so "no canonical event" is a real observation rather
  // than an artefact of tracking being switched off.
  expect(await canonicalEvents()).toContain("page_view");
  expect(
    await canonicalEvents(),
    "an unnameable product cannot describe a product-level view_item either",
  ).not.toContain("view_item");

  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  const addToCart = await waitForEvent(page, "AddToCart");
  expect(addToCart[2]).toMatchObject({
    content_ids: [namelessSlug],
    content_type: "product",
    currency: "VND",
    // Server-committed, and present even though no canonical item could be built from the line.
    value: NAMELESS_UNIT_PRICE,
  });
  expect(
    trackedEventNames(await readCalls(page)).filter((name) => name === "AddToCart").length,
    "one accepted add reports exactly one Meta event",
  ).toBe(1);

  expect(
    await canonicalEvents(),
    "the canonical event needs a usable item name and must stay fail-closed",
  ).not.toContain("add_to_cart");

  // Commerce succeeded regardless: the unit is really in the cart.
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  await expect(page.getByLabel("Số lượng")).toHaveValue("1");
  expect(
    await canonicalEvents(),
    "an unnameable line also takes the whole cart projection down",
  ).not.toContain("view_cart");
});

test("checkout reports InitiateCheckout with the totals the buyer is shown", async ({ page }) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  await page.getByText("Ink", { exact: true }).click();
  await page.getByText("M", { exact: true }).click();
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });

  const initiateCheckout = await waitForEvent(page, "InitiateCheckout");
  expect(initiateCheckout[2]).toMatchObject({
    content_ids: [productSlug],
    content_type: "product",
    currency: "VND",
    // Shipping included, matching the order summary rather than the merchandise subtotal.
    value: UNIT_PRICE + 30_000,
    num_items: 1,
  });
});

test("a confirmed order reports Purchase once, carrying the id that dedupes it against the server event", async ({
  page,
}) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/checkout/success?order=${orderCode}`, { waitUntil: "networkidle" });

  const purchase = await waitForEvent(page, "Purchase");
  expect(purchase[2]).toMatchObject({
    content_ids: [productSlug],
    contents: [{ id: productSlug, quantity: 2, item_price: UNIT_PRICE }],
    currency: "VND",
    value: ORDER_TOTAL,
  });
  // The Conversions API sends the same event id for this order; Meta collapses the pair.
  expect(purchase[3]).toEqual({ eventID: orderCode });
  expect(trackedEventNames(await readCalls(page)).filter((n) => n === "Purchase")).toHaveLength(1);

  // Reopening a confirmation page must not report the sale again.
  await page.reload({ waitUntil: "networkidle" });
  await waitForEvent(page, "PageView");
  await delay(1_000);
  expect(trackedEventNames(await readCalls(page))).not.toContain("Purchase");
});

test("an unknown order reports no revenue", async ({ page }) => {
  await installPixelStub(page);
  await page.goto(`${BASE_URL}/checkout/success?order=does-not-exist-${runId}`, {
    waitUntil: "networkidle",
  });

  await waitForEvent(page, "PageView");
  await delay(1_000);
  expect(trackedEventNames(await readCalls(page))).not.toContain("Purchase");
});

test("events raised before the pixel library arrives are kept and flushed in order", async ({
  page,
}) => {
  // Well past the old ten-second give-up, which used to discard conversion events outright.
  await installPixelStub(page, 12_000);
  await page.goto(`${BASE_URL}/checkout/success?order=${orderCode}`, {
    waitUntil: "domcontentloaded",
  });

  const purchase = await waitForEvent(page, "Purchase", 30_000);
  expect(purchase[3]).toEqual({ eventID: orderCode });

  // Meta's own queue preserves order, and the page's own PageView precedes the page-level event.
  const tracked = trackedEventNames(await readCalls(page));
  expect(tracked.indexOf("PageView")).toBeLessThan(tracked.indexOf("Purchase"));
});

test("a library that arrives long after the event still records the sale as reported", async ({
  page,
}) => {
  // Past any timeout the client might be tempted to put on acknowledgement. The event goes out
  // when the library finally runs, so recording it has to survive that wait too — otherwise the
  // once-per-browser guard is defeated and every later visit reports the same sale again.
  await installPixelStub(page, 18_000);
  await page.goto(`${BASE_URL}/checkout/success?order=${orderCode}`, {
    waitUntil: "domcontentloaded",
  });

  const purchase = await waitForEvent(page, "Purchase", 40_000);
  expect(purchase[3]).toEqual({ eventID: orderCode });

  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Object.keys(window.localStorage).filter((key) =>
            key.startsWith("la:fb-pixel-reported:"),
          ),
        ),
      { timeout: 15_000 },
    )
    .toEqual([`la:fb-pixel-reported:${orderCode}`]);

  // And with it recorded, reopening the page reports nothing.
  await page.reload({ waitUntil: "networkidle" });
  await waitForEvent(page, "PageView");
  await delay(1_000);
  expect(trackedEventNames(await readCalls(page))).not.toContain("Purchase");
});

test("a blocked pixel records nothing as sent, so the sale can still be reported later", async ({
  page,
}) => {
  await installPixelStub(page, null);
  await recordTimers(page);
  await page.goto(`${BASE_URL}/checkout/success?order=${orderCode}`, {
    waitUntil: "domcontentloaded",
  });
  await delay(3_000);

  const state = await page.evaluate(() => ({
    // The inline snippet still defines its stub; only the library is missing.
    hasStub: typeof window.fbq === "function",
    libraryLoaded: typeof window.fbq === "function" && typeof window.fbq.callMethod === "function",
    recordedAsSent: Object.keys(window.localStorage).filter((key) =>
      key.startsWith("la:fb-pixel-reported:"),
    ),
  }));

  expect(state.hasStub).toBe(true);
  expect(state.libraryLoaded).toBe(false);
  // Recording a suppression flag here would lose the sale for good.
  expect(state.recordedAsSent).toEqual([]);

  // The event itself is already in the pixel's own queue, so nothing here needs to keep waiting on
  // a library that is never coming. Polling on for the life of the page would be the cost.
  await expect
    .poll(async () => (await readLivePixelPolls(page)).length, { timeout: 30_000 })
    .toBe(0);
});
