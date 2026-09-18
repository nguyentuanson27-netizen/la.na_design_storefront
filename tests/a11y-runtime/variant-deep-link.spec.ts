/**
 * U12 / M2 — `/shop/<slug>?variant=<pancakeVariationId>` in a real browser.
 *
 * The HTTP smoke proves the served markup. This proves the part only a browser can: that the
 * server-resolved preselection survives hydration instead of being reset by the client's own
 * initial state, that add-to-bag reflects the selected variant's real availability, and that the
 * shopper's first interaction takes ownership of the selection back from the URL.
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
const PORT = 3225;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_025;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-08-13T05:00:00.000Z");

const slug = `u12-browser-deep-link-${runId}`;
const productName = `U12 Browser Deep Link Overshirt ${runId}`;

const MEDIUM_VARIATION = `u12b-pv-medium-${runId}`;
const LARGE_VARIATION = `u12b-pv-large-${runId}`;
const SOLD_OUT_VARIATION = `u12b-pv-soldout-${runId}`;

const MEDIUM_PRICE = 890_000;
const LARGE_PRICE = 910_000;
const SOLD_OUT_PRICE = 777_000;

const PRIMARY_IMAGE = "https://content.pancake.vn/images/9/9/9/u12b-primary.jpg";
const MEDIUM_IMAGE = "https://content.pancake.vn/images/9/9/9/u12b-medium.jpg";
const LARGE_IMAGE = "https://content.pancake.vn/images/9/9/9/u12b-large.jpg";

// 1x1 JPEG so the optimizer route can be fulfilled offline and deterministically.
const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js deep-link server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop/${slug}`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which requests Better Auth's catch-all route
      // as soon as it hydrates. A page-only readiness probe can win the race against a freshly
      // started `next dev` and let Playwright navigate while that route still answers a transient
      // 404, which the browser's clean-console guard then correctly records. Declare the fixture
      // ready only once the page and the route it immediately depends on are both live; the
      // assertion itself stays strict.
      if (
        pageResponse.status === 200 &&
        authResponse.status === 200 &&
        (await pageResponse.text()).includes(productName)
      ) {
        return;
      }
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the deep-link server\n${serverOutput}`);
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

async function cleanup() {
  await prisma.cartItem.deleteMany({
    where: { variant: { product: { pancakeShopId: SHOP_ID } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/** The hero frame the gallery is currently showing, whatever index it landed on. */
function heroImage(page: Page) {
  return page.locator('[aria-roledescription="carousel"] img').first();
}

async function expectHeroToShow(page: Page, urlFragment: string) {
  await expect(heroImage(page)).toHaveAttribute(
    "src",
    new RegExp(encodeURIComponent(urlFragment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

async function openDeepLink(page: Page, query: string | null) {
  // Offline-safe: the optimizer would otherwise reach content.pancake.vn.
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
  await page.goto(
    query === null ? `${BASE_URL}/shop/${slug}` : `${BASE_URL}/shop/${slug}?variant=${query}`,
    { waitUntil: "networkidle" },
  );
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
}

async function assertPageQuality(page: Page) {
  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
}

test.beforeAll(async () => {
  await cleanup();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `u12b-product-${runId}`,
      slug,
      name: productName,
      primaryImageUrl: PRIMARY_IMAGE,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { editorialDescription: "Variant deep-link browser regression." } },
    },
  });

  async function seedVariant(
    pancakeVariationId: string,
    size: string,
    price: number,
    options: Readonly<{ stock: number; imageUrl?: string }>,
  ) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId,
        productId: product.id,
        color: "Đen",
        size,
        pancakeRetailPrice: price,
        pancakeRetailPriceAfterDiscount: price,
        ...(options.imageUrl ? { pancakeImageUrls: [options.imageUrl] } : {}),
        isPresent: true,
        isActive: true,
        syncedAt,
      },
    });
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `u12b-wh-${pancakeVariationId}`,
        quantity: options.stock,
        syncedAt,
      },
    });
  }

  await seedVariant(MEDIUM_VARIATION, "M", MEDIUM_PRICE, { stock: 5, imageUrl: MEDIUM_IMAGE });
  await seedVariant(LARGE_VARIATION, "L", LARGE_PRICE, { stock: 4, imageUrl: LARGE_IMAGE });
  await seedVariant(SOLD_OUT_VARIATION, "XL", SOLD_OUT_PRICE, { stock: 0 });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
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

test("a valid deep link survives hydration with its own option, price and photo", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await openDeepLink(page, MEDIUM_VARIATION);

  // Checked *after* hydration is the point of this test: a client-side reset would clear these.
  await expect(page.getByRole("radio", { name: "Đen", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "L", exact: true })).not.toBeChecked();
  await expect(page.getByText(/890\.000/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();
  await expectHeroToShow(page, "u12b-medium.jpg");

  expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual([]);
  await assertPageQuality(page);
});

test("a different variation opens on its own photo and price, not the first one's", async ({ page }) => {
  await openDeepLink(page, LARGE_VARIATION);

  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  await expect(page.getByText(/910\.000/)).toBeVisible();
  await expectHeroToShow(page, "u12b-large.jpg");
});

test("a sold-out variation stays addressable, shows its exact price and refuses add-to-bag", async ({
  page,
}) => {
  await openDeepLink(page, SOLD_OUT_VARIATION);

  await expect(page.getByRole("radio", { name: "XL", exact: true })).toBeChecked();
  // Its own exact price, not the product's "from" range: the shopper asked about this variant.
  await expect(page.getByText(/777\.000/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Lựa chọn này đã hết hàng.");
  await assertPageQuality(page);
});

test("a forged variation degrades to the ordinary product page", async ({ page }) => {
  await openDeepLink(page, `u12b-forged-${runId}`);

  for (const name of ["Đen", "M", "L", "XL"]) {
    await expect(page.getByRole("radio", { name, exact: true })).not.toBeChecked();
  }
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeDisabled();
  await expectHeroToShow(page, "u12b-primary.jpg");
});

test("the shopper's own choice takes the selection back from the URL", async ({ page }) => {
  await openDeepLink(page, MEDIUM_VARIATION);
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();

  // Click the visible label the way a shopper does; the radio itself is the sr-only peer input.
  await page.getByText("L", { exact: true }).click();

  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  await expect(page.getByText(/910\.000/)).toBeVisible();
  // The preselection is an initial value, not a controlled prop, so the URL must not snap back.
  expect(new URL(page.url()).searchParams.get("variant")).toBe(MEDIUM_VARIATION);
});
