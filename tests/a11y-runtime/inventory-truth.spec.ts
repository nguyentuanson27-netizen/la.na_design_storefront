import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";
import { expectSettledDocumentTitle, watchDocumentTitle } from "./document-title-watch.ts";

/**
 * F8a + F8b in a real browser: what a shopper actually reads, from the card to checkout.
 *
 * The domain suites prove the projection reaches the right verdict. This proves the verdict reaches
 * the page — that the word is rendered, that the disabled option is still there to be seen, that
 * the marker survives add-to-cart and the trip to checkout, and that an oversell sale is
 * indistinguishable from ready stock all the way through.
 *
 * Four products, one per state, seeded with real `ProductSellingPolicy` rows. Nothing here sets a
 * preorder flag directly: each product's state is a policy and a stock level, exactly as an owner
 * would configure it, so a surface that re-derived the rule differently would show up here.
 */

const HOST = "127.0.0.1";
const PORT = 3321;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_011;
// Deliberately hyphen-free. The oversell case asserts that no negative quantity is rendered, and
// a run id of the shape `<millis>-<pid>` puts a literal `-5` into the product name whenever the
// runner's pid starts with 5 — which is exactly how this spec failed on CI while passing locally.
const runId = `${Date.now()}${process.pid}`;

const PREORDER = "Đặt trước";
const OUT_OF_STOCK = "Hết hàng";
const FLOOR = -20;

const slugs = {
  ready: `inv-ready-${runId}`,
  preorder: `inv-preorder-${runId}`,
  oversell: `inv-oversell-${runId}`,
  soldOut: `inv-sold-out-${runId}`,
} as const;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js inventory-truth server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      // The page plus the Better Auth route every storefront page requests on hydration: a
      // page-only probe can win the race and let the console guard record a transient 404.
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop/${slugs.preorder}`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status === 200 && authResponse.status === 200) {
        if ((await pageResponse.text()).includes(slugs.preorder)) return;
      }
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for inventory-truth server\n${serverOutput}`);
}

async function waitForServerExit(timeoutMs: number) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([once(server, "exit").then(() => true), delay(timeoutMs).then(() => false)]);
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

type SeedVariant = Readonly<{ size: string; quantity: number }>;

async function seedProduct(
  slug: string,
  name: string,
  sellingMode: "STANDARD" | "OVERSELL" | "PREORDER",
  variants: readonly SeedVariant[],
) {
  const syncedAt = new Date();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: slug,
      slug,
      name,
      isPresent: true,
      isActive: true,
      syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: `${name} inventory fixture.` } },
    },
  });

  for (const [index, seed] of variants.entries()) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${slug}-v${index}`,
        productId: product.id,
        color: "Black",
        size: seed.size,
        isPresent: true,
        isActive: true,
        pancakeRetailPrice: 700_000,
        pancakeRetailPriceAfterDiscount: 700_000,
        syncedAt,
      },
    });
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `${slug}-w${index}`,
        quantity: seed.quantity,
        syncedAt,
      },
    });
  }

  // The state is a stored row, never a fixture flag. STANDARD is the missing-row default, so it is
  // left unwritten on purpose — that is what a real unconfigured product looks like.
  if (sellingMode !== "STANDARD") {
    await prisma.productSellingPolicy.create({
      data: { productId: product.id, sellingMode, negativeStockLimit: FLOOR },
    });
  }

  await prisma.productCategoryMembership.create({
    data: { productId: product.id, categoryKey: "vayDam" },
  });

  return product;
}

/** Axe, overflow and a settled head, in the order the other buyer specs run them. */
async function assertPageQuality(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(
    overflow.documentWidth,
    `horizontal overflow: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.viewportWidth);

  await expectSettledDocumentTitle(page);
  const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(scan.violations).toEqual([]);
}

/** Console errors and failed responses, collected for one navigation. */
function watchPageHealth(page: Page) {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  return { browserErrors, failedResponses };
}

