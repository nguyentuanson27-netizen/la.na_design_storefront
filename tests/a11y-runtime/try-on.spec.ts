import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * Virtual try-on on the PDP (docs/specs/storefront-virtual-try-on.md §16 Browser).
 *
 * The real route handler, service, product-image fetch, Vertex client and Google auth all run. Only
 * the remote origins are answered, by `try-on-fetch-fixture.cjs`, which also validates the request
 * Vertex would receive. The outcome of a generation is chosen by the shopper photo's marker bytes.
 * No real credential or Vertex spend is involved.
 */

const HOST = "127.0.0.1";
const ENABLED_PORT = 3341;
const DISABLED_PORT = 3342;
const ENABLED_URL = `http://${HOST}:${ENABLED_PORT}`;
const DISABLED_URL = `http://${HOST}:${DISABLED_PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const FETCH_FIXTURE = resolve(import.meta.dirname, "try-on-fetch-fixture.cjs");
const SHOP_ID = 920_041;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-10-04T00:00:00.000Z");

const PRODUCT_NAME = `Váy thử đồ ${runId}`;
const memberEmail = `try-on-member-${runId}@example.test`;
const slugs = {
  eligible: `try-on-vay-${runId}`,
  accessory: `try-on-phu-kien-${runId}`,
  webpFirst: `try-on-webp-${runId}`,
  uncategorised: `try-on-no-category-${runId}`,
};

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALgAJHb/2Q==";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOwiaogCTGMahjVMHw1AABPQw4Q5oG1CgAAAABJRU5ErkJggg==";

type UploadScenario = "ok" | "slow" | "fail" | "safety";

/** A real, decodable image whose trailing bytes tell the fixture how Vertex should answer. */
function jpegPhoto(scenario: UploadScenario = "ok") {
  return {
    name: "toi.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.concat([Buffer.from(JPEG_BASE64, "base64"), Buffer.from(`SCENARIO:${scenario}`)]),
  };
}
function pngPhoto(scenario: UploadScenario = "ok") {
  return {
    name: "toi.png",
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.from(`SCENARIO:${scenario}`)]),
  };
}

let workDir: string;
let logFile: string;
let credentialsFile: string;
const servers: ChildProcess[] = [];
let serverOutput = "";
let clientCounter = 10;

function captureOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function startServer({ port, enabled, distDir }: { port: number; enabled: boolean; distDir: string }) {
  const baseUrl = `http://${HOST}:${port}`;
  const server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(port)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${FETCH_FIXTURE}`].filter(Boolean).join(" "),
      APP_DOMAIN: `${HOST}:${port}`,
      BETTER_AUTH_URL: baseUrl,
      // Each test presents its own client address, so the per-client rate limit is exercised only
      // where a test means to.
      BETTER_AUTH_IP_HEADER: "x-ci-client-ip",
      PANCAKE_SHOP_ID: String(SHOP_ID),
      LA_TRY_ON_ENABLED: enabled ? "true" : "false",
      LA_TRY_ON_GCP_PROJECT_ID: "lana-test-project",
      GOOGLE_APPLICATION_CREDENTIALS: credentialsFile,
      TRY_ON_FIXTURE_LOG: logFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", captureOutput);
  server.stderr?.on("data", captureOutput);
  servers.push(server);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Next.js try-on server exited\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/shop/${slugs.eligible}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(PRODUCT_NAME)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the try-on server\n${serverOutput}`);
}

async function stopServers() {
  for (const server of servers.splice(0)) {
    if (server.exitCode !== null) continue;
    server.kill("SIGTERM");
    const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
    if (!exited) server.kill("SIGKILL");
  }
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { startsWith: "try-on-member-" } } });
  await prisma.cartItem.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP_ID } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function seedProduct({
  key,
  slug,
  name,
  categoryKeys,
  primaryImageUrl,
}: {
  key: string;
  slug: string;
  name: string;
  categoryKeys: string[];
  primaryImageUrl: string | null;
}) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `try-on-${key}-product-${runId}`,
      slug,
      name,
      primaryImageUrl,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: {
        create: {
          status: "PUBLISHED",
          editorialDescription: "Sản phẩm thử nghiệm cho thử đồ.",
          sizeGuide: "ao-dai",
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `try-on-${key}-variant-${runId}`,
      productId: product.id,
      color: "Đen",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_290_000,
      pancakeRetailPriceAfterDiscount: 1_290_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `try-on-${key}-warehouse-${runId}`, quantity: 5, syncedAt },
  });
  if (categoryKeys.length > 0) {
    await prisma.productCategoryMembership.createMany({
      data: categoryKeys.map((categoryKey) => ({ productId: product.id, categoryKey })),
    });
  }
}

