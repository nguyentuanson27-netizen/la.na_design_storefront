import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * The storefront's listing surfaces are one system.
 *
 * Category, `/new-arrivals`, `/sale`, `/shop`, `/collections` and a collection's own page each
 * used to draw their own header, grid, empty state and pager. This spec drives all of them at a
 * desktop and a mobile viewport and asserts the shape master spec §25 describes: breadcrumb,
 * eyebrow, one serif H1, then the listing -- with no horizontal overflow, a reachable keyboard
 * path and no Axe violations at either width.
 *
 * It also proves the two behaviours the re-skin must not have changed: `/new-arrivals` shows the
 * catalog's newest products (§10), and `/sale` shows only products with a real active discount.
 */

const HOST = "127.0.0.1";
const PORT = 3332;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_029;
const runId = `${Date.now()}-${process.pid}`;
const now = new Date();
const syncedAt = new Date("2026-09-19T02:00:00.000Z");
const campaignId = `listing-consistency-sale-${runId}`;
const COLLECTION_SLUG = "listing-consistency";
const IMAGE_COLLECTION_SLUG = `listing-image-${process.pid}`;
const IMAGE_COLLECTION_TITLE = "Listing Image Collection";
const LONG_COLLECTION_SLUG = `listing-long-${process.pid}`;
const COLLECTION_HERO_URL = "https://content.pancake.vn/images/1/2/3/collections-index-hero.jpg";
const LONG_COLLECTION_TITLE = `Bộ sưu tập ${"ÁoDàiKhôngNgắt".repeat(28)}`;
const CATEGORY_KEY = "aoDai";
const CATEGORY_PATH = "/ao-dai";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** Newest last: the seed order is oldest-first, so `Listing Newest` must lead `/new-arrivals`. */
const PRODUCTS = [
  { key: "oldest", label: "Listing Oldest", price: 900_000, daysAgo: 30, discounted: false },
  { key: "middle", label: "Listing Middle", price: 800_000, daysAgo: 20, discounted: true },
  { key: "newest", label: "Listing Newest", price: 700_000, daysAgo: 1, discounted: false },
] as const;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

function productName(key: string): string {
  const entry = PRODUCTS.find((product) => product.key === key);
  if (!entry) throw new Error(`Unknown fixture product ${key}`);
  return `${entry.label} ${runId}`;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Listing consistency server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which calls the Better Auth catch-all as
      // soon as it hydrates. Waiting on the page alone lets Playwright navigate while that route
      // still answers a transient 404, which the clean-console guard then correctly records.
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for listing consistency server\n${serverOutput}`);
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
  await prisma.promotionCampaign.deleteMany({ where: { id: campaignId } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({
    where: { slug: { in: [COLLECTION_SLUG, IMAGE_COLLECTION_SLUG, LONG_COLLECTION_SLUG] } },
  });
}

async function seedProduct(input: (typeof PRODUCTS)[number]) {
  const slug = `listing-${input.key}-${runId}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: slug,
      slug,
      name: `${input.label} ${runId}`,
      isPresent: true,
      isActive: true,
      syncedAt,
      createdAt: new Date(now.getTime() - input.daysAgo * 86_400_000),
      // The category PLP is the surface master spec §25 describes and the only listing that draws
      // the filter panel, so the density gate has to be able to measure it with products in it.
      categoryMemberships: { create: [{ categoryKey: CATEGORY_KEY }] },
      content: {
        create: {
          editorialDescription: `Editorial ${input.key}`,
          collectionSlugs: [COLLECTION_SLUG],
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${slug}-variant`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: input.price,
      pancakeRetailPriceAfterDiscount: input.price,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${slug}-warehouse`,
      quantity: 3,
      syncedAt,
    },
  });
  return product;
}

