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
async function serveVideo(page: Page, onRequest: () => void = () => undefined) {
  await page.route(VIDEO_A, (route) => {
    onRequest();
    const range = route.request().headers().range;
    const start = Number(range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", headers: { "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${mp4.length - 1}/${mp4.length}` } : {}) }, body: mp4.subarray(start) });
  });
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
  const floatingLayout = width >= 1024;
  test(`one overlay, photo count and collision-free layout at ${width}px: ${floatingLayout ? "floating mini-player" : "9:16 frame on the photo"}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serveVideo(page);
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile).toHaveCount(1);
    await expect(tile).toBeVisible();
    await expect(page.locator("dialog video, dialog source")).toHaveCount(0);
    // The preview starts by itself once the page has loaded: muted, looping, inline, decorative.
    const preview = tile.locator("video");
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(await preview.evaluate((element: HTMLVideoElement) => [element.muted, element.loop, element.playsInline])).toEqual([true, true, true]);
    await expect(preview).toHaveAttribute("data-playing", "true");
    await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.3);
    const counter = page.locator(floatingLayout ? ".pdp-stage__counter" : ".pdp-mobile-gallery__counter");
    await expect(counter).toHaveText(floatingLayout ? "Trang ảnh 1 / 2" : "1/3");
    const t = (await tile.boundingBox())!;
    expect(t.height / t.width, "the frame is 9:16 portrait").toBeCloseTo(16 / 9, 1);
    expect(t.width).toBeGreaterThanOrEqual(44);
    expect(t.x + t.width).toBeLessThanOrEqual(width);
    const c = (await counter.boundingBox())!;
    const flash = (await page.locator(".pdp-flash-tag").boundingBox())!;
    expect(flash.x + flash.width <= t.x || flash.y >= t.y + t.height).toBeTruthy();
    // At every width the shopper can stop the motion (WCAG 2.2.2) and keep using the page.
    const stop = page.getByRole("button", { name: "Đóng video nhỏ", exact: true });
    await expect(stop).toBeVisible();
    const slotAxe = await new AxeBuilder({ page }).include(".pdp-video-slot").withTags(BUYER_AXE_TAGS).analyze();
    expect(slotAxe.violations).toEqual([]);
    if (floatingLayout) {
      // A mini-player pinned to the viewport's bottom right, clear of the counter, with a close button.
      expect(await tile.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe("fixed");
      expect(t.width).toBe(168);
      expect(width - t.x - t.width).toBeCloseTo(24, 0);
      expect(t.y + t.height).toBeLessThanOrEqual(c.y);
      // It floats while the photographs are in view, then docks back onto them instead of sitting
      // over the price and buy buttons in the purchase panel.
      const slot = page.locator(".pdp-video-slot");
      await page.mouse.wheel(0, 200);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
      await expect(slot).toHaveAttribute("data-float", "true");
      await page.mouse.wheel(0, 700);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
      await expect(slot).toHaveAttribute("data-float", "false");
      await expect(stop).toBeVisible();
      await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(slot).toHaveAttribute("data-float", "true");
      await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    } else {
      expect(t.y + t.height).toBeLessThanOrEqual(c.y);
    }

    // Opening carries on from where the preview was, with sound controls, and does not restart.
    const before = await preview.evaluate((element: HTMLVideoElement) => element.currentTime);
    await tile.click();
    const dialog = page.getByRole("dialog", { name: `Video ${productName}` });
    await expect(dialog).toBeVisible();
    const watched = dialog.locator("video");
    await expect(watched).toHaveAttribute("preload", "none");
    await expect.poll(() => watched.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(before - 0.1);
    await expect.poll(() => watched.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    const box = (await watched.boundingBox())!;
    expect(box.height / box.width, "the dialog player is 9:16 portrait").toBeCloseTo(16 / 9, 1);
    // The dialog holds the shopper's attention: the inline preview stands still until it closes.
    await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(tile).toBeFocused();
    await expect(page.locator("dialog video, dialog source")).toHaveCount(0);
    await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);

    // Dismiss removes the whole frame, poster and opener at every width.
    await stop.click();
    await expect(page.locator(".pdp-video-slot, video, source")).toHaveCount(0);
    await expect(tile).toHaveCount(0);
    await expect(page.locator(".pdp-stage")).toBeFocused();
    if (floatingLayout) {
      await page.getByRole("button", { name: "Ảnh tiếp theo", exact: true }).click();
      await expect(counter).toHaveText("Trang ảnh 2 / 2");
    } else {
      await page.locator(".pdp-mobile-gallery__image").first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(counter).toHaveText("2/3");
    }
  });
}

test("one-photo desktop gallery anchors the fallback tile inside its centered primary photo", async ({ page }) => {
  // Reduced motion leaves the desktop frame a poster: the original small tile on the photograph.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prisma.variantMirror.updateMany({ where: { product: { pancakeProductId: externalId } }, data: { pancakeImageUrls: [] } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile).toHaveCount(1);
    await page.waitForLoadState("load");
    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Đóng video nhỏ", exact: true })).toBeVisible();
    const photo = (await page.locator('.pdp-stage__slide[data-active="true"] .pdp-stage__cell').first().boundingBox())!;
    const t = (await tile.boundingBox())!;
    expect([t.width, t.height]).toEqual([96, 76]);
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

test("on a phone dismiss removes the entire video frame and selection stays usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile.locator("video")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Đóng video nhỏ", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await expect(tile).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".pdp-video-slot, video")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".pdp-video-slot, video")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("group", { name: /^Kích cỡ/ }).getByText("L", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
});

test("the preview plays only while a quarter of it is on screen and not when the dialog closes out of view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  const preview = tile.locator("video");
  await expect(preview).toHaveAttribute("data-playing", "true");
  const box = (await tile.boundingBox())!;
  const paused = () => preview.evaluate((element: HTMLVideoElement) => element.paused);
  // Only a sliver (10%) of the frame is left at the top of the viewport: it stands still.
  await page.evaluate((y) => window.scrollTo(0, y), box.y + box.height * 0.9);
  await expect.poll(paused).toBe(true);
  // Half of it back on screen: it plays again.
  await page.evaluate((y) => window.scrollTo(0, y), box.y + box.height * 0.5);
  await expect.poll(paused).toBe(false);
  // Closing the dialog while the frame is out of view must not start it in the background.
  await page.evaluate(() => window.scrollTo(0, 0));
  await tile.click();
  await expect(page.getByRole("dialog", { name: `Video ${productName}` })).toBeVisible();
  await page.evaluate((y) => window.scrollTo(0, y), box.y + box.height * 0.95);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect(await paused()).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(paused).toBe(false);
});