type PredictLogEntry = {
  kind: "predict";
  pathOk: boolean;
  authorized: boolean;
  instances: number;
  productImages: number;
  garmentIsTrustedProduct: boolean;
  sampleCount: number;
  personGeneration: string;
  safetySetting: string;
  addWatermark: boolean;
  hasStorageUri: boolean;
};

function readLog(): Array<Record<string, unknown>> {
  const text = readFileSync(logFile, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}
function predictCalls(): PredictLogEntry[] {
  return readLog().filter((entry) => entry.kind === "predict") as PredictLogEntry[];
}
/** The server-side product-image fetch is the only one made with `redirect: "manual"`. */
function tryOnProductFetches() {
  return readLog().filter((entry) => entry.kind === "product-image" && entry.redirect === "manual");
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "try-on-spec-"));
  logFile = join(workDir, "fixture.log");
  writeFileSync(logFile, "");
  // A throwaway service-account credential with a freshly generated key, so the real Google auth
  // code runs end to end against the stubbed token endpoint. It authorizes nothing anywhere.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  credentialsFile = join(workDir, "credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      type: "service_account",
      project_id: "lana-test-project",
      private_key_id: "fixture",
      private_key: privateKey,
      client_email: "fixture@lana-test-project.iam.gserviceaccount.com",
      client_id: "1",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );

  await cleanup();
  await seedProduct({
    key: "eligible",
    slug: slugs.eligible,
    name: PRODUCT_NAME,
    categoryKeys: ["vayDam"],
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/try-on-first.jpg",
  });
  await seedProduct({
    key: "accessory",
    slug: slugs.accessory,
    name: `Phụ kiện ${runId}`,
    categoryKeys: ["phuKien"],
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/try-on-accessory.jpg",
  });
  await seedProduct({
    key: "webp",
    slug: slugs.webpFirst,
    name: `Váy webp ${runId}`,
    categoryKeys: ["vayDam"],
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/try-on-first.webp",
  });
  await seedProduct({
    key: "nocat",
    slug: slugs.uncategorised,
    name: `Chưa phân loại ${runId}`,
    categoryKeys: [],
    primaryImageUrl: "https://content.pancake.vn/images/1/2/3/try-on-first.jpg",
  });

  await startServer({ port: ENABLED_PORT, enabled: true, distDir: ".next-test/try-on-enabled" });
  await startServer({ port: DISABLED_PORT, enabled: false, distDir: ".next-test/try-on-disabled" });
});

test.afterAll(async () => {
  await stopServers();
  await cleanup();
  await prisma.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
  writeFileSync(logFile, "");
  clientCounter += 1;
  await context.setExtraHTTPHeaders({ "x-ci-client-ip": `198.51.100.${clientCounter}` });
});

// ---------------------------------------------------------------------------------------------

type Watched = {
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: string[];
  hosts: Set<string>;
  tryOnPosts: string[];
};

function watch(page: Page): Watched {
  const watched: Watched = { consoleErrors: [], pageErrors: [], failedResponses: [], hosts: new Set(), tryOnPosts: [] };
  page.on("console", (message) => {
    if (message.type() === "error") watched.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => watched.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) watched.failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    watched.hosts.add(new URL(request.url()).hostname);
    if (request.url().endsWith("/api/try-on") && request.method() === "POST") {
      watched.tryOnPosts.push(request.postDataBuffer()?.toString("latin1") ?? "");
    }
  });
  return watched;
}

/** Console errors that are not the browser reporting an intentionally failing try-on response. */
function unexpectedConsoleErrors(watched: Watched, { allowTryOnFailure = false } = {}) {
  return watched.consoleErrors.filter(
    (text) => !(allowTryOnFailure && /Failed to load resource: the server responded with a status of (4|5)\d\d/.test(text)),
  );
}

async function assertPageQuality(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);
}

/** Chooses the only colour and size, then adds to the bag: the purchase flow try-on must never disturb. */
async function addToBagAndExpectConfirmation(page: Page) {
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  await panel.getByRole("group", { name: /Màu/ }).getByText("Đen", { exact: true }).click();
  await panel.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();
  await panel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true }).click();
  await expect(page.getByText("Đã thêm sản phẩm vào giỏ hàng.", { exact: true })).toBeVisible();
}

/**
 * A guest gets one attempt a minute, so a test that generates twice presents as a new visitor for
 * the second. Quota behaviour itself is tested below, through the endpoint, not through this.
 */