test.beforeAll(async () => {
  await cleanup();

  await prisma.collectionDefinition.create({
    data: {
      slug: COLLECTION_SLUG,
      title: "Listing Consistency",
      description: "Bộ sưu tập kiểm thử bố cục danh sách.",
      seoTitle: "Listing Consistency",
      seoDescription: "Listing consistency",
      isPublished: true,
      pancakeCategoryIds: [],
    },
  });

  const seeded = new Map<string, { id: string }>();
  for (const product of PRODUCTS) {
    seeded.set(product.key, await seedProduct(product));
  }

  // Exactly one product carries a real, currently active discount, so `/sale` has something to
  // show and something to leave out.
  const discounted = PRODUCTS.filter((product) => product.discounted);
  await prisma.promotionCampaign.create({
    data: {
      id: campaignId,
      kind: "PROMOTION",
      name: `Listing consistency promotion ${runId}`,
      discountType: "PERCENTAGE",
      percentageValue: 25,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: {
        create: discounted.map((product) => ({ productId: seeded.get(product.key)!.id })),
      },
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock file there.
      // Every spec drives this one project, so they share that lock unless each gets its own.
      NEXT_DIST_DIR: ".next-test/listing-consistency",
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

/** The shape §25 describes, asserted the same way on every listing route. */
async function expectListingChrome(
  page: Page,
  expected: Readonly<{ heading: string; breadcrumbTail: string }>,
) {
  // Exactly one H1, and it is the listing's own name.
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: expected.heading, exact: true })).toBeVisible();

  const headingStyle = await page
    .locator("main h1")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontFamily: style.fontFamily, fontWeight: style.fontWeight };
    });
  // Master spec §9 (amended): the Josefin Sans display face, at normal weight rather than bold.
  expect(headingStyle.fontFamily.toLowerCase()).toMatch(/josefin/);
  expect(Number(headingStyle.fontWeight)).toBeLessThanOrEqual(400);

  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(breadcrumb).toBeAttached();
  await expect(breadcrumb.getByRole("link", { name: "Trang chủ", exact: true })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(expected.breadcrumbTail);
}

async function expectPageQuality(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);

  // A keyboard user reaches something on first Tab rather than falling into the body.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName), `${label} focus`).not.toBe(
    "BODY",
  );

  /*
   * Let the page settle before scanning.
   *
   * `page.goto(..., { waitUntil: "networkidle" })` returns before hydration has finished moving
   * the route around, and an Axe scan that starts while a navigation is in flight dies with
   * `Execution context was destroyed`. That is what made this test flaky: it failed once in four
   * local runs with exactly that error, and passed on the retry -- a green run that was one
   * scheduling accident away from being red.
   *
   * Waiting for the network to go quiet again catches the common case; `toPass` covers the rest
   * without weakening the assertion, since a genuine violation still fails every attempt. The
   * timeout is short so a real failure surfaces quickly rather than being retried for half a
   * minute.
   */
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    const scan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(scan.violations, `${label} Axe violations`).toEqual([]);
  }).toPass({ timeout: 15_000 });
}

const ROUTES = [
  { path: CATEGORY_PATH, heading: "Áo dài", breadcrumbTail: "Áo dài", label: "category reference" },
  { path: "/new-arrivals", heading: "Hàng mới về", breadcrumbTail: "Hàng mới về", label: "new arrivals" },
  { path: "/sale", heading: "Sale", breadcrumbTail: "Sale", label: "sale" },
  { path: "/shop", heading: "Cửa hàng", breadcrumbTail: "Cửa hàng", label: "shop" },
  { path: "/collections", heading: "Bộ sưu tập", breadcrumbTail: "Bộ sưu tập", label: "collections" },
  {
    path: `/collections/${COLLECTION_SLUG}`,
    heading: "Listing Consistency",
    breadcrumbTail: "Listing Consistency",
    label: "collection detail",
  },
] as const;

test("every listing route draws the same chrome on desktop and mobile", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of ROUTES) {
      browserErrors.length = 0;
      const label = `${viewport.name} ${route.label}`;

      const response = await page.goto(`${BASE_URL}${route.path}`, { waitUntil: "networkidle" });
      expect(response?.status(), `${label} response`).toBe(200);

      await expectListingChrome(page, {
        heading: route.heading,
        breadcrumbTail: route.breadcrumbTail,
      });
      await expectPageQuality(page, label);

      expect(browserErrors, `${label} console/page errors`).toEqual([]);
    }
  }
});

