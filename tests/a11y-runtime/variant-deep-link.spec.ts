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
const PORT = 3335;
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

/**
 * The photograph the shopper is actually looking at.
 *
 * These tests run at a phone viewport, where the mobile spec replaced the editorial grid with a
 * one-image-at-a-time gallery. The visible image is the variant's current lead image, which is the
 * same fact the old `[aria-label^="Bộ sưu tập hình ảnh "]` lead image carried.
 */
function heroImage(page: Page) {
  return page.locator(".pdp-mobile-gallery__image img").first();
}

async function expectHeroToShow(page: Page, urlFragment: string) {
  await expect(heroImage(page)).toHaveAttribute(
    "src",
    new RegExp(encodeURIComponent(urlFragment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
}

async function expectProductHeroToShow(page: Page, urlFragment: string) {
  // The canonical first surface, whichever composition this viewport renders.
  const image = page
    .getByRole("region", { name: `Ảnh chính của ${productName}` })
    .locator("img:visible")
    .first();
  await expect(image).toHaveAttribute(
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
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/variant-deep-link",
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
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchasePanel.getByText(/890\.000/)).toBeVisible();
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();

  /*
   * The deep link preselects the variant; it does not replace the canonical first surface. The
   * mobile spec states this for the phone gallery in the same terms the desktop refinement states
   * it for the stage, so `u12b-medium.jpg` -- image 2 -- is reached by choosing, not by landing.
   */
  await expectHeroToShow(page, "u12b-primary.jpg");

  expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual([]);
  await assertPageQuality(page);
});

test("a different variation opens on its own price and the canonical photo, then follows the shopper's choice", async ({
  page,
}) => {
  await openDeepLink(page, LARGE_VARIATION);

  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchasePanel.getByText(/910\.000/)).toBeVisible();

  // Its own price on load, but the canonical first photograph -- the deep link preselects, it does
  // not re-open the gallery somewhere else.
  await expectHeroToShow(page, "u12b-primary.jpg");

  /*
   * What does move the gallery is an explicit post-load selection change, through the same seam
   * the desktop stage uses. Choosing M from a page deep-linked to L is a change, so the phone
   * gallery syncs to M's mapped photograph.
   */
  await page.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  await expectHeroToShow(page, "u12b-medium.jpg");
});

test("a sold-out variation stays addressable, shows its exact price and refuses add-to-bag", async ({
  page,
}) => {
  await openDeepLink(page, SOLD_OUT_VARIATION);

  await expect(page.getByRole("radio", { name: "XL", exact: true })).toBeChecked();
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  // Its own exact price, not the product's "from" range: the shopper asked about this variant.
  await expect(purchasePanel.getByText(/777\.000/)).toBeVisible();
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeDisabled();
  await expect(purchasePanel.getByRole("status")).toHaveText("Hết hàng");
  await assertPageQuality(page);
});

test("a forged variation degrades to the ordinary product page", async ({ page }) => {
  await openDeepLink(page, `u12b-forged-${runId}`);

  for (const name of ["Đen", "M", "L", "XL"]) {
    await expect(page.getByRole("radio", { name, exact: true })).not.toBeChecked();
  }
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchasePanel.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();
  await expectProductHeroToShow(page, "u12b-primary.jpg");
});

test("the shopper's own choice takes the selection back from the URL", async ({ page }) => {
  await openDeepLink(page, MEDIUM_VARIATION);
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();

  // Click the visible label the way a shopper does; the radio itself is the sr-only peer input.
  await page.getByText("L", { exact: true }).click();

  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "M", exact: true })).not.toBeChecked();
  const purchasePanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await expect(purchasePanel.getByText(/910\.000/)).toBeVisible();
  // The preselection is an initial value, not a controlled prop, so the URL must not snap back.
  expect(new URL(page.url()).searchParams.get("variant")).toBe(MEDIUM_VARIATION);
});

test("the desktop stage opens on slide 1 for a later-media deep link, then follows the next selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDeepLink(page, MEDIUM_VARIATION);

  const stage = page.getByRole("region", { name: `Ảnh chính của ${productName}` });
  const slides = stage.locator(".pdp-stage__slide");
  const activeSlide = async () =>
    slides.evaluateAll((elements) =>
      elements.findIndex((element) => element.getAttribute("data-active") === "true"),
    );

  /*
   * Refinement spec §2, the priority the owner settled.
   *
   * Variants are read in `pancakeVariationId` order, so the gallery is primary, large, medium:
   * `u12b-medium.jpg` is image 3 and lives on the second page (`2+3`). The deep link still
   * preselects M -- the panel proves that below -- but the first visible surface on load is the
   * canonical one, with `u12b-primary.jpg` leading it.
   */
  expect(await activeSlide(), "a deep link does not replace the canonical first surface").toBe(0);
  await expect(
    slides.first().locator("img").first(),
  ).toHaveAttribute("src", /u12b-primary/);
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();

  // After load, an explicit selection change is what moves the stage. L's photograph is image 2,
  // already on the first page, so choosing it leaves the stage where it is...
  await page.getByText("L", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "L", exact: true })).toBeChecked();
  expect(await activeSlide(), "a change to an image on the current page keeps the page").toBe(0);

  // ...and choosing M again is a change to image 3, which moves the stage to the page holding it.
  await page.getByRole("group", { name: "Kích cỡ" }).getByText("M", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  await expect
    .poll(activeSlide, { message: "a post-load variant change syncs to its mapped slide" })
    .toBe(1);

  // ...and the shopper's own navigation then holds until the selection changes again.
  await stage.getByRole("button", { name: "Ảnh trước" }).click();
  expect(await activeSlide()).toBe(0);
  await expect(page.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  await expect.poll(activeSlide, { message: "an unchanged selection does not reclaim the frame" }).toBe(0);
});
