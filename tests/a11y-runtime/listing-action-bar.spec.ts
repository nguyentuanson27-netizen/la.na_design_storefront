import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * The one-row action bar of the category listing and the filters of `/sale`.
 *
 * Phone widths: the view toggle, the filter button and the sort share one row from 360px, hit areas
 * of neighbouring controls never overlap, a tap at the very edge of a view option lands on that
 * option, and the sort label is never clipped (a screen too narrow for the row wraps the filter
 * button and the sort to a second line instead). `/sale` and its sub-listings draw the same bar
 * without "Còn hàng" and "Sale", filter by size and price and keep the filters across a page turn,
 * and a card shows the price of the variant the filter matched.
 */

const HOST = "127.0.0.1";
const PORT = 3372;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_094;
const runId = `${Date.now()}-${process.pid}`;
const now = new Date();
const syncedAt = new Date("2026-09-19T02:00:00.000Z");
const campaignId = `listing-action-bar-sale-${runId}`;
const CATEGORY_KEY = "aoDai";
const CATEGORY_PATH = "/ao-dai";
const COLLECTION_SLUG = "action-bar-collection";
const COLLECTION_PATH = `/collections/${COLLECTION_SLUG}`;

/**
 * All 20% off, so a variant sells at 80% of its list price:
 *   A  M Black 500k (400k)  L Black 500k (400k)
 *   B  S White 300k (240k)
 *   C  M White 900k (720k)
 *   D  M Black 200k (160k)  L Black 1,000k (800k)
 */
const PRODUCTS = [
  { key: "a", variants: [["M", "Black", 500_000], ["L", "Black", 500_000]] },
  { key: "b", variants: [["S", "White", 300_000]] },
  { key: "c", variants: [["M", "White", 900_000]] },
  { key: "d", variants: [["M", "Black", 200_000], ["L", "Black", 1_000_000]] },
] as const;