test("shared loaded ProductCard frame uses 2:3 portrait aspect ratio at mobile (390x844) and desktop (1440x900)", async ({
  page,
}) => {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/ao-dai`, { waitUntil: "networkidle" });

    const cardVisual = page.locator("main .product-visual").first();
    await expect(cardVisual).toBeVisible();

    const box = await cardVisual.boundingBox();
    expect(box, `Product card visual at ${viewport.name} (${viewport.width}x${viewport.height})`).not.toBeNull();

    // 2:3 portrait ratio: width / height ≈ 2 / 3 (0.6667)
    const ratio = box!.width / box!.height;
    expect(ratio).toBeCloseTo(2 / 3, 2);

    const computed = await cardVisual.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        aspectRatio: style.aspectRatio,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      };
    });
    expect(computed.width / computed.height).toBeCloseTo(2 / 3, 2);
  }
});

test("mobile category filters stay open across sequential URL-backed selections", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/ao-dai`, { waitUntil: "networkidle" });

  // This fixture intentionally has no trusted product image URL, so the card renders the same
  // product-media frame with its silhouette fallback. The fold contract is about where that media
  // frame begins, not whether the fixture happens to carry photography.
  const firstProductMedia = page.locator("main .product-visual").first();
  await expect(firstProductMedia).toBeVisible();
  const firstProductBox = await firstProductMedia.boundingBox();
  expect(firstProductBox?.y).toBeLessThan(844);

  const opener = page.getByRole("button", { name: "Bộ lọc", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Bộ lọc sản phẩm" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Đóng bộ lọc", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Xem 3 sản phẩm", exact: true })).toBeVisible();

  const expectDialogOwnsFocus = async () => {
    await expect.poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
  };

  await dialog.getByRole("link", { name: "Chỉ xem sản phẩm Sale", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Xem 1 sản phẩm", exact: true })).toBeVisible();
  await expectDialogOwnsFocus();

  await dialog.getByRole("link", { name: "M", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(dialog).toBeVisible();
  await expectDialogOwnsFocus();

  await dialog.getByRole("link", { name: "Ink", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(dialog).toBeVisible();
  await expectDialogOwnsFocus();

  await dialog.getByLabel("Giá tối thiểu").fill("500000");
  await dialog.getByLabel("Giá tối đa").fill("900000");
  await dialog.getByRole("button", { name: "Áp dụng giá", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await expect(dialog).toBeVisible();
  await expectDialogOwnsFocus();

  const viewResults = dialog.getByRole("button", { name: "Xem 1 sản phẩm", exact: true });
  await expect(viewResults).toBeVisible();
  await viewResults.click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the product grid is 2 columns on mobile and 4 on desktop, on every listing that has one", async ({
  page,
}) => {
  // `/collections` is an index rather than a product listing, so it is not in this list.
  const gridded = [CATEGORY_PATH, "/new-arrivals", "/sale", "/shop", `/collections/${COLLECTION_SLUG}`];

  for (const { name, width, height, expectedColumns } of [
    { ...VIEWPORTS[0], expectedColumns: 2 },
    { ...VIEWPORTS[1], expectedColumns: 4 },
  ]) {
    await page.setViewportSize({ width, height });

    for (const path of gridded) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
      const grid = page.locator("main .grid-cols-2").first();
      await expect(grid, `${name} ${path} grid`).toBeVisible();

      const columns = await grid.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
      );
      // Master spec §18: 4 per row on desktop, 2 on mobile.
      expect(columns, `${name} ${path} columns`).toBe(expectedColumns);
    }
  }
});


test("phone product listings run edge-to-edge with the shared 2px image rhythm", async ({ page }) => {
  const gridded = [
    CATEGORY_PATH,
    "/new-arrivals",
    "/sale",
    "/shop",
    `/collections/${COLLECTION_SLUG}`,
  ];

  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of gridded) {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });

    const grid = page.locator("main .listing-product-grid").first();
    await expect(grid, path).toBeVisible();

    const geometry = await grid.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        columnGap: Number.parseFloat(style.columnGap),
      };
    });

    expect(geometry.left, `${path} left edge`).toBeCloseTo(0, 0);
    expect(geometry.right, `${path} right edge`).toBeCloseTo(390, 0);
    expect(geometry.width, `${path} width`).toBeCloseTo(390, 0);
    expect(geometry.columnGap, `${path} column gap`).toBeCloseTo(2, 1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(1);
  }
});

/**
 * Refinement spec "PLP / listing density" -- the owner's observable acceptance.
 *
 * A listing whose products start below the fold reads as a page of chrome. The criterion is
 * deliberately about the first product *image*, not the grid container: a grid whose top edge is
 * visible while every photograph in it is not would satisfy the letter and miss the point.
 */
test("a product-bearing listing shows its first product image inside the initial viewport", async ({
  page,
}) => {
  const productBearing = [
    CATEGORY_PATH,
    "/new-arrivals",
    "/sale",
    "/shop",
    `/collections/${COLLECTION_SLUG}`,
  ];
  const folds: { label: string; top: number; height: number }[] = [];

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const path of productBearing) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });

      // Filters stay in their default, unexpanded state: nothing is collapsed to make room.
      const firstProductMedia = page.locator("main .grid-cols-2 .product-visual").first();
      await expect(firstProductMedia, `${viewport.name} ${path} first product`).toBeVisible();

      const top = await firstProductMedia.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      // Collected rather than asserted here, so one run reports every listing that is still below
      // the fold instead of stopping at the first.
      folds.push({ label: `${viewport.name} ${path}`, top: Math.round(top), height: viewport.height });

      // The page is still at the top -- this is the initial viewport, not a scrolled one.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Density must not have cost the filter controls their reachable size.
      const filterControl = page.getByRole("link", { name: "Xóa bộ lọc", exact: true });
      if ((await filterControl.count()) > 0) {
        const box = (await filterControl.first().boundingBox())!;
        expect(box.height, `${viewport.name} ${path} clear-filter target`).toBeGreaterThanOrEqual(24);
      }
    }
  }

  expect(
    folds.filter(({ top, height }) => top >= height),
    `first product image below the fold: ${JSON.stringify(folds)}`,
  ).toEqual([]);
  // Reported unconditionally so a run that passes still leaves the measurement behind: the next
  // person to add a row of chrome can see how much headroom they are spending.
  console.log(`first product image offsets: ${JSON.stringify(folds)}`);
});