/**
 * Pick one option the way a shopper can.
 *
 * The radios are `sr-only`, so Playwright's `.check()` waits forever for something visible. Keyboard
 * activation is what the panel is built for and what the other buyer specs use — and it doubles as
 * the keyboard-operability check this feature owes.
 */
async function selectOption(page: Page, name: string) {
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const radio = panel.getByRole("radio", { name, exact: true });
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  return radio;
}

async function addSelectedToBag(page: Page, slug: string, size: string) {
  await page.goto(`${BASE_URL}/shop/${slug}`, { waitUntil: "networkidle" });
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  await selectOption(page, size);
  await selectOption(page, "Black");
  await panel.getByRole("button", { name: /Thêm vào giỏ hàng|Đặt trước sản phẩm này/ }).click();
  await expect(panel.getByRole("status")).toContainText("Đã thêm sản phẩm vào giỏ hàng.");
}

test.beforeEach(async ({ page }) => {
  await watchDocumentTitle(page);
});

test.beforeAll(async () => {
  await cleanup();

  await seedProduct(slugs.ready, `Inventory Ready ${runId}`, "STANDARD", [{ size: "M", quantity: 6 }]);
  // Two variants on one product, so variant switching crosses a real state boundary: M is a
  // purchasable preorder sale, L sits exactly on the hard floor and must be disabled.
  await seedProduct(slugs.preorder, `Inventory Preorder ${runId}`, "PREORDER", [
    { size: "M", quantity: 0 },
    { size: "L", quantity: FLOOR },
  ]);
  await seedProduct(slugs.oversell, `Inventory Oversell ${runId}`, "OVERSELL", [
    { size: "M", quantity: -5 },
  ]);
  await seedProduct(slugs.soldOut, `Inventory Sold Out ${runId}`, "STANDARD", [
    { size: "M", quantity: 0 },
  ]);

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock file there.
      NEXT_DIST_DIR: ".next-test/inventory-truth",
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

/* ------------------------------------------------------------------------------- cards */

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
] as const) {
  test(`F8a ${viewport.label} product cards read their own inventory state`, async ({ page }) => {
    const health = watchPageHealth(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/vay-dam`, { waitUntil: "networkidle" });

    const cardFor = (slug: string) =>
      page.locator("article").filter({ has: page.locator(`a[href="/shop/${slug}"]`) }).first();

    // §30: the depleted PREORDER product says so on the card.
    await expect(cardFor(slugs.preorder)).toContainText(PREORDER);
    // §31: the oversell product is indistinguishable from ready stock.
    await expect(cardFor(slugs.oversell)).not.toContainText(PREORDER);
    await expect(cardFor(slugs.oversell)).not.toContainText(OUT_OF_STOCK);
    // A ready product says nothing at all about availability.
    await expect(cardFor(slugs.ready)).not.toContainText(PREORDER);
    await expect(cardFor(slugs.ready)).not.toContainText(OUT_OF_STOCK);
    // §29: a STANDARD product with no stock says the exact words.
    await expect(cardFor(slugs.soldOut)).toContainText(OUT_OF_STOCK);

    await assertPageQuality(page);
    expect(health.browserErrors).toEqual([]);
    expect(health.failedResponses).toEqual([]);
  });
}

/* --------------------------------------------------------------------------------- PDP */

test("F8a a preorder PDP shows the state, and its CTA says so too", async ({ page }) => {
  const health = watchPageHealth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${slugs.preorder}`, { waitUntil: "networkidle" });

  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  // These products carry a colour dimension, so a variant is addressed only once both are picked —
  // the same two clicks a shopper makes. Before that there is no selected variant to have a state.
  await selectOption(page, "M");
  await selectOption(page, "Black");

  // Two separate things §30 requires: the state is visible, and the button communicates it.
  await expect(panel.locator('[data-purchase-state="preorder"]')).toHaveText(PREORDER);
  const cta = panel.getByRole("button", { name: `${PREORDER} sản phẩm này`, exact: true });
  await expect(cta).toBeVisible();
  await expect(cta).toBeEnabled();
  await expect(cta).toHaveText(PREORDER);

  await assertPageQuality(page);
  expect(health.browserErrors).toEqual([]);
  expect(health.failedResponses).toEqual([]);
});

test("F8a a variant at the hard floor stays visible, is disabled and says Hết hàng", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${slugs.preorder}`, { waitUntil: "networkidle" });

  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const floored = panel.getByRole("radio", { name: "L", exact: true });

  // Visible, not removed from the selector.
  await expect(floored).toHaveCount(1);
  // Disabled semantically, not merely styled.
  await expect(floored).toBeDisabled();
});

test("F8a switching variants moves the state and leaves nothing behind", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${slugs.ready}`, { waitUntil: "networkidle" });

  const readyPanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await selectOption(page, "M");
  await selectOption(page, "Black");
  await expect(readyPanel.locator('[data-purchase-state="preorder"]')).toHaveCount(0);
  await expect(
    readyPanel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true }),
  ).toHaveText("Thêm vào giỏ");

  // Same panel component, different product state, reached by navigation rather than a reload.
  await page.goto(`${BASE_URL}/shop/${slugs.preorder}`, { waitUntil: "networkidle" });
  const preorderPanel = page.getByRole("region", { name: "Mua sản phẩm" });
  await selectOption(page, "M");
  await selectOption(page, "Black");
  await expect(preorderPanel.locator('[data-purchase-state="preorder"]')).toHaveText(PREORDER);
});