test("turning on reduced motion while the page is open stops and removes the preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile.locator("video")).toHaveAttribute("data-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Đóng video nhỏ", exact: true })).toBeVisible();
  await expect(tile).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(tile.locator("video")).toHaveAttribute("data-playing", "true");
});

test("a remounted preview keeps its poster until the new player actually plays", async ({ page }) => {
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const preview = page.locator(".pdp-video-tile video");
  await expect(preview).toHaveAttribute("data-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(preview).toHaveCount(0);
  // The new player cannot start yet, even if the previous instance had already played.
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      return this.controls ? original.call(this) : new Promise<void>(() => undefined);
    };
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(preview).toHaveCount(1);
  await expect(preview).toHaveAttribute("data-playing", "false");
  expect(await preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
});

test("the first dialog frame resumes a later preview position and close hands its position back", async ({ page }) => {
  await page.addInitScript(() => {
    const firstFrames: number[] = [];
    (window as unknown as { __dialogFirstFrames: number[] }).__dialogFirstFrames = firstFrames;
    document.addEventListener("playing", (event) => {
      const target = event.target;
      if (target instanceof HTMLVideoElement && target.controls) firstFrames.push(target.currentTime);
    }, true);
  });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const preview = page.locator(".pdp-video-tile video");
  await expect(preview).toHaveAttribute("data-playing", "true");
  await preview.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = 2.5; });
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  const frames = () => page.evaluate(() => (window as unknown as { __dialogFirstFrames: number[] }).__dialogFirstFrames);
  await expect.poll(async () => (await frames()).length).toBeGreaterThan(0);
  expect((await frames())[0]).toBeGreaterThanOrEqual(2.4);
  await page.locator("dialog video").evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = 1.5; });
  await page.keyboard.press("Escape");
  await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  const handedBack = await preview.evaluate((element: HTMLVideoElement) => element.currentTime);
  expect(handedBack).toBeGreaterThanOrEqual(1.4);
  expect(handedBack, "close must hand back the dialog position, not the old 2.5s preview position").toBeLessThan(2.4);
});

