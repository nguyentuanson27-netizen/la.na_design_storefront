/**
 * U18 / U19 — the canonical commerce events as a shopper actually produces them.
 *
 * Everything here is asserted from the real `window.dataLayer` of a real browser driving the real
 * storefront: the list grid, the product page, the add button, the cart editor and checkout. That
 * is the point of doing it at this level. A unit test can prove a builder refuses a fabricated
 * price; only the running application can prove that the price which reaches the dataLayer is the
 * one the server committed rather than the one the page happened to be rendering.
 *
 * The stale-price case is the sharpest of these. The page is rendered, the catalog price is then
 * changed underneath it, and the shopper clicks add. The reported value must be the new price.
 *
 * `LA_TRACKING_MODE=preview` publishes the dataLayer without loading any container — that interlock
 * is asserted here too, because these events must not become the reason a GTM script appears.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3221;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_014;
const runId = `${Date.now()}-${process.pid}`;

const shirt = {
  externalId: `events-shirt-${runId}`,
  slug: `events-shirt-${runId}`,
  name: `Events Oxford Shirt ${runId}`,
  variationM: `events-shirt-m-${runId}`,
  variationL: `events-shirt-l-${runId}`,
  priceVnd: 500_000,
};
const coat = {
  externalId: `events-coat-${runId}`,
  slug: `events-coat-${runId}`,
  name: `Events Wool Coat ${runId}`,
  variation: `events-coat-m-${runId}`,
  priceVnd: 1_200_000,
};
const syncedAt = new Date("2026-09-22T00:00:00.000Z");

let server: ChildProcess | undefined;
let serverOutput = "";
let shirtVariantMId = "";
let coatVariantId = "";

type DataLayerEntry = Record<string, unknown>;

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Commerce events server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${shirt.slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(shirt.name)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for commerce events server\n${serverOutput}`);
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
  if (!exited) server.kill("SIGKILL");
  server = undefined;
}

async function cleanup() {
  await prisma.cartItem.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP_ID } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function seedVariant(
  productId: string,
  { pancakeVariationId, size, priceVnd, stock }: {
    pancakeVariationId: string;
    size: string;
    priceVnd: number;
    stock: number;
  },
) {
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId,
      productId,
      color: "Black",
      size,
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: priceVnd,
      pancakeRetailPriceAfterDiscount: priceVnd,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${pancakeVariationId}-wh`,
      quantity: stock,
      syncedAt,
    },
  });
  return variant;
}

/**
 * Picks a purchase option the way a shopper does.
 *
 * The radio input itself is `sr-only`; the visible control is its label span, so the click goes
 * there and the assertion confirms the underlying input actually took the selection.
 */
async function selectOption(page: Page, label: string) {
  await page.getByText(label, { exact: true }).click();
  await expect(page.getByRole("radio", { name: label })).toBeChecked();
}

/** Every entry the page pushed, in order. Reset entries are dropped; ordering is preserved. */
async function readDataLayer(page: Page): Promise<DataLayerEntry[]> {
  return page.evaluate(() => {
    const layer = (window as { dataLayer?: unknown[] }).dataLayer ?? [];
    return layer.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && "event" in entry,
    ) as Record<string, unknown>[];
  });
}

async function readEvents(page: Page, name: string): Promise<DataLayerEntry[]> {
  return (await readDataLayer(page)).filter((entry) => entry.event === name);
}

function ecommerceOf(entry: DataLayerEntry | undefined) {
  return (entry?.ecommerce ?? {}) as {
    items?: Array<Record<string, unknown>>;
    value?: number;
    currency?: string;
    item_list_id?: string;
  };
}