test("F8a a deep-linked variant renders its own state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const variant = await prisma.variantMirror.findFirstOrThrow({
    where: { pancakeVariationId: `${slugs.preorder}-v0` },
  });

  // `VARIANT_QUERY_PARAM` — the one addressing contract, spelled the way the route reads it.
  await page.goto(`${BASE_URL}/shop/${slugs.preorder}?variant=${variant.pancakeVariationId}`, {
    waitUntil: "networkidle",
  });

  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  // The link addresses one variation, so both dimensions arrive preselected: no clicks at all.
  await expect(panel.getByRole("radio", { name: "M", exact: true })).toBeChecked();
  await expect(panel.getByRole("radio", { name: "Black", exact: true })).toBeChecked();
  await expect(panel.locator('[data-purchase-state="preorder"]')).toHaveText(PREORDER);
});

test("F8a an oversell PDP is keyboard-operable and says nothing special", async ({ page }) => {
  const health = watchPageHealth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop/${slugs.oversell}`, { waitUntil: "networkidle" });

  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const size = await selectOption(page, "M");
  // Focus stays on the control the keyboard reached.
  await expect(size).toBeFocused();
  await selectOption(page, "Black");

  await expect(panel.locator('[data-purchase-state="preorder"]')).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Thêm vào giỏ hàng", exact: true }),
  ).toBeEnabled();

  // §31 — the internal balance is −5 here and the buyer must never see it. Asserted against the
  // *visible* text rather than the DOM, because that is the claim: an href or a data attribute
  // carrying a slug is not something a shopper reads. Any standalone negative integer fails, not
  // just this fixture's, so a different balance leaking later is caught too.
  const visibleText = await page.evaluate(() => document.body.innerText);
  expect(visibleText, "no negative balance may be rendered to a buyer").not.toMatch(
    /(?:^|[^\w-])-\d+/,
  );

  await assertPageQuality(page);
  expect(health.browserErrors).toEqual([]);
  expect(health.failedResponses).toEqual([]);
});

/* ------------------------------------------------------------------ cart and checkout */

test("F8b a preorder line keeps its marker in the cart and states the preparation truth", async ({
  page,
}) => {
  const health = watchPageHealth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await addSelectedToBag(page, slugs.preorder, "M");
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  await expect(page.locator('[data-line-state="preorder"]')).toHaveText(PREORDER);

  const notice = page.locator('[data-preorder-notice="true"]');
  await expect(notice).toContainText("15 ngày lịch");
  await expect(notice).toContainText("xác nhận thành công");
  // The approved A5 windows, applied after preparation rather than instead of it.
  await expect(notice).toContainText("1–3 ngày");
  await expect(notice).toContainText("3–10 ngày");
  // The approved caveat is the only place the word "cam kết" may appear, and it appears there to
  // deny a commitment: "không phải cam kết thời hạn tuyệt đối". So the check is that the caveat is
  // present, and that no date is produced — §30 starts the clock at confirmation, not here.
  await expect(notice).toContainText("không phải cam kết");
  await expect(notice).not.toContainText(/\d{1,2}\/\d{1,2}\/\d{4}/);
  // Preorder-only basket: nothing is being held alongside it.
  await expect(page.locator('[data-preorder-mixed="true"]')).toHaveCount(0);

  await assertPageQuality(page);
  expect(health.browserErrors).toEqual([]);
  expect(health.failedResponses).toEqual([]);
});

test("F8b a mixed basket says the whole order ships together", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addSelectedToBag(page, slugs.preorder, "M");
  await addSelectedToBag(page, slugs.ready, "M");
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  const mixed = page.locator('[data-preorder-mixed="true"]');
  await expect(mixed).toBeVisible();
  await expect(mixed).toContainText("giao cùng nhau");
  // Exactly one line carries the marker: the ready line must not inherit it.
  await expect(page.locator('[data-line-state="preorder"]')).toHaveCount(1);

  await assertPageQuality(page);
});

test("F8b an oversell basket looks like an ordinary ready order", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addSelectedToBag(page, slugs.oversell, "M");
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });

  await expect(page.locator('[data-preorder-notice="true"]')).toHaveCount(0);
  await expect(page.locator('[data-line-state="preorder"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(PREORDER);
  await expect(page.locator("body")).not.toContainText("15 ngày lịch");
});

test("F8b checkout keeps the preorder marker and the fulfillment truth", async ({ page }) => {
  const health = watchPageHealth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await addSelectedToBag(page, slugs.preorder, "M");
  await addSelectedToBag(page, slugs.ready, "M");
  await page.goto(`${BASE_URL}/checkout`, { waitUntil: "networkidle" });

  // §30: the line must not become visually ready stock on the way from the cart.
  await expect(page.locator('[data-line-state="preorder"]')).toHaveCount(1);
  await expect(page.locator('[data-line-state="preorder"]')).toHaveText(PREORDER);

  const notice = page.locator('[data-preorder-notice="true"]');
  await expect(notice).toContainText("15 ngày lịch");
  await expect(notice).toContainText("1–3 ngày");
  await expect(page.locator('[data-preorder-mixed="true"]')).toBeVisible();

  await assertPageQuality(page);
  expect(health.browserErrors).toEqual([]);
  expect(health.failedResponses).toEqual([]);
});

test("F8b a reload preserves the server-derived truth rather than client state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addSelectedToBag(page, slugs.preorder, "M");
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-preorder-notice="true"]')).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator('[data-line-state="preorder"]')).toHaveText(PREORDER);
  await expect(page.locator('[data-preorder-notice="true"]')).toContainText("15 ngày lịch");
});

test("F8b the server stays the authority when the policy changes under a filled cart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addSelectedToBag(page, slugs.preorder, "M");
  await page.goto(`${BASE_URL}/cart`, { waitUntil: "networkidle" });
  await expect(page.locator('[data-preorder-notice="true"]')).toBeVisible();

  const product = await prisma.productMirror.findFirstOrThrow({ where: { slug: slugs.preorder } });
  await prisma.productSellingPolicy.update({
    where: { productId: product.id },
    data: { sellingMode: "STANDARD" },
  });

  try {
    // Nothing about the browser changed; the stored policy did. The page must follow the server:
    // at stock 0 under STANDARD the line is no longer buyable, so it is no longer a preorder sale
    // and no preparation window may still be promised for it.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator('[data-preorder-notice="true"]')).toHaveCount(0);
    await expect(page.locator('[data-line-state="preorder"]')).toHaveCount(0);
    await expect(page.getByText("Tạm hết hàng")).toBeVisible();
  } finally {
    await prisma.productSellingPolicy.update({
      where: { productId: product.id },
      data: { sellingMode: "PREORDER" },
    });
  }
});