for (const [width, height] of [[1280, 520], [1440, 560]] as const) {
  test(`at ${width}x${height} the floating mini-player and its stop button are fully inside the window and clickable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await serveVideo(page);
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile.locator("video")).toHaveAttribute("data-playing", "true");
    const stop = page.getByRole("button", { name: "Đóng video nhỏ", exact: true });
    await expect(stop).toBeVisible();
    for (const target of [tile, stop]) {
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }
    // The stop button is the element a tap at its centre reaches, not something laid over it (the
    // sticky header is the one thing that could be: it is taller than the 17px a short window leaves).
    const centre = (await stop.boundingBox())!;
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"), [centre.x + centre.width / 2, centre.y + centre.height / 2])).toBe("Đóng video nhỏ");
    await stop.click();
    await expect(stop).toHaveCount(0);
  });
}

test("in a window too short for the mini-player it stays a small poster tile on the photograph", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile).toBeVisible();
  await page.waitForLoadState("load");
  await page.waitForTimeout(400);
  await expect(page.locator(".pdp-video-slot")).toHaveAttribute("data-float", "false");
  await expect(page.getByRole("button", { name: "Đóng video nhỏ", exact: true })).toBeVisible();
  const box = (await tile.boundingBox())!;
  expect([box.width, box.height]).toEqual([96, 76]);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(500);
  // No preview at all: nothing is requested or plays out of sight.
  await expect(page.locator("video")).toHaveCount(0);
  await tile.click();
  await expect(page.getByRole("dialog", { name: `Video ${productName}` })).toBeVisible();
});

for (const mode of ["reduced-motion", "data-saver", "2g", "preview-error", "desktop-dock"] as const) {
  test(`the entire frame can be dismissed with ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: mode === "desktop-dock" ? 1280 : 390, height: 800 });
    if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "data-saver" || mode === "2g") {
      await page.addInitScript((mode) => {
        const connection = Object.assign(new EventTarget(), { saveData: mode === "data-saver", effectiveType: mode === "2g" ? "2g" : "4g" });
        Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
      }, mode);
    }
    let previewRequested = false;
    if (mode === "preview-error") await page.route(VIDEO_A, (route) => { previewRequested = true; return route.abort(); });
    else await serveVideo(page);
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    await expect(tile).toBeVisible();
    if (mode === "preview-error") await expect.poll(() => previewRequested).toBe(true);
    if (mode === "desktop-dock") {
      await expect(page.locator(".pdp-video-slot")).toHaveAttribute("data-float", "true");
      await page.mouse.wheel(0, 350);
      await expect(page.locator(".pdp-video-slot")).toHaveAttribute("data-float", "false");
      await expect.poll(() => tile.locator("video").evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    } else {
      await expect(tile.locator("video")).toHaveCount(0);
    }
    const dismiss = page.getByRole("button", { name: "Đóng video nhỏ", exact: true });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(page.locator(".pdp-video-slot, video, source")).toHaveCount(0);
    await expect(tile).toHaveCount(0);
    await expect(page.locator(".pdp-stage")).toBeFocused();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".pdp-video-slot")).toHaveCount(0);
  });
}