test.beforeAll(async () => {
  await cleanup();

  const shirtProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: shirt.externalId,
      slug: shirt.slug,
      name: shirt.name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { editorialDescription: "Canonical commerce event regression product." } },
    },
  });
  const variantM = await seedVariant(shirtProduct.id, {
    pancakeVariationId: shirt.variationM,
    size: "M",
    priceVnd: shirt.priceVnd,
    stock: 20,
  });
  shirtVariantMId = variantM.id;
  await seedVariant(shirtProduct.id, {
    pancakeVariationId: shirt.variationL,
    size: "L",
    priceVnd: shirt.priceVnd,
    stock: 20,
  });

  const coatProduct = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: coat.externalId,
      slug: coat.slug,
      name: coat.name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { editorialDescription: "Second canonical commerce event product." } },
    },
  });
  const coatVariant = await seedVariant(coatProduct.id, {
    pancakeVariationId: coat.variation,
    size: "M",
    priceVnd: coat.priceVnd,
    stock: 20,
  });
  coatVariantId = coatVariant.id;

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/commerce-events",
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
      // Publishes the dataLayer. Loading a container remains a separate, still-closed gate.
      LA_TRACKING_MODE: "preview",
      LA_GTM_CONTAINER_ID: "GTM-TESTONLY",
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