const name = (key: string) => `Action Bar ${key.toUpperCase()} ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Action bar server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // The server may still be starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the action bar server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    server = undefined;
    return;
  }
  server.kill("SIGTERM");
  const exited = await Promise.race([once(server, "exit").then(() => true), delay(5_000).then(() => false)]);
  if (!exited) server.kill("SIGKILL");
  server = undefined;
}

async function cleanup() {
  await prisma.promotionCampaign.deleteMany({ where: { id: campaignId } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: COLLECTION_SLUG } });
}

test.beforeAll(async () => {
  await cleanup();
  await prisma.collectionDefinition.create({
    data: {
      slug: COLLECTION_SLUG,
      title: "Action Bar Collection",
      description: "Bộ sưu tập kiểm thử thanh thao tác.",
      seoTitle: "Action Bar Collection",
      seoDescription: "Action bar collection",
      isPublished: true,
      pancakeCategoryIds: [],
    },
  });
  const ids: string[] = [];
  for (const spec of PRODUCTS) {
    const slug = `action-bar-${spec.key}-${runId}`;
    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP_ID,
        pancakeProductId: slug,
        slug,
        name: name(spec.key),
        isPresent: true,
        isActive: true,
        syncedAt,
        categoryMemberships: { create: [{ categoryKey: CATEGORY_KEY }] },
        content: { create: { editorialDescription: `Editorial ${spec.key}`, collectionSlugs: [COLLECTION_SLUG] } },
      },
    });
    ids.push(product.id);
    for (const [index, [size, color, price]] of spec.variants.entries()) {
      const variant = await prisma.variantMirror.create({
        data: {
          pancakeVariationId: `${slug}-${index}`,
          productId: product.id,
          color,
          size,
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: price,
          pancakeRetailPriceAfterDiscount: price,
          syncedAt,
        },
      });
      await prisma.warehouseStock.create({
        data: { variantId: variant.id, pancakeWarehouseId: `${slug}-${index}-w`, quantity: 5, syncedAt },
      });
    }
  }
  await prisma.promotionCampaign.create({
    data: {
      id: campaignId,
      kind: "PROMOTION",
      name: `Action bar promotion ${runId}`,
      discountType: "PERCENTAGE",
      percentageValue: 20,
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: ids.map((productId) => ({ productId })) },
    },
  });

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/listing-action-bar"),
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

/** The category listing and `/sale` draw one filter panel; `/shop` draws its own form, same bar. */
const BAR: Readonly<Record<string, Readonly<{ filter: string | null; sort: string }>>> = {
  [CATEGORY_PATH]: { filter: 'button[aria-controls="mobile-plp-filters"]', sort: "#plp-sort-select" },
  "/sale": { filter: 'button[aria-controls="mobile-plp-filters"]', sort: "#plp-sort-select" },
  "/shop": { filter: 'button[aria-controls="mobile-shop-drawer"]', sort: "#shop-sort-select-mobile" },
  // A collection has no filter drawer: size and stock are the chips under the bar.
  [COLLECTION_PATH]: { filter: null, sort: "#collection-sort-select" },
};
type BarPath = string;

async function open(page: Page, width: number, path: string) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
  const barPath = path.split("?")[0] as BarPath;
  // On a phone the sort is the bar's; on a desktop width `/shop` shows its other form.
  if (width < 768) await expect(page.locator(BAR[barPath]!.sort)).toBeVisible();
}

type BarMeasure = Readonly<{
  rows: number;
  overflow: number;
  controls: readonly Readonly<{ label: string; l: number; t: number; r: number; b: number; w: number; h: number }>[];
  clippedPx: number;
  visibleCountText: number;
}>;

/** Reads the bar's geometry in the page. A control's touch area is its box plus its `::after`. */
function measureBar(page: Page, path: BarPath): Promise<BarMeasure> {
  return page.evaluate(({ filterSelector, sortSelector }) => {
    const px = (value: string) => Number.parseFloat(value) || 0;
    const buttons = [
      ...document.querySelectorAll<HTMLElement>('[role="group"][aria-label="Kiểu xem ảnh"] button'),
      ...(filterSelector ? document.querySelectorAll<HTMLElement>(filterSelector) : []),
    ].filter((element) => element.getBoundingClientRect().width > 0);
    const controls = buttons.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const after = getComputedStyle(element, "::after");
      // An absolutely positioned pseudo-element is placed from the padding box, inside the border.
      const l = box.left + px(style.borderLeftWidth) + px(after.left);
      const t = box.top + px(style.borderTopWidth) + px(after.top);
      const r = box.right - px(style.borderRightWidth) - px(after.right);
      const b = box.bottom - px(style.borderBottomWidth) - px(after.bottom);
      return {
        label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        l, t, r, b,
        w: box.width,
        h: box.height,
      };
    });

    const select = document.querySelector<HTMLSelectElement>(sortSelector)!;
    const selectBox = select.getBoundingClientRect();
    const probe = select.cloneNode(true) as HTMLSelectElement;
    probe.style.cssText = "width:auto;position:absolute;visibility:hidden;max-width:none;min-width:0";
    select.parentElement!.appendChild(probe);
    const natural = probe.getBoundingClientRect().width;
    probe.remove();

    const rowTops = new Set([...buttons, select].map((element) => {
      const box = element.getBoundingClientRect();
      return Math.round((box.top + box.height / 2) / 8);
    }));

    // The result count is not drawn: only a visually hidden live copy may carry it.
    const visibleCountText = [...document.querySelectorAll("main *")].filter((element) =>
      element.children.length === 0
      && /^\s*\d+ sản phẩm/.test(element.textContent ?? "")
      && element.closest(".sr-only") === null,
    ).length;

    return {
      rows: rowTops.size,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      controls,
      clippedPx: Math.max(0, Math.round(natural - selectBox.width)),
      visibleCountText,
    };
  }, { filterSelector: BAR[path]!.filter, sortSelector: BAR[path]!.sort });
}

const PHONE_WIDTHS = [320, 360, 390, 412, 430] as const;

for (const path of [CATEGORY_PATH, "/sale", "/shop", COLLECTION_PATH]) {
  for (const width of PHONE_WIDTHS) {
    test(`${path} action bar at ${width}px: sort never clipped, hit areas never overlap, count not drawn`, async ({ page }) => {
      await open(page, width, path);
      const bar = await measureBar(page, path);

      expect(bar.overflow, "no horizontal overflow").toBeLessThanOrEqual(1);
      expect(bar.visibleCountText, "the result count is not drawn").toBe(0);
      await expect(page.locator('[role="status"].sr-only').filter({ visible: true }).first()).toContainText(/\d+ sản phẩm/);

      // From 360px the view toggle, the filter button and the sort are one line; narrower, the
      // filter button and the sort share a second line.
      if (width >= 360) expect(bar.rows, `one row at ${width}px`).toBe(1);
      else expect(bar.rows, `at most two rows at ${width}px`).toBeLessThanOrEqual(2);
      expect(bar.clippedPx, "the sort label is not clipped").toBeLessThanOrEqual(1);

      expect(bar.controls.length).toBeGreaterThanOrEqual(BAR[path]!.filter ? 4 : 3);
      for (const control of bar.controls) {
        expect(control.r - control.l, `${control.label} touch width`).toBeGreaterThanOrEqual(40);
        expect(control.b - control.t, `${control.label} touch height`).toBeGreaterThanOrEqual(44);
      }
      for (let i = 0; i < bar.controls.length; i += 1) {
        for (let j = i + 1; j < bar.controls.length; j += 1) {
          const a = bar.controls[i]!;
          const b = bar.controls[j]!;
          const overlapX = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const overlapY = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          expect(overlapX > 0.5 && overlapY > 0.5, `${a.label} and ${b.label} touch areas overlap`).toBe(false);
        }
      }
    });
  }

  test(`${path}: a tap at either edge of a view option selects that option`, async ({ page }) => {
    await open(page, 360, path);
    // `/shop` keeps a second, hidden toggle for its desktop form.
    const options = page.locator('[role="group"][aria-label="Kiểu xem ảnh"] button').filter({ visible: true });
    await expect(options).toHaveCount(3);

    for (const index of [2, 0, 1]) {
      const bar = await measureBar(page, path);
      const hit = bar.controls[index]!;
      const y = (hit.t + hit.b) / 2;
      for (const x of [hit.l + 1, hit.r - 1]) {
        // Select a different option first, so the tap has something to change.
        await options.nth((index + 1) % 3).click();
        await expect(options.nth((index + 1) % 3)).toHaveAttribute("aria-pressed", "true");
        await page.mouse.click(x, y);
        await expect(options.nth(index), `tap at x=${Math.round(x)}`).toHaveAttribute("aria-pressed", "true");
        for (const other of [0, 1, 2].filter((value) => value !== index)) {
          await expect(options.nth(other)).toHaveAttribute("aria-pressed", "false");
        }
      }
    }
  });
}

test("the category listing keeps 'Còn hàng' and 'Sale'; the sale listing leaves them out", async ({ page }) => {
  // Scoped to the filter bar: the header's own "SALE" link is not the toggle.
  await open(page, 1280, CATEGORY_PATH);
  const categoryBar = page.locator("#bo-loc");
  await expect(categoryBar.getByRole("link", { name: "Còn hàng", exact: true })).toBeVisible();
  await expect(categoryBar.getByRole("link", { name: "Sale", exact: true })).toBeVisible();

  await open(page, 1280, "/sale");
  const saleBar = page.locator("#bo-loc");
  await expect(saleBar.getByRole("link", { name: "Còn hàng", exact: true })).toHaveCount(0);
  await expect(saleBar.getByRole("link", { name: "Sale", exact: true })).toHaveCount(0);
  for (const size of ["S", "M", "L"]) {
    await expect(saleBar.getByRole("link", { name: size, exact: true })).toBeVisible();
  }
});

const card = (page: Page, key: string) => page.locator("article", { hasText: name(key) });

test("/sale filters by size, sorts, filters by price, and clears; a card shows the matched variant's price", async ({ page }) => {
  await open(page, 1280, "/sale");
  for (const key of ["a", "b", "c", "d"]) await expect(card(page, key)).toBeVisible();

  await page.getByRole("link", { name: "L", exact: true }).click();
  await page.waitForURL(/[?&]size=L(&|$)/);
  await expect(card(page, "a")).toBeVisible();
  await expect(card(page, "d")).toBeVisible();
  await expect(card(page, "b")).toHaveCount(0);
  await expect(card(page, "c")).toHaveCount(0);

  await page.selectOption("#plp-sort-select", "price-desc");
  await page.waitForURL(/sort=price-desc/);
  expect(page.url()).toContain("size=L");

  await page.getByLabel("Giá tối thiểu").fill("700000");
  await page.getByRole("button", { name: "Lọc", exact: true }).click();
  await page.waitForURL(/minPrice=700000/);
  await expect(card(page, "d")).toBeVisible();
  await expect(card(page, "a")).toHaveCount(0);
  // D is 160k in M and 800k in L: under size L it must show L's price, not the cheapest size's.
  await expect(card(page, "d")).toContainText("800.000");
  await expect(card(page, "d")).not.toContainText("160.000");

  await page.getByRole("link", { name: "Xóa bộ lọc" }).first().click();
  await page.waitForURL(`${BASE_URL}/sale`);
  for (const key of ["a", "b", "c", "d"]) await expect(card(page, key)).toBeVisible();
  await expect(card(page, "d")).toContainText("160.000");
});

test("/sale with nothing matching says so and offers the way out; a sub-listing keeps its own path", async ({ page }) => {
  await open(page, 390, "/sale?size=XXL");
  await expect(page.getByRole("heading", { name: "Không có sản phẩm phù hợp." })).toBeVisible();
  await page.getByRole("link", { name: "Xóa bộ lọc" }).last().click();
  await page.waitForURL(`${BASE_URL}/sale`);

  await open(page, 1280, "/sale/uu-dai?size=L");
  await page.getByRole("link", { name: "M", exact: true }).click();
  await page.waitForURL(/\/sale\/uu-dai\?size=M/);
  await expect(card(page, "c")).toBeVisible();
});

test("/shop: the phone bar is the shared one, with the search on its own line and the count badge on the funnel", async ({ page }) => {
  await open(page, 390, "/shop?size=M&availability=in-stock");
  const bar = await measureBar(page, "/shop");
  const trigger = page.locator(BAR["/shop"]!.filter);

  // The funnel is icon-only at this width, but keeps its name and its count of applied filters.
  await expect(trigger).toHaveAccessibleName(/Bộ lọc/);
  await expect(trigger.getByText("2", { exact: true })).toBeVisible();
  const triggerBox = (await trigger.boundingBox())!;
  const badgeBox = (await trigger.getByText("2", { exact: true }).boundingBox())!;
  expect(badgeBox.x + badgeBox.width, "the badge sits at the funnel's corner").toBeGreaterThan(triggerBox.x + triggerBox.width - 8);
  expect(bar.rows, "bar is one row").toBe(1);

  // The search is its own line below the bar, full width.
  const search = page.getByLabel("Tìm sản phẩm").filter({ visible: true });
  const searchBox = (await search.boundingBox())!;
  const sortBox = (await page.locator(BAR["/shop"]!.sort).boundingBox())!;
  expect(searchBox.y).toBeGreaterThan(sortBox.y + sortBox.height - 1);
  expect(searchBox.width).toBeGreaterThan(300);
  expect(searchBox.height).toBeGreaterThanOrEqual(36);
});

test("/shop: re-sorting and searching from the bar keep the applied filters", async ({ page }) => {
  await open(page, 390, "/shop?size=M");
  await page.selectOption(BAR["/shop"]!.sort, "price-desc");
  await page.waitForURL(/sort=price-desc/);
  expect(page.url()).toContain("size=M");

  const search = page.getByLabel("Tìm sản phẩm").filter({ visible: true });
  await search.fill("Action Bar");
  await search.press("Enter");
  await page.waitForURL(/q=Action(\+|%20)Bar/);
  expect(page.url()).toContain("size=M");
  expect(page.url()).toContain("sort=price-desc");
  for (const key of ["a", "c", "d"]) await expect(card(page, key)).toBeVisible();
  await expect(card(page, "b")).toHaveCount(0);
});

test("/shop on a desktop: no visible count, the view toggle on the left, search and sort on the right", async ({ page }) => {
  await open(page, 1280, "/shop");
  await expect(page.locator('[role="status"].sr-only').first()).toContainText(/\d+ sản phẩm/);
  const leaked = await page.evaluate(() =>
    [...document.querySelectorAll("main *")].filter((element) =>
      element.children.length === 0
      && /^\s*\d+ sản phẩm/.test(element.textContent ?? "")
      && element.closest(".sr-only") === null,
    ).length,
  );
  expect(leaked, "the result count is not drawn").toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const toggle = page.locator('[role="group"][aria-label="Kiểu xem ảnh"]').filter({ visible: true });
  await expect(toggle).toHaveCount(1);
});

test("a collection's action row is one line, with the size chips on the line under it", async ({ page }) => {
  await open(page, 390, COLLECTION_PATH);
  const bar = await measureBar(page, COLLECTION_PATH);
  expect(bar.rows, "view size and sort share one row").toBe(1);

  const sortBox = (await page.locator(BAR[COLLECTION_PATH]!.sort).boundingBox())!;
  const chips = page.getByRole("navigation", { name: "Lọc theo kích cỡ" });
  await expect(chips).toBeVisible();
  const chipsBox = (await chips.boundingBox())!;
  expect(chipsBox.y, "the chips are under the bar").toBeGreaterThan(sortBox.y + sortBox.height - 1);

  // The sort still works from the one-line bar.
  const sort = page.getByRole("navigation", { name: "Sắp xếp bộ sưu tập" }).getByRole("combobox");
  await expect(sort).toBeVisible();
  const current = await sort.inputValue();
  const next = await sort.locator("option").evaluateAll(
    (all, selected) => all.map((option) => (option as HTMLOptionElement).value).find((value) => value !== selected),
    current,
  );
  expect(next, "a second sort option exists").toBeTruthy();
  await sort.selectOption(next!);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === next);
  await expect(page.locator(BAR[COLLECTION_PATH]!.sort)).toBeVisible();
});
