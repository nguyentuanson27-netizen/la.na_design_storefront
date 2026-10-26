import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { parsePancakeCatalogVariations } from "../../src/integrations/pancake/catalog-contract.ts";
import { prisma } from "../../src/db/prisma.ts";
import { summarizePdpVideoPlaybackLogs } from "../../src/operations/pdp-video-playback-summary.ts";
import { VIDEO_A, VIDEO_POSTER, videoPage, videoVariation } from "../fixtures/pancake-video.ts";
import { PDP_VIDEO_PLAYBACK_TIMEOUT_MS } from "../../src/components/headless/pdp-video-playback.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { OPTIMIZED_IMAGE_ROUTE } from "./image-routes";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = "http://127.0.0.1:3366";
const SHOP = 920_216;
const run = `${Date.now()}-${process.pid}`;
const slug = `pdp-video-${run}`;
const externalId = `pdp-video-${run}`;
const productName = "Sản phẩm video thử nghiệm";
const mp4 = readFileSync(resolve(import.meta.dirname, "fixtures/product-video.mp4"));
const audioOnlyMp4 = readFileSync(resolve(import.meta.dirname, "fixtures/product-video-audio-only.mp4"));
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let server: ChildProcess | undefined;
let output = "";

async function start(enabled: boolean) {
  output = "";
  server = spawn(process.execPath, [resolve(ROOT, "node_modules/next/dist/bin/next"), NEXT_SERVER_COMMAND, "--hostname", "127.0.0.1", "--port", "3366"], {
    cwd: ROOT, env: { ...process.env, ...nextServerEnv(".next-test/pdp-pancake-video"), PANCAKE_SHOP_ID: String(SHOP), APP_DOMAIN: "127.0.0.1:3366", LA_PDP_PANCAKE_VIDEO_ENABLED: String(enabled), BETTER_AUTH_URL: BASE, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b) => { output = (output + b.toString()).slice(-20000); });
  server.stderr?.on("data", (b) => { output = (output + b.toString()).slice(-20000); });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Video test server exited\n${output}`);
    try { const response = await fetch(`${BASE}/shop/${slug}`); if (response.ok && (await response.text()).includes(productName)) return; } catch { /* compiling */ }
    await delay(500);
  }
  throw new Error(`Video test server timed out\n${output}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  if (!(await Promise.race([once(server, "exit").then(() => true), delay(5000).then(() => false)]))) server.kill("SIGKILL");
  server = undefined;
}
async function cleanup() { await prisma.promotionCampaign.deleteMany({ where: { id: externalId } }); await prisma.productMirror.deleteMany({ where: { pancakeProductId: externalId } }); await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: SHOP } }); }
async function state(pancakeVideoSyncState: "READY" | "UNKNOWN" | "NONE" | "CONFLICT" | "UNSUPPORTED", pancakeVideoUrl: string | null = VIDEO_A) {
  await prisma.productMirror.update({ where: { pancakeProductId: externalId }, data: { pancakeVideoSyncState, pancakeVideoUrl } });
}
function collectedPlayback() { return summarizePdpVideoPlaybackLogs(output.split("\n")); }
async function images(page: Page) {
  await page.route(OPTIMIZED_IMAGE_ROUTE, (route) => route.fulfill({ contentType: "image/png", body: image }));
  await page.route("https://content.pancake.vn/**/*.jpg", (route) => route.fulfill({ contentType: "image/png", body: image }));
}