async function asNewGuest(page: Page) {
  clientCounter += 1;
  await page.context().setExtraHTTPHeaders({ "x-ci-client-ip": `198.51.100.${clientCounter}` });
}

function triggerOf(page: Page) {
  // "Thử đồ" on a phone, "Thử đồ bằng ảnh của bạn" from the `sm` breakpoint up.
  return page.getByRole("button", { name: /^Thử đồ/ });
}
function dialogOf(page: Page) {
  return page.getByRole("dialog", { name: "Thử đồ" });
}

async function openTryOn(page: Page, baseUrl = ENABLED_URL, slug = slugs.eligible) {
  await page.goto(`${baseUrl}/shop/${slug}`, { waitUntil: "networkidle" });
  await triggerOf(page).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

function parts(dialog: Locator) {
  return {
    // Step 1
    photo: dialog.getByLabel(/ảnh của bạn/i),
    next: dialog.getByRole("button", { name: "Tiếp tục", exact: true }),
    preview: dialog.getByRole("img", { name: "Ảnh bạn đã chọn" }),
    // Step 2
    adult: dialog.getByRole("radio", { name: "Từ 18 tuổi" }),
    teen: dialog.getByRole("radio", { name: "13–17 tuổi" }),
    below: dialog.getByRole("radio", { name: "Chưa đủ tuổi" }),
    acknowledge: dialog.getByRole("checkbox", { name: /Tôi xác nhận đây là ảnh của tôi/ }),
    generate: dialog.getByRole("button", { name: "Tạo ảnh thử đồ", exact: true }),
    changePhoto: dialog.getByRole("button", { name: "Đổi", exact: true }),
    // Step 3
    retry: dialog.getByRole("button", { name: "Tạo lại", exact: true }),
    back: dialog.getByRole("button", { name: "Quay lại", exact: true }),
    otherPhoto: dialog.getByRole("button", { name: "Dùng ảnh khác", exact: true }),
    result: dialog.getByRole("img", { name: /Ảnh thử đồ do AI tạo/ }),
    status: dialog.getByRole("status"),
    alert: dialog.getByRole("alert"),
    attestation: dialog.getByText("Tôi từ 13 đến 17 tuổi, đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống và có sự cho phép của cha mẹ hoặc người giám hộ hợp pháp."),
    disclosure: dialog.getByText(/Ảnh này do AI tạo ra nên có thể chưa chính xác/),
  };
}

/** Step 1 to step 2: choose the photo and continue. */
async function choosePhotoAndContinue(dialog: Locator, photo = jpegPhoto()) {
  const { photo: input, next } = parts(dialog);
  await input.setInputFiles(photo);
  await next.click();
}

/** The age chips are visually hidden radios, so a click lands on the chip drawn over them. */
async function chooseAge(dialog: Locator, age: "adult" | "teen" | "below") {
  await parts(dialog)[age].check({ force: true });
}

/** Steps 1 and 2 up to, but not including, the generate button. */
async function fillThroughConfirmation(
  dialog: Locator,
  { photo = jpegPhoto(), age = "adult" }: { photo?: ReturnType<typeof jpegPhoto>; age?: "adult" | "teen" } = {},
) {
  await choosePhotoAndContinue(dialog, photo);
  await chooseAge(dialog, age);
  await parts(dialog).acknowledge.check();
}

// --- eligibility ------------------------------------------------------------------------------

test("an eligible apparel PDP offers Thử đồ at phone and desktop widths, on the size-guide line", async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${ENABLED_URL}/shop/${slugs.eligible}`, { waitUntil: "networkidle" });
  const sizeGuide = page.getByRole("button", { name: "Hướng dẫn chọn size", exact: true });

  async function expectOnSizeGuideLine() {
    await expect(triggerOf(page)).toBeVisible();
    await expect(sizeGuide).toBeVisible();
    const [trigger, guide] = await Promise.all([triggerOf(page).boundingBox(), sizeGuide.boundingBox()]);
    // Same line: the try-on entry point adds no row of its own to the purchase panel.
    expect(Math.abs(trigger!.y + trigger!.height / 2 - (guide!.y + guide!.height / 2))).toBeLessThan(8);
    expect(trigger!.x).toBeGreaterThan(guide!.x + guide!.width);
  }

  await expectOnSizeGuideLine();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeEnabled();
  await assertPageQuality(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expectOnSizeGuideLine();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeVisible();
  await assertPageQuality(page);

  expect(watched.pageErrors).toEqual([]);
  expect(watched.failedResponses).toEqual([]);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
  // The garment image is chosen by the server; the PDP render makes no try-on or Google request.
  expect(predictCalls()).toHaveLength(0);
  expect(tryOnProductFetches()).toHaveLength(0);
});

test("accessory, uncategorised and WebP-first products do not offer Thử đồ", async ({ page }) => {
  for (const slug of [slugs.accessory, slugs.uncategorised, slugs.webpFirst]) {
    await page.goto(`${ENABLED_URL}/shop/${slug}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeVisible();
    await expect(triggerOf(page)).toHaveCount(0);
  }
});