test("U18 a shopper's list, select and product view report product identity, never a variation", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });

  const [listEvent] = await readEvents(page, "view_item_list");
  const listItems = ecommerceOf(listEvent).items ?? [];
  const seeded = listItems.filter(({ item_id }) => item_id === shirt.externalId);
  expect(seeded.length, "one rendered card produces exactly one product impression").toBe(1);
  expect(seeded[0]?.item_id).toBe(shirt.externalId);
  expect(seeded[0]?.price).toBe(shirt.priceVnd);
  expect(seeded[0]?.quantity, "an impression is not a committed quantity").toBeUndefined();
  // Both sizes are on the card; neither may appear as an identity.
  expect(JSON.stringify(listItems)).not.toContain(shirt.variationM);
  expect(JSON.stringify(listItems)).not.toContain(shirt.variationL);

  await page.getByRole("link", { name: `Xem ${shirt.name}` }).click();
  await page.waitForURL(`${BASE_URL}/shop/${shirt.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: shirt.name })).toBeVisible();

  // `select_item` was published on the click, before the navigation replaced the document, so it is
  // read from the shop page's own layer via the client-side transition.
  const selectEvents = await readEvents(page, "select_item");
  expect(selectEvents.length).toBe(1);
  expect(ecommerceOf(selectEvents[0]).items?.[0]?.item_id).toBe(shirt.externalId);

  const viewItem = await readEvents(page, "view_item");
  expect(viewItem.length).toBe(1);
  expect(
    ecommerceOf(viewItem[0]).items?.[0]?.item_id,
    "an unselected product page reports the product, not a guessed variant",
  ).toBe(shirt.externalId);
});

test("U18 a route-preselected variation reports view_item at variation identity", async ({ page }) => {
  await page.goto(`${BASE_URL}/shop/${shirt.slug}?variant=${shirt.variationL}`, {
    waitUntil: "networkidle",
  });

  const viewItem = await readEvents(page, "view_item");
  expect(viewItem.length).toBe(1);
  const item = ecommerceOf(viewItem[0]).items?.[0];
  expect(item?.item_id).toBe(shirt.variationL);
  expect(item?.item_group_id).toBe(shirt.externalId);
  expect(item?.price).toBe(shirt.priceVnd);
});

test("U18 each add click reports exactly one unit at the price the server committed", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(`${BASE_URL}/shop/${shirt.slug}`, { waitUntil: "networkidle" });

  await selectOption(page, "Black");
  await selectOption(page, "M");
  const addButton = page.getByRole("button", { name: "Thêm vào giỏ hàng" });

  await addButton.click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  // The catalog price moves after this page was rendered. The next click must report the new price:
  // the panel's own rendered price is now stale, and using it would publish money nobody was charged.
  const raisedPriceVnd = 650_000;
  await prisma.variantMirror.update({
    where: { id: shirtVariantMId },
    data: {
      pancakeRetailPrice: raisedPriceVnd,
      pancakeRetailPriceAfterDiscount: raisedPriceVnd,
    },
  });

  await addButton.click();
  await expect
    .poll(async () => (await readEvents(page, "add_to_cart")).length, { timeout: 15_000 })
    .toBe(2);

  const addEvents = await readEvents(page, "add_to_cart");
  for (const event of addEvents) {
    const item = ecommerceOf(event).items?.[0];
    expect(item?.item_id, "the committed variation, not the product").toBe(shirt.variationM);
    expect(item?.item_group_id).toBe(shirt.externalId);
    expect(
      item?.quantity,
      "each click adds one unit; the committed line total is never the event quantity",
    ).toBe(1);
  }
  expect(ecommerceOf(addEvents[0]).items?.[0]?.price).toBe(shirt.priceVnd);
  expect(
    ecommerceOf(addEvents[1]).items?.[0]?.price,
    "the second click reports the current server price, not the rendered one",
  ).toBe(raisedPriceVnd);

  // Two clicks, two committed units — the absolute set-to-one path would have left this at 1.
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  await expect(page.getByLabel("Số lượng")).toHaveValue("2");

  await prisma.variantMirror.update({
    where: { id: shirtVariantMId },
    data: {
      pancakeRetailPrice: shirt.priceVnd,
      pancakeRetailPriceAfterDiscount: shirt.priceVnd,
    },
  });
});

test("U19 the cart reports a complete view_cart and delta events from committed facts", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(`${BASE_URL}/shop/${shirt.slug}`, { waitUntil: "networkidle" });
  await selectOption(page, "Black");
  await selectOption(page, "M");
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  const [viewCart] = await readEvents(page, "view_cart");
  const cartEcommerce = ecommerceOf(viewCart);
  expect(cartEcommerce.currency).toBe("VND");
  expect(cartEcommerce.items?.length).toBe(1);
  expect(cartEcommerce.items?.[0]?.item_id).toBe(shirt.variationM);
  expect(cartEcommerce.items?.[0]?.quantity).toBe(1);
  expect(cartEcommerce.value, "the value is the exact merchandise sum").toBe(shirt.priceVnd);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);

  // Increase 1 → 4: one AddToCart for the delta of 3, not for the committed total.
  await page.getByLabel("Số lượng").fill("4");
  await page.getByRole("button", { name: "Cập nhật" }).click();
  await expect
    .poll(async () => (await readEvents(page, "add_to_cart")).length, { timeout: 15_000 })
    .toBe(1);
  const increase = ecommerceOf((await readEvents(page, "add_to_cart"))[0]).items?.[0];
  expect(increase?.item_id).toBe(shirt.variationM);
  expect(increase?.quantity).toBe(3);
  expect(increase?.price).toBe(shirt.priceVnd);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  // Decrease 4 → 1: one RemoveFromCart for the delta of 3.
  await page.getByLabel("Số lượng").fill("1");
  await page.getByRole("button", { name: "Cập nhật" }).click();
  await expect
    .poll(async () => (await readEvents(page, "remove_from_cart")).length, { timeout: 15_000 })
    .toBe(1);
  expect(ecommerceOf((await readEvents(page, "remove_from_cart"))[0]).items?.[0]?.quantity).toBe(3);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  // Same quantity: a successful write that moved nothing reports no quantity event.
  await page.getByLabel("Số lượng").fill("1");
  await page.getByRole("button", { name: "Cập nhật" }).click();
  await expect(page.getByText("Đã cập nhật số lượng.")).toBeVisible();
  expect(await readEvents(page, "add_to_cart")).toEqual([]);
  expect(await readEvents(page, "remove_from_cart")).toEqual([]);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  // Removal reports the quantity that actually left the cart.
  await page.getByRole("button", { name: "Xóa" }).click();
  await expect
    .poll(async () => (await readEvents(page, "remove_from_cart")).length, { timeout: 15_000 })
    .toBe(1);
  const removed = ecommerceOf((await readEvents(page, "remove_from_cart"))[0]).items?.[0];
  expect(removed?.item_id).toBe(shirt.variationM);
  expect(removed?.quantity).toBe(1);
  await expect(page.getByText("Giỏ hàng của bạn đang trống.")).toBeVisible();
});

test("U19 an unsafe cart emits no view_cart and no begin_checkout, and checkout still works", async ({
  page,
  context,
}) => {
  await context.clearCookies();

  // Two lines, both safe: checkout is valid and reports the whole basket.
  for (const [slug, size] of [[shirt.slug, "M"], [coat.slug, "M"]] as const) {
    await page.goto(`${BASE_URL}/shop/${slug}`, { waitUntil: "networkidle" });
    await selectOption(page, "Black");
    await selectOption(page, size);
    await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
    await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();
  }

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });
  const [beginCheckout] = await readEvents(page, "begin_checkout");
  const checkoutEcommerce = ecommerceOf(beginCheckout);
  expect(checkoutEcommerce.items?.length).toBe(2);
  expect(
    checkoutEcommerce.value,
    "the checkout value is the full merchandise sum, shipping excluded",
  ).toBe(shirt.priceVnd + coat.priceVnd);
  expect(
    JSON.stringify(checkoutEcommerce.items),
    "no local mutation id ever becomes a vendor item id",
  ).not.toContain(shirtVariantMId);
  expect(JSON.stringify(checkoutEcommerce.items)).not.toContain(coatVariantId);

  // One line becomes unresolvable. The whole projection goes with it, on both surfaces.
  await prisma.variantMirror.update({
    where: { id: coatVariantId },
    data: { isActive: false },
  });

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  expect(
    await readEvents(page, "view_cart"),
    "a mixed cart emits no partial items and no partial total",
  ).toEqual([]);
  // The shopper still sees their cart, including the line that cannot be measured.
  await expect(page.getByText("Sản phẩm không còn khả dụng").first()).toBeVisible();

  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });
  expect(await readEvents(page, "begin_checkout")).toEqual([]);
  await expect(page.getByText("Giỏ hàng cần được kiểm tra lại.")).toBeVisible();

  await prisma.variantMirror.update({
    where: { id: coatVariantId },
    data: { isActive: true },
  });
});

test("U19 commerce event payloads carry no cart identity and no customer facts", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(`${BASE_URL}/shop/${shirt.slug}`, { waitUntil: "networkidle" });
  await selectOption(page, "Black");
  await selectOption(page, "M");
  await page.getByRole("button", { name: "Thêm vào giỏ hàng" }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.")).toBeVisible();

  const cartCookie = (await context.cookies()).find(({ name }) => name === "la_cart");
  expect(cartCookie?.httpOnly, "the anonymous cart handle stays server-only").toBe(true);

  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  const serialized = JSON.stringify(await readDataLayer(page));
  expect(serialized).not.toContain(cartCookie?.value ?? "la_cart-unset");
  expect(serialized).not.toContain(shirtVariantMId);
  for (const key of ["guestName", "guestPhone", "addressDetail", "email", "note"]) {
    expect(serialized).not.toContain(key);
  }
});

test("U18 publishing commerce events loads no tag manager and opens no vendor origin", async ({
  page,
}) => {
  const vendorRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/googletagmanager|google-analytics|googleadservices|analytics\.tiktok/.test(url)) {
      vendorRequests.push(url);
    }
  });

  await page.goto(`${BASE_URL}/shop/${shirt.slug}`, { waitUntil: "networkidle" });
  expect((await readEvents(page, "view_item")).length).toBe(1);
  expect(vendorRequests, "T8 owns the first container load").toEqual([]);
  expect(await page.locator('script[src*="googletagmanager.com"]').count()).toBe(0);
});