test("new-arrivals shows the catalog newest first, and pages without losing the ordering", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/new-arrivals`, { waitUntil: "networkidle" });

  // Real products, not an editorial page: master spec §10.
  const names = await page
    .locator("main .grid-cols-2 a[href^='/shop/']")
    .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
  expect(names.length).toBeGreaterThan(0);

  const indexOf = (key: string) => names.findIndex((name) => name.includes(productName(key)));
  expect(indexOf("newest"), "the newest product must appear").toBeGreaterThanOrEqual(0);
  expect(indexOf("oldest"), "the oldest product must appear").toBeGreaterThanOrEqual(0);
  expect(
    indexOf("newest"),
    "newest first: the most recently added product leads the listing",
  ).toBeLessThan(indexOf("oldest"));

  await expect(page.getByText(/^\d+ sản phẩm$/)).toBeVisible();

  // A page past the end is a 404 rather than a silently empty listing.
  const beyond = await page.request.get(`${BASE_URL}/new-arrivals?page=99`);
  expect(beyond.status()).toBe(404);

  // An invalid page is rejected the same way every other listing rejects it.
  const invalid = await page.request.get(`${BASE_URL}/new-arrivals?page=0`);
  expect(invalid.status()).toBe(404);
});

test("sale still lists only products with a real active discount", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/sale`, { waitUntil: "networkidle" });

  const main = page.locator("main");
  await expect(main.getByRole("link", { name: new RegExp(productName("middle")) })).toBeVisible();

  for (const key of ["newest", "oldest"] as const) {
    await expect(
      main.getByRole("link", { name: new RegExp(productName(key)) }),
      `${key} carries no active discount and must not appear on /sale`,
    ).toHaveCount(0);
  }

  await expect(page.getByText(/1 sản phẩm đang giảm giá/)).toBeVisible();
});