test("with the kill switch off the PDP is unchanged, shows no Thử đồ, and the endpoint is closed", async ({
  page,
  request,
}) => {
  await page.goto(`${DISABLED_URL}/shop/${slugs.eligible}`, { waitUntil: "networkidle" });
  await expect(triggerOf(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeEnabled();
  await addToBagAndExpectConfirmation(page);
  await assertPageQuality(page);

  const response = await request.post(`${DISABLED_URL}/api/try-on`, {
    headers: { origin: DISABLED_URL, "x-ci-client-ip": "198.51.100.200" },
    multipart: {
      photo: jpegPhoto(),
      productSlug: slugs.eligible,
      likenessAcknowledged: "true",
      ageState: "adult",
    },
  });
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ ok: false, reason: "UNAVAILABLE" });
  expect(predictCalls()).toHaveLength(0);
});

// --- dialog behaviour ------------------------------------------------------------------------

test("the dialog opens, traps keyboard focus, closes with Escape and returns focus to Thử đồ", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, next } = parts(dialog);
  const closeButton = dialog.getByRole("button", { name: "Đóng", exact: true });

  // It is a bottom sheet on a phone and the first step is showing.
  await expect(dialog.getByRole("heading", { name: "Chọn ảnh của bạn" })).toBeVisible();
  await expect(dialog.getByText("Bước 1/3")).toBeVisible();
  await expect(next).toBeDisabled();
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 1);

  // Keyboard-only: Tab walks the dialog's own controls and never leaves it.
  await closeButton.focus();
  await page.keyboard.press("Tab");
  await expect(photo).toBeFocused();
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(triggerOf(page)).toBeFocused();

  // Reopen with the keyboard, then close with the visible control.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await closeButton.click();
  await expect(dialog).toBeHidden();
  await expect(triggerOf(page)).toBeFocused();

  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

test("moving between steps moves focus to the new step's heading, and the steps keep what was chosen", async ({
  page,
}) => {
  const dialog = await openTryOn(page);
  const { photo, preview, next, adult, acknowledge, changePhoto } = parts(dialog);

  await photo.setInputFiles(jpegPhoto());
  await next.click();
  const confirmHeading = dialog.getByRole("heading", { name: "Độ tuổi và xác nhận" });
  await expect(confirmHeading).toBeFocused();
  await expect(dialog.getByText("Bước 2/3")).toBeVisible();

  await chooseAge(dialog, "adult");
  await acknowledge.check();
  await changePhoto.click();
  await expect(dialog.getByRole("heading", { name: "Chọn ảnh của bạn" })).toBeFocused();
  // Going back keeps the photo; coming forward again keeps the age.
  await expect(preview).toBeVisible();
  await next.click();
  await expect(adult).toBeChecked();
});