test("a browser that refuses sound without its own gesture leaves the player on its controls with a hint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    (window as unknown as { __blockPlay: boolean }).__blockPlay = true;
    HTMLMediaElement.prototype.play = function play() {
      if (this.controls && (window as unknown as { __blockPlay: boolean }).__blockPlay) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      return original.call(this);
    };
  });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Video ${productName}` });
  await expect(dialog.getByRole("status")).toHaveText("Bấm nút Play để xem video.");
  await expect(dialog.locator("video")).toHaveAttribute("controls", "");
  expect(collectedPlayback().failures).toBe(0);
  await page.evaluate(() => { (window as unknown as { __blockPlay: boolean }).__blockPlay = false; });
  await dialog.locator("video").evaluate((element: HTMLVideoElement) => element.play());
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect.poll(() => dialog.locator("video").evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
});

test("the preview does not play while the tab is hidden, and never revives a stopped or held one", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    (window as unknown as { __setHidden: (value: boolean) => void }).__setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await serveVideo(page);
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  const preview = tile.locator("video");
  const paused = () => preview.evaluate((element: HTMLVideoElement) => element.paused);
  const setHidden = (value: boolean) => page.evaluate((hidden) => (window as unknown as { __setHidden: (value: boolean) => void }).__setHidden(hidden), value);
  await expect(preview).toHaveAttribute("data-playing", "true");
  await setHidden(true);
  await expect.poll(paused).toBe(true);
  await setHidden(false);
  await expect.poll(paused).toBe(false);
  // Closing the dialog while the tab is hidden must not start it in the background.
  await tile.click();
  await expect(page.getByRole("dialog", { name: `Video ${productName}` })).toBeVisible();
  await setHidden(true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await paused()).toBe(true);
  await setHidden(false);
  await expect.poll(paused).toBe(false);
  // A stopped preview is gone and a tab switch does not bring it back.
  await page.getByRole("button", { name: "Đóng video nhỏ", exact: true }).click();
  await setHidden(true);
  await setHidden(false);
  await page.waitForTimeout(300);
  await expect(page.locator("video")).toHaveCount(0);
});

test("explicit play fetches/decodes fixture MP4, seeks, closes and reopens accessibly", async ({ page }) => {
  let mediaRequests = 0;
  await serveVideo(page, () => { mediaRequests++; });
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await tile.click();
  const dialog = page.getByRole("dialog", { name: `Video ${productName}` });
  const video = dialog.locator("video");
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
  await expect(page.locator("dialog video, dialog source")).toHaveCount(0);
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
  await page.locator("dialog video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toBeVisible();
  await expect.poll(() => collectedPlayback().failures).toBe(1);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  // Native source and player callbacks may both fire; neither adds another failure.
  await page.locator("dialog video").evaluate((element) => {
    element.dispatchEvent(new Event("error"));
    element.querySelector("source")?.dispatchEvent(new Event("error"));
  });
  expect(collectedPlayback().failures).toBe(1);
  await page.keyboard.press("Escape");
  await expect(size).toBeChecked();
  await expect(page.locator(".pdp-mobile-gallery__counter")).toHaveText("1/3");
  await expect(page.getByRole("button", { name: "Thêm vào giỏ", exact: false }).first()).toBeEnabled();
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("dialog video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
  await expect.poll(() => collectedPlayback().failures).toBe(2);
  expect(collectedPlayback().attempts).toBe(2);
});

test("an audio-only container is counted as unsupported video and stopped", async ({ page }) => {
  await page.route(VIDEO_A, (route) => route.fulfill({ contentType: "video/mp4", body: audioOnlyMp4 }));
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Chưa phát được video" })).toBeVisible();
  await expect.poll(() => collectedPlayback().errors.unsupported).toBe(1);
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  expect(await page.locator("dialog video").evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect(page.locator("dialog video source")).not.toHaveAttribute("src");
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
    const video = page.locator("dialog video");
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

test("opening autoplays the dialog once and closing a waiting player cancels the timeout", async ({ page }) => {
  await page.clock.install();
  let finish: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(VIDEO_A, async (route) => { await held; await route.abort().catch(() => undefined); });
  try {
    await page.goto(`${BASE}/shop/${slug}`);
    const tile = page.getByRole("button", { name: "Xem video", exact: true });
    // The inline preview is silent: only the shopper's own opening is an attempt.
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
    expect(collectedPlayback().attempts).toBe(0);
    expect(collectedPlayback().failures).toBe(0);
    await tile.click();
    await expect.poll(() => collectedPlayback().attempts).toBe(1);
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS - 1000);
    expect(collectedPlayback().failures).toBe(0);
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await page.clock.fastForward(PDP_VIDEO_PLAYBACK_TIMEOUT_MS * 2);
    expect(collectedPlayback().failures).toBe(0);
  } finally { finish(); }
});

test("a failing inline preview falls back to the poster and sends no telemetry", async ({ page }) => {
  await page.route(VIDEO_A, (route) => route.abort());
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile).toBeVisible();
  await expect(tile.locator("video")).toHaveCount(0);
  expect(collectedPlayback().attempts).toBe(0);
  expect(collectedPlayback().failures).toBe(0);
});

test("reduced motion keeps the frame a poster and requests no video until it is opened", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requests: string[] = [];
  page.on("request", (r) => { if (/\.(mp4|mov)(?:[?#]|$)/.test(r.url())) requests.push(r.url()); });
  await page.goto(`${BASE}/shop/${slug}`);
  const tile = page.getByRole("button", { name: "Xem video", exact: true });
  await expect(tile).toBeVisible();
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  await expect(page.locator("video")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("successful playing cancels the startup deadline", async ({ page }) => {
  await page.clock.install();
  await page.route(VIDEO_A, (route) => route.fulfill({ contentType: "video/mp4", body: mp4 }));
  await page.goto(`${BASE}/shop/${slug}`);
  await page.getByRole("button", { name: "Xem video", exact: true }).click();
  await page.locator("dialog video").evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => collectedPlayback().attempts).toBe(1);
  await expect.poll(() => page.locator("dialog video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(3);
  // A network stalled event is not a playback stall while future data is buffered.
  await page.locator("dialog video").evaluate((element) => element.dispatchEvent(new Event("stalled")));
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
  await page.locator("dialog video").evaluate((element: HTMLVideoElement) => { void element.play().catch(() => undefined); });
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
  await expect(page.locator("dialog video, dialog source")).toHaveCount(0);
  await tile.click();
  await expect(page.locator("dialog video source")).toHaveAttribute("src", VIDEO_A);
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