test("navigation and text buttons wear the display face; reading text wears the body face", async ({
  page,
}) => {
  // Owner amendment 2026-09-24: Josefin Sans for headings, navigation, prices and buttons, Mulish
  // for everything read at length. Read from computed style, so a control that silently inherits
  // the body face -- the regression this guards -- fails here rather than in review.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/ao-dai`, { waitUntil: "networkidle" });

  const fontOf = (locator: import("@playwright/test").Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fontFamily.toLowerCase());

  expect(await fontOf(page.locator(".desktop-nav a").first()), "primary navigation").toMatch(/josefin/);
  // The filter trigger is a plain <button> with no font utility of its own: it proves the default.
  expect(
    await fontOf(page.locator('button[aria-controls="mobile-plp-filters"]')),
    "text button without a font utility",
  ).toMatch(/josefin/);
  expect(await fontOf(page.locator("body")), "body text").toMatch(/mulish/);
});

test("shop keeps its own query semantics through the shared chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/shop`, { waitUntil: "networkidle" });

  const search = page.getByRole("searchbox", { name: "Tìm sản phẩm" });
  await search.fill(productName("newest"));
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/shop" && url.searchParams.has("q")),
    page.getByRole("button", { name: "Áp dụng", exact: true }).click(),
  ]);

  const main = page.locator("main");
  await expect(main.getByRole("link", { name: new RegExp(productName("newest")) })).toBeVisible();
  await expect(
    main.getByRole("link", { name: new RegExp(productName("oldest")) }),
  ).toHaveCount(0);

  // The filtered state offers its way back, and taking it restores the full listing.
  await page.getByRole("link", { name: "Xóa bộ lọc", exact: true }).click();
  await page.waitForURL(`${BASE_URL}/shop`);
  await expect(main.getByRole("link", { name: new RegExp(productName("oldest")) })).toBeVisible();
});