test("closing discards the photo, the choices and the result", async ({ page }) => {
  const dialog = await openTryOn(page);
  const { result, preview, next, generate } = parts(dialog);
  await fillThroughConfirmation(dialog);
  await generate.click();
  await expect(result).toBeVisible();

  await page.keyboard.press("Escape");
  await triggerOf(page).click();
  // Back at step 1 with nothing carried over.
  await expect(dialog.getByRole("heading", { name: "Chọn ảnh của bạn" })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(result).toHaveCount(0);
  await expect(next).toBeDisabled();
});

// --- upload ------------------------------------------------------------------------------------

test("a JPEG or PNG shows a local preview; unsupported, oversized and non-image files are refused", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, preview, next, alert } = parts(dialog);

  await photo.setInputFiles(jpegPhoto());
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await preview.getAttribute("src")).toMatch(/^blob:/);
  await expect(next).toBeEnabled();

  await photo.setInputFiles(pngPhoto());
  await expect(preview).toBeVisible();
  await expect(next).toBeEnabled();

  await photo.setInputFiles({ name: "toi.webp", mimeType: "image/webp", buffer: Buffer.from("RIFFxxxxWEBPVP8 ") });
  await expect(alert).toHaveText("Ảnh phải là tệp JPG hoặc PNG hợp lệ.");
  await expect(preview).toHaveCount(0);
  await expect(next).toBeDisabled();

  await photo.setInputFiles({ name: "toi.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(alert).toHaveText("Ảnh phải là tệp JPG hoặc PNG hợp lệ.");

  await photo.setInputFiles({
    name: "lon.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.concat([Buffer.from(JPEG_BASE64, "base64"), Buffer.alloc(7 * 1024 * 1024 + 1)]),
  });
  await expect(alert).toHaveText("Ảnh vượt quá 7 MB. Vui lòng chọn ảnh nhỏ hơn.");
  await expect(preview).toHaveCount(0);
  await expect(next).toBeDisabled();

  await assertPageQuality(page);
  expect(watched.tryOnPosts).toHaveLength(0);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

// --- gates --------------------------------------------------------------------------------------

test("generation stays unavailable until a photo, an allowed age and the acknowledgement are all present", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { next, acknowledge, generate } = parts(dialog);

  // Step 2 cannot even be reached without a photo.
  await expect(next).toBeDisabled();
  await choosePhotoAndContinue(dialog);
  await expect(generate).toBeDisabled();
  await acknowledge.check();
  await expect(generate).toBeDisabled();
  await expect(dialog.getByText(/hãy chọn độ tuổi/)).toBeVisible();
  await chooseAge(dialog, "adult");
  await expect(generate).toBeEnabled();
  await acknowledge.uncheck();
  await expect(generate).toBeDisabled();
  expect(watched.tryOnPosts).toHaveLength(0);
});

test("the blocked age state cannot generate and sends nothing", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { acknowledge, generate, alert } = parts(dialog);

  await choosePhotoAndContinue(dialog);
  await acknowledge.check();
  await chooseAge(dialog, "below");
  await expect(generate).toBeDisabled();
  await expect(alert).toContainText("Tính năng thử đồ chưa dành cho bạn");
  await assertPageQuality(page);

  expect(watched.tryOnPosts).toHaveLength(0);
  expect(predictCalls()).toHaveLength(0);
});