test.beforeAll(async () => {
  await cleanup();
  const product = await prisma.productMirror.create({ data: {
    pancakeShopId: SHOP, pancakeProductId: externalId, slug, name: productName, syncedAt: new Date(), primaryImageUrl: VIDEO_POSTER,
    pancakeVideoSyncState: "READY", pancakeVideoUrl: VIDEO_A,
    variants: { create: ["M", "L"].map((size, i) => ({ pancakeVariationId: `${externalId}-${i}`, color: "Đen", size, pancakeRetailPrice: 500000, pancakeRetailPriceAfterDiscount: 500000, syncedAt: new Date(), pancakeImageUrls: [VIDEO_POSTER, VIDEO_POSTER.replace("a.jpg", "detail.jpg"), VIDEO_POSTER.replace("a.jpg", "back.jpg")], warehouseStocks: { create: { pancakeWarehouseId: "video-fixture-wh", quantity: 5, syncedAt: new Date() } } })) },
  } });
  await prisma.promotionCampaign.create({ data: { id: externalId, kind: "FLASH_SALE", name: "Video layout fixture", discountType: "PERCENTAGE", percentageValue: 10, isEnabled: true, enabledAt: new Date(), startsAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 3600000), targets: { create: { productId: product.id } } } });
  await start(true);
});
test.beforeEach(async ({ page }) => { output = ""; await state("READY"); await images(page); });
test.afterAll(async () => { await stop(); await cleanup(); await prisma.$disconnect(); });

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`one overlay, photo count, collision-free layout and no media network at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    page.on("request", (r) => { if (/\.(mp4|mov)(?:[?#]|$)/.test(r.url())) requests.push(r.url()); });
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile).toHaveCount(1);
    await expect(tile).toBeVisible();
    await expect(page.locator("video, source")).toHaveCount(0);
    const counter = page.locator(width < 1024 ? ".pdp-mobile-gallery__counter" : ".pdp-stage__counter");
    await expect(counter).toHaveText(width < 1024 ? "1/3" : "Trang ảnh 1 / 2");
    const t = (await tile.boundingBox())!;
    if (width >= 1024) {
      const primaryPhoto = (await page.locator('.pdp-stage__slide[data-active="true"] .pdp-stage__cell').first().boundingBox())!;
      expect(t.x, "tile starts inside the primary photo").toBeGreaterThanOrEqual(primaryPhoto.x - 1);
      expect(t.y, "tile starts inside the primary photo").toBeGreaterThanOrEqual(primaryPhoto.y - 1);
      expect(t.x + t.width, "tile ends inside the primary photo, not the second photo").toBeLessThanOrEqual(primaryPhoto.x + primaryPhoto.width + 1);
      expect(t.y + t.height, "tile ends inside the primary photo").toBeLessThanOrEqual(primaryPhoto.y + primaryPhoto.height + 1);
      expect(primaryPhoto.x + primaryPhoto.width - t.x - t.width).toBeCloseTo(16, 0);
    }
    const c = (await counter.boundingBox())!;
    expect(t.y + t.height).toBeLessThanOrEqual(c.y);
    const flash = (await page.locator(".pdp-flash-tag").boundingBox())!;
    expect(flash.x + flash.width <= t.x || flash.y >= t.y + t.height).toBeTruthy();
    expect(t.width).toBeGreaterThanOrEqual(44);
    expect(t.x + t.width).toBeLessThanOrEqual(width);
    await page.waitForTimeout(200);
    expect(requests).toEqual([]);
    await tile.click();
    const dialog = page.getByRole("dialog", { name: `Video ${productName}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("video")).toHaveAttribute("preload", "none");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(tile).toBeFocused();
    await expect(page.locator("video, source")).toHaveCount(0);
    await expect(counter).toHaveText(width < 1024 ? "1/3" : "Trang ảnh 1 / 2");
    if (width >= 1024) {
      await page.getByRole("button", { name: "Ảnh tiếp theo", exact: true }).click();
      await expect(counter).toHaveText("Trang ảnh 2 / 2");
      await page.getByRole("button", { name: "Ảnh trước", exact: true }).click();
      await expect(counter).toHaveText("Trang ảnh 1 / 2");
    } else {
      await page.locator(".pdp-mobile-gallery__image").first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(counter).toHaveText("2/3");
      await page.keyboard.press("ArrowLeft");
      await expect(counter).toHaveText("1/3");
    }
  });
}