test("a collection keeps its editorial half above the shared listing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/collections/${COLLECTION_SLUG}`, { waitUntil: "networkidle" });

  // The header is title-only: the collection's story is no longer drawn under the heading.
  await expect(page.getByText("Bộ sưu tập kiểm thử bố cục danh sách.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Sắp xếp bộ sưu tập" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Lọc theo kích cỡ" })).toBeVisible();

  const main = page.locator("main");
  await expect(main.getByRole("link", { name: new RegExp(productName("newest")) })).toBeVisible();
});

test("collection index cards keep a 16:9 media surface without clipping valid long titles", async ({
  page,
}) => {
  await prisma.collectionDefinition.createMany({
    data: [
      {
        slug: IMAGE_COLLECTION_SLUG,
        title: IMAGE_COLLECTION_TITLE,
        description: "Collection index image-card fixture.",
        heroImageUrl: COLLECTION_HERO_URL,
        isPublished: true,
        pancakeCategoryIds: [],
      },
      {
        slug: LONG_COLLECTION_SLUG,
        title: LONG_COLLECTION_TITLE,
        description: "Long-title collection for card overflow regression coverage.",
        heroImageUrl: "https://example.com/images/1/2/3/untrusted.jpg",
        isPublished: true,
        pancakeCategoryIds: [],
      },
    ],
  });

  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
  );
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: tinyJpeg });
  });

  try {
    for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });

    const imageCard = page
      .locator("article")
      .filter({ has: page.locator(`a[href="/collections/${IMAGE_COLLECTION_SLUG}"]`) });
    const media = imageCard.locator("[data-collection-card-media]");
    await expect(media, `${viewport.name} collection media`).toBeVisible();

    const cardBox = await imageCard.boundingBox();
    expect(cardBox, `${viewport.name} collection card box`).not.toBeNull();
    expect(cardBox!.width / cardBox!.height).toBeCloseTo(16 / 9, 2);
    expect(await imageCard.evaluate((element) => getComputedStyle(element).aspectRatio)).toBe("16 / 9");

    const image = imageCard.locator("img");
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute("alt", "");
    await expect(image).toHaveAttribute("sizes", "(min-width: 768px) 50vw, 100vw");
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect(
      imageCard.getByRole("heading", { level: 2, name: IMAGE_COLLECTION_TITLE, exact: true }),
    ).toBeAttached();

    const fallbackCard = page
      .locator("article")
      .filter({ has: page.locator(`a[href="/collections/${LONG_COLLECTION_SLUG}"]`) });
    await expect(fallbackCard.locator("img")).toHaveCount(0);

    const longTitle = fallbackCard.getByRole("heading", {
      level: 2,
      name: LONG_COLLECTION_TITLE,
      exact: true,
    });
    const cta = fallbackCard.getByRole("link", { name: "Khám phá bộ sưu tập ↗", exact: true });
    await expect(longTitle).toBeVisible();
    await expect(cta).toBeVisible();

    const geometry = await fallbackCard.evaluate((card, titleText) => {
      const heading = [...card.querySelectorAll("h2")].find(
        (element) => element.textContent?.trim() === titleText,
      );
      const link = card.querySelector("a");
      if (!(heading instanceof HTMLElement) || !(link instanceof HTMLElement)) return null;
      const cardRect = card.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      return {
        headingWithinCard:
          headingRect.left >= cardRect.left - 1 &&
          headingRect.right <= cardRect.right + 1 &&
          headingRect.top >= cardRect.top - 1 &&
          headingRect.bottom <= cardRect.bottom + 1,
        ctaWithinCard: linkRect.bottom <= cardRect.bottom + 1,
        titleWraps: heading.scrollWidth <= heading.clientWidth + 1,
      };
    }, LONG_COLLECTION_TITLE);

    expect(geometry).not.toBeNull();
    expect(geometry!.headingWithinCard, `${viewport.name} long title is not clipped`).toBe(true);
    expect(geometry!.ctaWithinCard, `${viewport.name} CTA is not clipped`).toBe(true);
      expect(geometry!.titleWraps, `${viewport.name} long token wraps inside the card`).toBe(true);
    }
  } finally {
    await prisma.collectionDefinition.deleteMany({
      where: { slug: { in: [IMAGE_COLLECTION_SLUG, LONG_COLLECTION_SLUG] } },
    });
  }
});

/*
 * The collection CTA sits in two places: over the card's hero photograph (inside a darkening
 * vignette) and, with no usable image, on the paper page. A keyboard focus indicator has to show on
 * both, and on a photograph nobody chose, so this measures rendered pixels instead of assuming the
 * surface: the hero is served as solid black -- the worst case for an ink ring -- and each CTA is
 * captured before and after keyboard focus. Somewhere in the band just outside the control, focus
 * must change a pixel by at least 3:1 (WCAG 2.2 SC 2.4.13's contrast-of-change) on both cards.
 */