test("the teen path states the full attestation under a short chip and shows the AI disclosure, also with the result", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { generate, result, attestation, disclosure, acknowledge } = parts(dialog);

  await choosePhotoAndContinue(dialog);
  // Nothing about teens until the teen chip is chosen, and the chip itself is only a short label.
  await expect(attestation).toHaveCount(0);
  await expect(disclosure).toHaveCount(0);
  await chooseAge(dialog, "adult");
  await expect(attestation).toHaveCount(0);
  await chooseAge(dialog, "teen");
  await expect(dialog.getByText("Khi chọn mục này, bạn xác nhận:")).toBeVisible();
  await expect(attestation).toBeVisible();
  await expect(disclosure).toBeVisible();
  const teenText = await attestation.textContent();
  expect(teenText).toContain("đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống");
  expect(teenText).toContain("sự cho phép của cha mẹ hoặc người giám hộ hợp pháp");
  await assertPageQuality(page);

  await acknowledge.check();
  await generate.click();
  await expect(result).toBeVisible();
  // The disclosure is still with the image it is about.
  await expect(disclosure).toBeVisible();

  const calls = predictCalls();
  expect(calls).toHaveLength(1);
  // `allow-all` is what lets the approved teen path through; the strict safety filter stays on.
  expect(calls[0]).toMatchObject({ personGeneration: "allow-all", safetySetting: "block-low-and-above" });
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

// --- generation ---------------------------------------------------------------------------------

test("an adult generation shows loading, exactly one result, a download, and requires a fresh acknowledgement to run again", async ({
  page,
}) => {
  const watched = watch(page);
  // Playwright cannot read a multipart body that carries a file, so record what the page submits.
  await page.addInitScript(() => {
    const original = window.fetch;
    (window as unknown as { __tryOnSubmissions: Array<Record<string, string>> }).__tryOnSubmissions = [];
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/try-on") && init?.body instanceof FormData) {
        const entries: Record<string, string> = {};
        for (const [key, value] of init.body.entries()) entries[key] = typeof value === "string" ? value : "[file]";
        (window as unknown as { __tryOnSubmissions: Array<Record<string, string>> }).__tryOnSubmissions.push(entries);
      }
      return original(input, init);
    };
  });
  const dialog = await openTryOn(page);
  const { adult, acknowledge, generate, retry, result, status } = parts(dialog);

  await fillThroughConfirmation(dialog, { photo: jpegPhoto("slow") });
  await generate.click();

  // Step 3, loading: the form is gone, so there is nothing to edit while the request runs.
  await expect(dialog.getByText("Bước 3/3")).toBeVisible();
  await expect(status).toContainText("Đang tạo ảnh thử đồ");
  await expect(adult).toHaveCount(0);
  await expect(acknowledge).toHaveCount(0);
  await expect(generate).toHaveCount(0);
  await assertPageQuality(page);

  await expect(result).toBeVisible();
  await expect(dialog.getByRole("img", { name: /Ảnh thử đồ do AI tạo/ })).toHaveCount(1);
  await expect(status).toContainText("Đã tạo xong ảnh thử đồ.");
  await expect.poll(() => result.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await result.getAttribute("alt")).toContain(PRODUCT_NAME);
  await expect(dialog.getByText(/chỉ mang tính tham khảo — không đảm bảo kích cỡ/)).toBeVisible();

  const download = dialog.getByRole("link", { name: "Tải ảnh" });
  await expect(download).toHaveAttribute("download", `thu-do-${slugs.eligible}.png`);
  const [downloaded] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(downloaded.suggestedFilename()).toBe(`thu-do-${slugs.eligible}.png`);

  // One explicit action produced exactly one Vertex prediction with the spec's required contract,
  // and the garment sent was the server-resolved trusted product image.
  const calls = predictCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    pathOk: true,
    authorized: true,
    instances: 1,
    productImages: 1,
    garmentIsTrustedProduct: true,
    sampleCount: 1,
    personGeneration: "allow-all",
    safetySetting: "block-low-and-above",
    addWatermark: true,
    hasStorageUri: false,
  });
  expect(tryOnProductFetches()).toHaveLength(1);

  // Running again goes back to the confirmation step with the age kept and the acknowledgement
  // asked for afresh, before every generation.
  await retry.click();
  await expect(dialog.getByRole("heading", { name: "Độ tuổi và xác nhận" })).toBeFocused();
  await expect(adult).toBeChecked();
  await expect(acknowledge).not.toBeChecked();
  await expect(generate).toBeDisabled();
  await acknowledge.check();
  await asNewGuest(page);
  await generate.click();
  await expect(status).toContainText("Đã tạo xong ảnh thử đồ.");
  await expect(dialog.getByRole("img", { name: /Ảnh thử đồ do AI tạo/ })).toHaveCount(1);
  expect(predictCalls()).toHaveLength(2);

  // What the browser sent: the photo and three fields. No product URL, and no request to Google.
  expect(watched.tryOnPosts).toHaveLength(2);
  const submissions = await page.evaluate(
    () => (window as unknown as { __tryOnSubmissions: Array<Record<string, string>> }).__tryOnSubmissions,
  );
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual({
    photo: "[file]",
    productSlug: slugs.eligible,
    likenessAcknowledged: "true",
    ageState: "adult",
  });
  expect([...watched.hosts].filter((host) => /google|aiplatform/i.test(host))).toEqual([]);

  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await assertPageQuality(page);
});

test("while a generation runs the form is off screen and cannot change, so a late result matches what was sent", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, next, adult, teen, below, acknowledge, generate, retry, result, status, otherPhoto, preview } =
    parts(dialog);

  await fillThroughConfirmation(dialog, { photo: jpegPhoto("slow"), age: "teen" });
  await generate.click();
  await expect(status).toContainText("Đang tạo ảnh thử đồ");

  // None of the controls the request was built from is on screen, and there is no way back to them
  // until it settles; only "Đóng" remains.
  for (const control of [photo, next, adult, teen, below, acknowledge, generate, retry, otherPhoto, preview]) {
    await expect(control).toHaveCount(0);
  }
  await expect(dialog.getByRole("button", { name: "Đóng", exact: true })).toBeVisible();

  await expect(result).toBeVisible();
  expect(predictCalls()).toHaveLength(1);
  expect(predictCalls()[0]).toMatchObject({ personGeneration: "allow-all" });

  // The result is for the teen attestation that was sent, and going back finds it unchanged.
  await expect(parts(dialog).disclosure).toBeVisible();
  await retry.click();
  await expect(teen).toBeChecked();
  await expect(parts(dialog).attestation).toBeVisible();
  await expect(acknowledge).not.toBeChecked();

  // "Dùng ảnh khác" from a result goes back to choosing a photo, with the current one still shown.
  await acknowledge.check();
  await asNewGuest(page);
  await generate.click();
  await expect(result).toBeVisible();
  await otherPhoto.click();
  await expect(dialog.getByRole("heading", { name: "Chọn ảnh của bạn" })).toBeFocused();
  await expect(preview).toBeVisible();

  await assertPageQuality(page);
  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