test("one-photo desktop gallery anchors the tile inside its centered primary photo", async ({ page }) => {
  await prisma.variantMirror.updateMany({ where: { product: { pancakeProductId: externalId } }, data: { pancakeImageUrls: [] } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile).toHaveCount(1);
    const photo = (await page.locator('.pdp-stage__slide[data-active="true"] .pdp-stage__cell').first().boundingBox())!;
    const t = (await tile.boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(photo.x - 1);
    expect(t.y).toBeGreaterThanOrEqual(photo.y - 1);
    expect(t.x + t.width).toBeLessThanOrEqual(photo.x + photo.width + 1);
    expect(t.y + t.height).toBeLessThanOrEqual(photo.y + photo.height + 1);
    expect(photo.x + photo.width - t.x - t.width).toBeCloseTo(16, 0);
    await tile.click();
    await expect(page.getByRole("dialog", { name: `Video ${productName}` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
  } finally {
    await prisma.variantMirror.updateMany({ where: { product: { pancakeProductId: externalId } }, data: { pancakeImageUrls: [VIDEO_POSTER, VIDEO_POSTER.replace("a.jpg", "detail.jpg"), VIDEO_POSTER.replace("a.jpg", "back.jpg")] } });
  }
});

test("explicit play fetches/decodes fixture MP4, seeks, closes and reopens accessibly", async ({ page }) => {
  let mediaRequests = 0;
  await page.route(VIDEO_A, (route) => {
    mediaRequests++;
    const range = route.request().headers().range;
    const start = Number(range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${mp4.length - 1}/${mp4.length}` } : {}) }, body: mp4.subarray(start) });
  });
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await tile.click();
  const dialog = page.getByRole("dialog", { name: `Video ${productName}` });
  const video = dialog.locator("video");
  expect(mediaRequests).toBe(0);
  expect(collectedPlayback().attempts).toBe(0);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 2; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(2);
  expect(mediaRequests).toBeGreaterThan(0);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  await video.evaluate(async (element: HTMLVideoElement) => { element.pause(); await element.play(); });
  expect(collectedPlayback().attempts).toBe(1);
  expect(collectedPlayback().failures).toBe(0);
  const axe = await new AxeBuilder({ page }).include("dialog[open]").withTags(BUYER_AXE_TAGS).analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  await expect(tile).toBeFocused();
  await expect(page.locator("video, source")).toHaveCount(0);
  await tile.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tile).toBeFocused();
});

test("playback failure retains photos and size selection", async ({ page }) => {
  await page.route(VIDEO_A, (route) => route.abort());
  await page.goto(`${BASE}/shop/${slug}`);
  const size = page.getByRole("radio", { name: "L", exact: true });
  await page.getByRole("region", { name: "Mua sản phẩm" }).getByRole("group", { name: /^Kích cỡ/ }).getByText("L", { exact: true }).click();
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toBeVisible();
  await expect.poll(() => collectedPlayback().failures).toBe(1);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  // Native source and player callbacks may both fire; neither adds another failure.
  await page.locator("video").evaluate((element) => {
    element.dispatchEvent(new Event("error"));
    element.querySelector("source")?.dispatchEvent(new Event("error"));
  });
  expect(collectedPlayback().failures).toBe(1);
  await page.keyboard.press("Escape");
  await expect(size).toBeChecked();
  await expect(page.locator(".pdp-mobile-gallery__counter")).toHaveText("1/3");
  await expect(page.getByRole("button", { name: "Thêm vào giỏ", exact: false }).first()).toBeEnabled();
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect.poll(() => collectedPlayback().failures).toBe(2);
  expect(collectedPlayback().attempts).toBe(2);
});

test("an audio-only container is counted as unsupported video and stopped", async ({ page }) => {
  await page.route(VIDEO_A, (route) => route.fulfill({ contentType: "video/mp4", body: audioOnlyMp4 }));
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toBeVisible();
  await expect.poll(() => collectedPlayback().errors.unsupported).toBe(1);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  expect(await page.locator("video").evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(page.locator("video source")).not.toHaveAttribute("src");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Xem video", exact: true })).toBeFocused();
});

test("startup waiting forever without error times out once and unloads the player", async ({ page }) => {
  await page.clock.install();
  let finish: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(VIDEO_A, async (route) => { await held; await route.abort().catch(() => undefined); });
  try {
    await page.goto(`${BASE}/shop/${slug}`);
    await page.getByRole("button", { name: "Xem video", exact: true }).click();
    const video = page.locator("video");
    await video.evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
    await expect.poll(() => collectedPlayback().attempts).toBe(1);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS - 1000);
    await video.evaluate((element) => { element.dispatchEvent(new Event("waiting")); element.dispatchEvent(new Event("stalled")); });
    expect(collectedPlayback().failures).toBe(0);
    await page.clock.fastForward(1001);
    await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toBeVisible();
    await expect.poll(() => collectedPlayback().errors.timeout).toBe(1);
    expect(collectedPlayback().failures).toBe(1);
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await expect(video.locator("source")).not.toHaveAttribute("src");
    await video.evaluate((element) => { element.dispatchEvent(new Event("error")); element.dispatchEvent(new Event("waiting")); });
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
    expect(collectedPlayback().failures).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Xem video", exact: true })).toBeFocused();
  } finally { finish(); }
});

test("closing a waiting player cancels timeout and opening alone does not start a deadline", async ({ page }) => {
  await page.clock.install();
  let finish: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(VIDEO_A, async (route) => { await held; await route.abort().catch(() => undefined); });
  try {
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await tile.click();
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
    expect(collectedPlayback().attempts).toBe(0);
    expect(collectedPlayback().failures).toBe(0);
    await page.locator("video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
    await expect.poll(() => collectedPlayback().attempts).toBe(1);
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
    expect(collectedPlayback().failures).toBe(0);
  } finally { finish(); }
});

test("successful playing cancels the startup deadline", async ({ page }) => {
  await page.clock.install();
  await page.route(VIDEO_A, (route) => route.fulfill({ contentType: "video/mp4", body: mp4 }));
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("video").evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(3);
  // A network stalled event is not a playback stall while future data is buffered.
  await page.locator("video").evaluate((element) => element.dispatchEvent(new Event("stalled")));
  await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
  expect(collectedPlayback().failures).toBe(0);
  await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("non-READY retained URLs and invalid READY URLs never reach HTML/JSON or render a tile", async ({ page }) => {
  for (const status of ["UNKNOWN", "NONE", "CONFLICT", "UNSUPPORTED"] as const) {
    await state(status);
    const response = await page.goto(`${BASE}/shop/${slug}`);
    expect(await response!.text()).not.toContain("a.mp4");
    await expect(page.getByRole("button", { name: "Xem video", exact: true })).toHaveCount(0);
  }
  await state("READY", "https://evil.test/private.mp4");
  const response = await page.goto(`${BASE}/shop/${slug}`);
  expect(await response!.text()).not.toContain("https://evil.test/private.mp4");
  await expect(page.getByRole("button", { name: "Xem video", exact: true })).toHaveCount(0);
});

test("telemetry sends only fixed fields without cookies/referrer and collection outages preserve player controls", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.context().addCookies([{ name: "private-test-cookie", value: "must-not-travel", url: BASE }]);
  await page.route(`${BASE}/api/product-video/events`, async (route) => {
    const request = route.request();
    bodies.push(request.postDataJSON());
    expect(request.headers().cookie).toBeUndefined();
    expect(request.headers().referer).toBeUndefined();
    await route.fulfill({ status: 503 });
  });
  await page.route(VIDEO_A, (route) => route.abort());
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual({ kind: "attempt" });
  expect(bodies[1]).toEqual({ kind: "failure", reason: expect.stringMatching(/^(network|decode|unsupported|timeout|unknown)$/) });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Xem video", exact: true })).toBeFocused();
  expect(collectedPlayback().attempts).toBe(0);
});

test("one own parent variation video renders the tile when another SKU has no video", async ({ page }) => {
  const raw = ["M", "L"].map((size, i) => ({
    ...videoVariation(`${externalId}-${i}`, externalId, i === 0 ? [VIDEO_A] : null),
    fields: [
      { id: "video-color", keyValue: "color", name: "Color", value: "Đen" },
      { id: "video-size", keyValue: "size", name: "Size", value: size },
    ],
    images: [VIDEO_POSTER, VIDEO_POSTER.replace("a.jpg", "detail.jpg"), VIDEO_POSTER.replace("a.jpg", "back.jpg")],
    retail_price_after_discount: 500000,
    product: { id: externalId, name: productName, image: VIDEO_POSTER },
    variations_warehouses: [{ warehouse_id: "video-fixture-wh", remain_quantity: 5 }],
  }));
  const variations = parsePancakeCatalogVariations(videoPage(raw)).variations;
  const repository = createCatalogMirrorRepository(prisma);
  await repository.syncSnapshot({ shopId: SHOP, syncedAt: new Date(), variations });
  await repository.syncSnapshot({ shopId: SHOP, syncedAt: new Date(), variations: [...variations].reverse() });
  const response = await page.goto(`${BASE}/shop/${slug}`);
  expect(response?.status()).toBe(200);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile).toHaveCount(1);
  await expect(tile).toBeVisible();
  await expect(page.locator("video, source")).toHaveCount(0);
  await tile.click();
  await expect(page.locator("video source")).toHaveAttribute("src", VIDEO_A);
  await page.keyboard.press("Escape");
  await expect(tile).toBeFocused();
});

test("collector enforces server origin, strict schema and actual byte bounds over HTTP", async ({ request }) => {
  const endpoint = `${BASE}/api/product-video/events`;
  for (const [origin, data] of [
    ["https://evil.test", { kind: "attempt" }],
    [BASE, { kind: "attempt", src: VIDEO_A }],
    [BASE, { kind: "failure", reason: "private-error-detail" }],
    [BASE, { kind: "attempt", padding: "x".repeat(200) }],
  ] as const) {
    const response = await request.post(endpoint, { headers: { origin }, data });
    expect(response.status()).toBe(204);
  }
  expect(collectedPlayback().attempts).toBe(0);
  const response = await request.post(endpoint, { headers: { origin: BASE }, data: { kind: "attempt" } });
  expect(response.status()).toBe(204);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
});

test("flag OFF suppresses even READY source in rendered response and collector events", async ({ page, request }) => {
  await stop();
  await start(false);
  const collected = await request.post(`${BASE}/api/product-video/events`, { headers: { origin: BASE }, data: { kind: "attempt" } });
  expect(collected.status()).toBe(204);
  expect(collectedPlayback().attempts).toBe(0);
  const response = await page.goto(`${BASE}/shop/${slug}`);
  expect(await response!.text()).not.toContain("a.mp4");
  await expect(page.getByRole("button", { name: "Xem video", exact: true })).toHaveCount(0);
});
