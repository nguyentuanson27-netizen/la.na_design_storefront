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
        create: { status: "PUBLISHED", editorialDescription: "Sản phẩm thử nghiệm cho thử đồ." },
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

function triggerOf(page: Page) {
  return page.getByRole("button", { name: "Thử đồ", exact: true });
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
    photo: dialog.getByLabel(/Ảnh của bạn/),
    adult: dialog.getByRole("radio", { name: /từ 18 tuổi trở lên/ }),
    teen: dialog.getByRole("radio", { name: /từ 13 đến 17 tuổi/ }),
    below: dialog.getByRole("radio", { name: /chưa đủ tuổi đồng ý/ }),
    acknowledge: dialog.getByRole("checkbox", { name: /Tôi xác nhận đây là ảnh của tôi/ }),
    generate: dialog.getByRole("button", { name: /^(Tạo ảnh thử đồ|Tạo lại)$/ }),
    result: dialog.getByRole("img", { name: /Ảnh thử đồ do AI tạo/ }),
    status: dialog.getByRole("status"),
    alert: dialog.getByRole("alert"),
  };
}

// --- eligibility ------------------------------------------------------------------------------

test("an eligible apparel PDP offers Thử đồ at phone and desktop widths", async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${ENABLED_URL}/shop/${slugs.eligible}`, { waitUntil: "networkidle" });
  await expect(triggerOf(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true })).toBeEnabled();
  await assertPageQuality(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(triggerOf(page)).toBeVisible();
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
  const { photo, generate } = parts(dialog);
  const closeButton = dialog.getByRole("button", { name: "Đóng", exact: true });

  // Keyboard-only: Tab walks the dialog's own controls in reading order and never leaves it.
  await closeButton.focus();
  await page.keyboard.press("Tab");
  await expect(photo).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type)).toBe("radio");
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await expect(generate).toBeDisabled();

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

test("closing discards the photo, the choices and the result", async ({ page }) => {
  const dialog = await openTryOn(page);
  const { photo, adult, acknowledge, generate, result } = parts(dialog);
  await photo.setInputFiles(jpegPhoto());
  await adult.check();
  await acknowledge.check();
  await generate.click();
  await expect(result).toBeVisible();

  await page.keyboard.press("Escape");
  await triggerOf(page).click();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(adult).not.toBeChecked();
  await expect(acknowledge).not.toBeChecked();
  await expect(generate).toBeDisabled();
});

// --- upload ------------------------------------------------------------------------------------

test("a JPEG or PNG shows a local preview; unsupported, oversized and non-image files are refused", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, alert } = parts(dialog);
  const preview = dialog.getByRole("img", { name: "Ảnh bạn đã chọn" });

  await photo.setInputFiles(jpegPhoto());
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await preview.getAttribute("src")).toMatch(/^blob:/);

  await photo.setInputFiles(pngPhoto());
  await expect(preview).toBeVisible();

  await photo.setInputFiles({ name: "toi.webp", mimeType: "image/webp", buffer: Buffer.from("RIFFxxxxWEBPVP8 ") });
  await expect(alert).toHaveText("Ảnh phải là tệp JPG hoặc PNG hợp lệ.");
  await expect(preview).toHaveCount(0);

  await photo.setInputFiles({ name: "toi.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(alert).toHaveText("Ảnh phải là tệp JPG hoặc PNG hợp lệ.");

  await photo.setInputFiles({
    name: "lon.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.concat([Buffer.from(JPEG_BASE64, "base64"), Buffer.alloc(7 * 1024 * 1024 + 1)]),
  });
  await expect(alert).toHaveText("Ảnh vượt quá 7 MB. Vui lòng chọn ảnh nhỏ hơn.");
  await expect(preview).toHaveCount(0);

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
  const { photo, adult, acknowledge, generate } = parts(dialog);

  await expect(generate).toBeDisabled();
  await photo.setInputFiles(jpegPhoto());
  await expect(generate).toBeDisabled();
  await acknowledge.check();
  await expect(generate).toBeDisabled();
  await expect(dialog.getByText(/hãy chọn độ tuổi/)).toBeVisible();
  await adult.check();
  await expect(generate).toBeEnabled();
  await acknowledge.uncheck();
  await expect(generate).toBeDisabled();
  expect(watched.tryOnPosts).toHaveLength(0);
});

test("the blocked age state cannot generate and sends nothing", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, below, acknowledge, generate, alert } = parts(dialog);

  await photo.setInputFiles(jpegPhoto());
  await acknowledge.check();
  await below.check();
  await expect(generate).toBeDisabled();
  await expect(alert).toContainText("Tính năng thử đồ chưa dành cho bạn");
  await assertPageQuality(page);

  expect(watched.tryOnPosts).toHaveLength(0);
  expect(predictCalls()).toHaveLength(0);
});

test("the teen path states the digital-consent-age and guardian attestation and shows the AI disclosure", async ({
  page,
}) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, teen, adult, acknowledge, generate, result } = parts(dialog);

  await expect(dialog.getByText(/Ảnh này do AI tạo ra nên có thể chưa chính xác/)).toHaveCount(0);
  await expect(teen).toBeVisible();
  const label = (await dialog.getByText(/từ 13 đến 17 tuổi/).textContent()) ?? "";
  expect(label).toContain("đã đủ tuổi đồng ý xử lý dữ liệu số theo quy định nơi tôi sống");
  expect(label).toContain("sự cho phép của cha mẹ hoặc người giám hộ hợp pháp");

  await adult.check();
  await expect(dialog.getByText(/Ảnh này do AI tạo ra nên có thể chưa chính xác/)).toHaveCount(0);
  await teen.check();
  await expect(dialog.getByText(/Ảnh này do AI tạo ra nên có thể chưa chính xác/)).toBeVisible();
  await expect(dialog.getByText(/không dùng ảnh này để đánh giá cơ thể|Đừng dùng ảnh này để đánh giá cơ thể/)).toBeVisible();
  await assertPageQuality(page);

  await photo.setInputFiles(jpegPhoto());
  await acknowledge.check();
  await generate.click();
  await expect(result).toBeVisible();

  const calls = predictCalls();
  expect(calls).toHaveLength(1);
  // `allow-all` is what lets the approved teen path through; the strict safety filter stays on.
  expect(calls[0]).toMatchObject({ personGeneration: "allow-all", safetySetting: "block-low-and-above" });
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

// --- generation ---------------------------------------------------------------------------------

test("an adult generation shows loading, exactly one result, a download, and requires a fresh acknowledgement to retry", async ({
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
  const { photo, adult, acknowledge, generate, result, status } = parts(dialog);

  await photo.setInputFiles(jpegPhoto("slow"));
  await adult.check();
  await acknowledge.check();
  await generate.click();

  await expect(status).toContainText("Đang tạo ảnh thử đồ");
  await expect(generate).toBeDisabled();
  await expect(generate).toHaveAttribute("aria-busy", "true");
  await assertPageQuality(page);

  await expect(result).toBeVisible();
  await expect(dialog.getByRole("img", { name: /Ảnh thử đồ do AI tạo/ })).toHaveCount(1);
  await expect(status).toContainText("Đã tạo xong ảnh thử đồ.");
  await expect.poll(() => result.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await result.getAttribute("alt")).toContain(PRODUCT_NAME);
  await expect(dialog.getByText(/chỉ mang tính tham khảo, không đảm bảo kích cỡ/)).toBeVisible();

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

  // The acknowledgement is asked for again before every generation.
  await expect(acknowledge).not.toBeChecked();
  await expect(generate).toHaveText("Tạo lại");
  await expect(generate).toBeDisabled();
  await acknowledge.check();
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

test("the form is frozen while a generation runs, so a late result can never disagree with it", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, adult, teen, below, acknowledge, generate, result, status } = parts(dialog);
  const disclosure = dialog.getByText(/Ảnh này do AI tạo ra nên có thể chưa chính xác/);
  const preview = dialog.getByRole("img", { name: "Ảnh bạn đã chọn" });

  await photo.setInputFiles(jpegPhoto("slow"));
  await teen.check();
  await acknowledge.check();
  await expect(disclosure).toBeVisible();
  await generate.click();
  await expect(status).toContainText("Đang tạo ảnh thử đồ");

  // Everything the request was built from is locked until it settles: the photo, the age
  // attestation and the acknowledgement cannot change underneath a request already in flight.
  await expect(photo).toBeDisabled();
  await expect(adult).toBeDisabled();
  await expect(teen).toBeDisabled();
  await expect(below).toBeDisabled();
  await expect(acknowledge).toBeDisabled();
  await expect(teen).toBeChecked();
  await expect(disclosure).toBeVisible();
  await expect(preview).toBeVisible();
  // The visible "Chọn ảnh" button is the label of the disabled input, so it cannot reopen the picker.
  const chooser = await Promise.race([
    page.waitForEvent("filechooser").then(() => "opened"),
    dialog.getByText("Chọn ảnh", { exact: true }).click({ force: true }).then(() => delay(300)).then(() => "none"),
  ]);
  expect(chooser).toBe("none");
  await expect(teen).toBeChecked();

  await expect(result).toBeVisible();
  // The result belongs to exactly the state that is still on screen.
  await expect(teen).toBeChecked();
  await expect(disclosure).toBeVisible();
  await expect(preview).toBeVisible();
  expect(predictCalls()).toHaveLength(1);
  expect(predictCalls()[0]).toMatchObject({ personGeneration: "allow-all" });

  // Unlocked again once settled.
  await expect(photo).toBeEnabled();
  await expect(adult).toBeEnabled();
  await expect(acknowledge).toBeEnabled();
  await adult.check();
  await expect(disclosure).toHaveCount(0);

  await assertPageQuality(page);
  expect(watched.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(watched)).toEqual([]);
});

test("a PNG upload generates a result at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = await openTryOn(page);
  const { photo, adult, acknowledge, generate, result } = parts(dialog);
  await photo.setInputFiles(pngPhoto());
  await adult.check();
  await acknowledge.check();
  await generate.click();
  await expect(result).toBeVisible();
  await assertPageQuality(page);
});

test("a provider failure shows a safe, retryable message and purchase still works afterwards", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, adult, acknowledge, generate, alert } = parts(dialog);

  await photo.setInputFiles(jpegPhoto("fail"));
  await adult.check();
  await acknowledge.check();
  await generate.click();

  await expect(alert).toHaveText("Chưa tạo được ảnh thử đồ. Vui lòng thử lại.");
  await expect(alert).not.toContainText(/fixture|upstream|500|projects\//i);
  await assertPageQuality(page);

  // Retry stays in the same surface: the photo and age remain, only the acknowledgement is asked again.
  await expect(dialog.getByRole("img", { name: "Ảnh bạn đã chọn" })).toBeVisible();
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

test("a provider safety block fails closed: safe copy, the photo is dropped, and nothing is retried", async ({ page }) => {
  const watched = watch(page);
  const dialog = await openTryOn(page);
  const { photo, adult, acknowledge, generate, alert } = parts(dialog);

  await photo.setInputFiles(jpegPhoto("safety"));
  await adult.check();
  await acknowledge.check();
  await generate.click();

  await expect(alert).toContainText("Không thể tạo ảnh từ ảnh này. Vui lòng chọn một ảnh khác");
  await expect(alert).not.toContainText(/an toàn|safety|rai|filter|00000000/i);
  await expect(dialog.getByRole("img", { name: "Ảnh bạn đã chọn" })).toHaveCount(0);
  await expect(generate).toBeDisabled();
  await assertPageQuality(page);

  // One attempt only: no automatic retry, no weaker settings.
  await delay(500);
  const calls = predictCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ safetySetting: "block-low-and-above", addWatermark: true });

  // A different photo is the way forward.
  await photo.setInputFiles(jpegPhoto("ok"));
  await acknowledge.check();
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

  test("a client is rate limited after its attempts, and another client is not", async ({ request }) => {
    const ip = "198.51.100.160";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await post(request, form(), ip)).status());
    }
    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses[6]).toBe(429);
    expect(predictCalls()).toHaveLength(6);

    const other = await post(request, form(), "198.51.100.161");
    expect(other.status()).toBe(200);
  });
});