test("the collection CTA's keyboard focus shows on a dark hero and on the paper page", async ({
  page,
}) => {
  await prisma.collectionDefinition.createMany({
    data: [
      {
        slug: IMAGE_COLLECTION_SLUG,
        title: IMAGE_COLLECTION_TITLE,
        description: "Collection index focus fixture over a dark hero.",
        heroImageUrl: COLLECTION_HERO_URL,
        isPublished: true,
        pancakeCategoryIds: [],
      },
      {
        slug: LONG_COLLECTION_SLUG,
        title: "Listing Paper Collection",
        description: "Collection index focus fixture on the paper page.",
        heroImageUrl: "https://example.com/images/1/2/3/untrusted.jpg",
        isPublished: true,
        pancakeCategoryIds: [],
      },
    ],
  });
  const blackHero = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#000"/></svg>';
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: blackHero });
  });

  const BAND = 8;
  const capture = async (cta: import("@playwright/test").Locator) => {
    const box = (await cta.boundingBox())!;
    const clip = {
      x: Math.max(0, box.x - BAND),
      y: Math.max(0, box.y - BAND),
      width: box.width + BAND * 2,
      height: box.height + BAND * 2,
    };
    return { clip, png: (await page.screenshot({ clip, animations: "disabled" })).toString("base64") };
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });

    for (const slug of [IMAGE_COLLECTION_SLUG, LONG_COLLECTION_SLUG]) {
      const card = page
        .locator("article")
        .filter({ has: page.locator(`a[href="/collections/${slug}"]`) });
      const cta = card.getByRole("link", { name: "Khám phá bộ sưu tập ↗", exact: true });
      await cta.scrollIntoViewIfNeeded();
      await expect(card.locator("img")).toHaveCount(slug === IMAGE_COLLECTION_SLUG ? 1 : 0);

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const before = await capture(cta);
      // Reach it from the keyboard, so `:focus-visible` is what the browser really applies.
      await cta.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(cta).toBeFocused();
      expect(await cta.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      const after = await capture(cta);

      const bestChange = await page.evaluate(
        async ({ beforePng, afterPng, band, clipWidth }) => {
          const decode = async (png: string) => {
            const image = new Image();
            image.src = `data:image/png;base64,${png}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height);
          };
          const luminance = (data: Uint8ClampedArray, index: number) => {
            const [red, green, blue] = [data[index]!, data[index + 1]!, data[index + 2]!].map(
              (channel) => {
                const normalized = channel / 255;
                return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
              },
            );
            return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
          };
          const [unfocused, focused] = await Promise.all([decode(beforePng), decode(afterPng)]);
          const { width, height } = focused;
          // Scale for device pixels: the clip is in CSS pixels, the capture may not be.
          const scale = width / clipWidth;
          const inBand = (x: number, y: number) => {
            const cssX = x / scale;
            const cssY = y / scale;
            const insideControl =
              cssX >= band && cssX < width / scale - band && cssY >= band && cssY < height / scale - band;
            return !insideControl;
          };
          let best = 1;
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              if (!inBand(x, y)) continue;
              const index = (y * width + x) * 4;
              const a = luminance(unfocused.data, index);
              const b = luminance(focused.data, index);
              best = Math.max(best, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
            }
          }
          return best;
        },
        { beforePng: before.png, afterPng: after.png, band: BAND, clipWidth: after.clip.width },
      );
      expect(bestChange, `${slug}: focus indicator change of contrast`).toBeGreaterThanOrEqual(3);
    }
  } finally {
    await prisma.collectionDefinition.deleteMany({
      where: { slug: { in: [IMAGE_COLLECTION_SLUG, LONG_COLLECTION_SLUG] } },
    });
  }
});

test("collections stays an index over real published collections, and lists no products", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/collections`, { waitUntil: "networkidle" });

  await expect(page.getByRole("link", { name: /Khám phá bộ sưu tập/ }).first()).toBeVisible();
  // An index links to collections; it does not list products.
  await expect(page.locator("main a[href^='/shop/']")).toHaveCount(0);

  // Every card on the page is a collection the database actually publishes -- nothing is invented
  // to fill the grid, and an unpublished collection does not appear. The empty-state rendering
  // itself is pinned in `tests/domain/storefront-listing-chrome.test.ts`, because this database is
  // shared with the specs that seed their own collections and cannot be emptied from here.
  const rendered = await page
    .locator("main a[href^='/collections/']")
    .evaluateAll((links) =>
      links.map((link) => (link.getAttribute("href") ?? "").replace("/collections/", "")),
    );
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered).toContain(COLLECTION_SLUG);

  const published = await prisma.collectionDefinition.findMany({
    where: { slug: { in: rendered } },
    select: { slug: true, isPublished: true },
  });
  expect(published.length, "every rendered collection exists").toBe(new Set(rendered).size);
  expect(
    published.filter((collection) => !collection.isPublished),
    "no unpublished collection is rendered",
  ).toEqual([]);
});