test("a PNG upload generates a result at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = await openTryOn(page);
  const { generate, result } = parts(dialog);

  // From the `sm` breakpoint up it is a centred modal, not a bottom sheet.
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(441);
  expect(box.x).toBeGreaterThan(100);

  await fillThroughConfirmation(dialog, { photo: pngPhoto() });
  await generate.click();
  await expect(result).toBeVisible();
  await assertPageQuality(page);
});

test("a provider failure shows a safe message, goes back to confirm with nothing lost, and purchase still works afterwards", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { adult, acknowledge, generate, back, alert, preview } = parts(dialog);

  await fillThroughConfirmation(dialog, { photo: jpegPhoto("fail") });
  await generate.click();

  await expect(dialog.getByRole("heading", { name: "Chưa tạo được ảnh" })).toBeVisible();
  await expect(alert).toHaveText("Chưa tạo được ảnh thử đồ. Vui lòng thử lại.");
  await expect(alert).not.toContainText(/fixture|upstream|500|projects\//i);
  await assertPageQuality(page);

  // Going back stays in the same surface: the photo and age remain, only the acknowledgement is asked again.
  await back.click();
  await expect(preview).toBeVisible();
  await expect(adult).toBeChecked();
  await expect(acknowledge).not.toBeChecked();
  await acknowledge.check();
  await expect(generate).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The failure changed nothing about buying.
  await addToBagAndExpectConfirmation(page);

  expect(predictCalls()).toHaveLength(1);
  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched, { allowTryOnFailure: true })).toEqual([]);
});

test("a provider safety block fails closed: safe copy on the photo step, the photo is dropped, and nothing is retried", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { adult, acknowledge, generate, alert, preview, next } = parts(dialog);

  await fillThroughConfirmation(dialog, { photo: jpegPhoto("safety") });
  await generate.click();

  // Back at choosing a photo, with the explanation showing and the refused photo gone.
  await expect(dialog.getByRole("heading", { name: "Chọn ảnh của bạn" })).toBeVisible();
  await expect(alert).toContainText("Không thể tạo ảnh từ ảnh này. Vui lòng chọn một ảnh khác");
  await expect(alert).not.toContainText(/an toàn|safety|rai|filter|00000000/i);
  await expect(preview).toHaveCount(0);
  await expect(next).toBeDisabled();
  await assertPageQuality(page);

  // One attempt only: no automatic retry, no weaker settings.
  await delay(500);
  const calls = predictCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ safetySetting: "block-low-and-above", addWatermark: true });

  // A different photo is the way forward; the age is kept, the acknowledgement is asked again.
  await choosePhotoAndContinue(dialog, jpegPhoto("ok"));
  await expect(adult).toBeChecked();
  await expect(acknowledge).not.toBeChecked();
  await acknowledge.check();
  await asNewGuest(page);
  await generate.click();
  await expect(parts(dialog).result).toBeVisible();
  expect(predictCalls()).toHaveLength(2);

  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched, { allowTryOnFailure: true })).toEqual([]);
});

// --- server boundary (the same endpoint, called without the UI) ---------------------------------------

test.describe("the endpoint enforces the gates itself", () => {
  function form(overrides: Record<string, string | typeof jpegPhoto extends () => infer R ? R : never> = {}) {
    return {
      photo: jpegPhoto(),
      productSlug: slugs.eligible,
      likenessAcknowledged: "true",
      ageState: "adult",
      ...overrides,
    };
  }
  async function post(
    request: import("@playwright/test").APIRequestContext,
    multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>,
    ip: string,
    origin: string | null = ENABLED_URL,
  ) {
    return request.post(`${ENABLED_URL}/api/try-on`, {
      headers: { ...(origin === null ? {} : { origin }), "x-ci-client-ip": ip },
      multipart,
    });
  }

  test("likeness, age and photo are required server-side and never reach Vertex when missing or blocked", async ({
    request,
  }) => {
    const cases: Array<[Record<string, never> | Record<string, string>, number, string]> = [
      [{ likenessAcknowledged: "false" }, 400, "LIKENESS_REQUIRED"],
      [{ ageState: "below_digital_consent_age" }, 403, "AGE_BLOCKED"],
      [{ ageState: "child" }, 400, "AGE_STATE_INVALID"],
    ];
    let ip = 100;
    for (const [overrides, status, reason] of cases) {
      const response = await post(request, form(overrides as never), `198.51.100.${(ip += 1)}`);
      expect(response.status(), reason).toBe(status);
      expect(await response.json()).toEqual({ ok: false, reason });
    }

    const webp = await post(
      request,
      form({ photo: { name: "x.webp", mimeType: "image/webp", buffer: Buffer.from("RIFFxxxxWEBPVP8 ") } as never }),
      `198.51.100.${(ip += 1)}`,
    );
    expect(webp.status()).toBe(415);

    const forged = await post(
      request,
      form({ photo: { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html>not a jpeg</html>") } as never }),
      `198.51.100.${(ip += 1)}`,
    );
    expect(forged.status()).toBe(415);

    expect(predictCalls()).toHaveLength(0);
    expect(tryOnProductFetches()).toHaveLength(0);
  });

  test("non-eligible products are refused before any fetch or prediction", async ({ request }) => {
    let ip = 120;
    for (const slug of [slugs.accessory, slugs.webpFirst, slugs.uncategorised, "no-such-product"]) {
      const response = await post(request, form({ productSlug: slug }), `198.51.100.${(ip += 1)}`);
      expect(response.status(), slug).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
    }
    expect(predictCalls()).toHaveLength(0);
    expect(tryOnProductFetches()).toHaveLength(0);
  });

  test("a forged product-image URL is ignored: the server sends its own trusted first image", async ({ request }) => {
    const response = await post(
      request,
      {
        ...form(),
        productImageUrl: "https://evil.example/steal.jpg",
        imageUrl: "http://169.254.169.254/latest/meta-data",
      },
      "198.51.100.140",
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { ok: boolean; mimeType: string; imageBase64: string };
    expect(body.ok).toBe(true);
    expect(body.mimeType).toBe("image/png");
    expect(Buffer.from(body.imageBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(response.headers()["cache-control"]).toBe("no-store");

    expect(predictCalls()).toHaveLength(1);
    expect(predictCalls()[0]!.garmentIsTrustedProduct).toBe(true);
    const fetches = tryOnProductFetches();
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.path).toBe("/images/1/2/3/try-on-first.jpg");
  });

  test("a cross-site request is refused before it can spend quota", async ({ request }) => {
    const crossSite = await post(request, form(), "198.51.100.150", "https://evil.example");
    expect(crossSite.status()).toBe(403);
    const originless = await post(request, form(), "198.51.100.151", null);
    expect(originless.status()).toBe(403);
    expect(predictCalls()).toHaveLength(0);
  });

  test("a guest gets one attempt a minute; another visitor is unaffected", async ({ request }) => {
    const first = await post(request, form(), "198.51.100.160");
    expect(first.status()).toBe(200);
    const second = await post(request, form(), "198.51.100.160");
    expect(second.status()).toBe(429);
    expect(await second.json()).toEqual({ ok: false, reason: "RATE_LIMITED" });
    // The refused attempt reached neither the product fetch nor Vertex.
    expect(predictCalls()).toHaveLength(1);

    const other = await post(request, form(), "198.51.100.161");
    expect(other.status()).toBe(200);
  });

  test("a signed-in member has their own, larger quota: two a minute, independent of the address", async ({
    request,
  }) => {
    const ip = "198.51.100.170";
    // As a guest the address is spent after one attempt.
    expect((await post(request, form(), ip)).status()).toBe(200);
    expect((await post(request, form(), ip)).status()).toBe(429);

    // Signing in switches to the account's allowance, from the very same address.
    const signUp = await request.post(`${ENABLED_URL}/api/auth/sign-up/email`, {
      headers: { origin: ENABLED_URL, "x-ci-client-ip": ip },
      data: { name: "Try On Member", email: memberEmail, password: "try-on-member-password-1" },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    expect((await post(request, form(), ip)).status()).toBe(200);
    expect((await post(request, form(), ip)).status()).toBe(200);
    const third = await post(request, form(), ip);
    expect(third.status()).toBe(429);
    expect(await third.json()).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(predictCalls()).toHaveLength(3);
  });
});

test("a guest told to log in sees the sign-in link on the result step, and the dialog still closes cleanly", async ({
  page,
}) => {
  // The sixth guest attempt needs five spaced minutes of real time, so the server's answer is
  // stubbed here; the quota logic that produces it is covered by the limiter and service tests.
  await page.route("**/api/try-on", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, reason: "LOGIN_REQUIRED" }),
    }),
  );
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { generate, alert } = parts(dialog);
  await fillThroughConfirmation(dialog);
  await generate.click();

  await expect(alert).toContainText("5 lượt thử đồ");
  await expect(alert).toContainText("đăng nhập");
  const signIn = dialog.getByRole("link", { name: "Đăng nhập" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/login");
  await assertPageQuality(page);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await addToBagAndExpectConfirmation(page);
  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched, { allowTryOnFailure: true })).toEqual([]);
});
