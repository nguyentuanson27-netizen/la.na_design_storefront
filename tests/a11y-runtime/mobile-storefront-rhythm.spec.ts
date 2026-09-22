import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { PUBLIC_LEGAL_FACTS } from "../../src/content/public-brand-facts.ts";
import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

/**
 * The phone's vertical rhythm, and the one legal fact that belongs on every width.
 *
 * Four owner findings, read on a 390x844 screen:
 *
 *   1. the PDP product frame should use the owner-confirmed 2:3 portrait ratio below `lg`, so
 *      phone and tablet product media share one predictable vertical frame;
 *   2. `Áo dài La.na Design` was set at body size with a section break's worth of air around it,
 *      while `Set đồ` and `Váy, đầm` were cream serif overlaid on their images: the same kind of
 *      content in two design languages, neither of which read as a heading;
 *   3. the service strip spent ~155px on three short facts;
 *   4. the footer's legal block did not name the legal representative.
 *
 * What is asserted here is the *relationship*, not a pixel count: the hero's ratio, the three
 * category names sharing one computed type treatment, the strip being materially shorter than the
 * layout it replaced, and the representative present at both widths. A test that pinned 28px would
 * fail the next time the scale moves without anything actually regressing.
 */

const HOST = "127.0.0.1";
const PORT = 3323;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_035;
const runId = `${Date.now()}-${process.pid}`;
const syncedAt = new Date("2026-09-20T02:00:00.000Z");
const IMAGE = (name: string) => `https://content.pancake.vn/1/2/3/4/${name}-${runId}.jpg`;

const MOBILE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

const PRODUCT_SLUG = `rhythm-product-${runId}`;
const PRODUCT_NAME = `Rhythm Áo dài ${runId}`;

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
      throw new Error(`Mobile rhythm server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      // Every storefront page mounts useAccountAuth(), which calls the Better Auth catch-all as
      // soon as it hydrates. Waiting on the page alone lets Playwright navigate while that route
      // still answers a transient 404.
      if (pageResponse.status < 500 && authResponse.status === 200) return;
    } catch {
      // Next dev may still be compiling either the page or the auth route.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for mobile rhythm server\n${serverOutput}`);
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

type ParkedCollection = { slug: string; isPublished: boolean; homepagePosition: number | null };

let parkedCollections: ParkedCollection[] = [];

/**
 * The collection rail renders from rows this spec does not own, and it sits between the category
 * editorial and the service strip. Park it so the homepage this spec measures is the one it seeded.
 */
async function parkCollections() {
  parkedCollections = await prisma.collectionDefinition.findMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    select: { slug: true, isPublished: true, homepagePosition: true },
  });
  await prisma.collectionDefinition.updateMany({
    where: { OR: [{ isPublished: true }, { homepagePosition: { not: null } }] },
    data: { isPublished: false, homepagePosition: null },
  });
}

async function restoreCollections() {
  for (const parked of parkedCollections) {
    await prisma.collectionDefinition.update({
      where: { slug: parked.slug },
      data: { isPublished: parked.isPublished, homepagePosition: parked.homepagePosition },
    });
  }
}

const CATEGORY_KEYS = ["aoDai", "setDo", "vayDam"] as const;

type ParkedCategoryMedia = {
  categoryKey: string;
  heroImageUrl: string | null;
  megaMenuImageUrl: string | null;
};

/** `null` marks a key that had no row, so restoring it means removing the fixture again. */
let parkedCategoryMedia = new Map<string, ParkedCategoryMedia | null>();

/**
 * `CategoryEditorialMedia` is canonical per `categoryKey` and carries the mega-menu image as well
 * as the hero, so deleting a row to make room for a fixture destroys configured media that this
 * spec never owned -- on a dev or shared test database that is real content, gone. Snapshot first
 * and write the hero through an upsert, exactly as `parkCollections` does for the rail.
 *
 * `megaMenuImageUrl` is deliberately left as it is rather than nulled: the homepage reads only the
 * hero, so overwriting the other field would be destroying more than the test needs.
 */
async function parkCategoryMedia() {
  const existing = await prisma.categoryEditorialMedia.findMany({
    where: { categoryKey: { in: [...CATEGORY_KEYS] } },
    select: { categoryKey: true, heroImageUrl: true, megaMenuImageUrl: true },
  });
  parkedCategoryMedia = new Map(CATEGORY_KEYS.map((key) => [key as string, null]));
  for (const row of existing) parkedCategoryMedia.set(row.categoryKey, row);

  // §19 and §21 both need configured media, or the sections omit themselves and there is nothing
  // to compare.
  for (const categoryKey of CATEGORY_KEYS) {
    await prisma.categoryEditorialMedia.upsert({
      where: { categoryKey },
      update: { heroImageUrl: IMAGE(`editorial-${categoryKey}`) },
      create: { categoryKey, heroImageUrl: IMAGE(`editorial-${categoryKey}`) },
    });
  }
}

/** Puts back what was there, and removes the fixture where there was nothing. */
async function restoreCategoryMedia() {
  for (const [categoryKey, parked] of parkedCategoryMedia) {
    if (parked) {
      await prisma.categoryEditorialMedia.update({
        where: { categoryKey },
        data: {
          heroImageUrl: parked.heroImageUrl,
          megaMenuImageUrl: parked.megaMenuImageUrl,
        },
      });
    } else {
      await prisma.categoryEditorialMedia.deleteMany({ where: { categoryKey } });
    }
  }
  parkedCategoryMedia = new Map();
}

/** Only what this spec created. `SHOP_ID` is its own, so no other fixture's products are in it. */
async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

/** One sellable, published product carrying a trusted image, so the PDP renders its hero. */
async function seedProduct() {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: PRODUCT_SLUG,
      slug: PRODUCT_SLUG,
      name: PRODUCT_NAME,
      primaryImageUrl: IMAGE("product-hero"),
      isPresent: true,
      isActive: true,
      syncedAt,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      content: { create: { status: "PUBLISHED", collectionSlugs: [] } },
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${PRODUCT_SLUG}-variant`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 1_200_000,
      pancakeRetailPriceAfterDiscount: 1_200_000,
      syncedAt,
    },
  });

  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `${PRODUCT_SLUG}-warehouse`,
      quantity: 4,
      syncedAt,
    },
  });
}

test.beforeAll(async () => {
  await cleanup();
  await parkCollections();
  await parkCategoryMedia();
  await seedProduct();

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock file there.
      NEXT_DIST_DIR: ".next-test/mobile-storefront-rhythm",
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
  await restoreCategoryMedia();
  await restoreCollections();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.route("**/_next/image**", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: TINY_JPEG_BUFFER });
  });
});

/** The element's own painted ratio, which is what a shopper sees regardless of how it was set. */
async function ratioOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not laid out");
  return box.width / box.height;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

/** The computed type treatment a category name is rendered with. */
async function typeTreatmentOf(locator: Locator) {
  return locator.evaluate((element) => {
    // The nearest ancestor that actually paints, since the name itself is transparent.
    const backgroundBehind = (node: Element): string => {
      for (let current: Element | null = node; current; current = current.parentElement) {
        const background = getComputedStyle(current).backgroundColor;
        if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
          return background;
        }
      }
      return "rgba(0, 0, 0, 0)";
    };

    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      color: style.color,
      textAlign: style.textAlign,
      position: style.position,
      // The surface the name is set on. Matching type on mismatched grounds still reads as two
      // different components, which is the form the original inconsistency came back in once the
      // labels came off the photographs.
      background: backgroundBehind(element),
    };
  });
}

test("the PDP frame is 2:3 and hides the identity eyebrow below lg, while desktop stays unchanged", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 720 },
    MOBILE,
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/shop/${PRODUCT_SLUG}`, { waitUntil: "networkidle" });

    const hero = page.getByRole("region", { name: `Ảnh chính của ${PRODUCT_NAME}` });
    await expect(hero).toBeVisible();

    // 2:3 is width / height = 0.666..., and the same below-`lg` rule owns phone + tablet.
    expect(await ratioOf(hero)).toBeCloseTo(2 / 3, 2);

    // The photograph still fills that frame rather than letterboxing inside it.
    await expect(hero.locator("img").first()).toHaveCSS("object-fit", "cover");

    // The owner asked to remove this implementation/category eyebrow from the mobile PDP.
    await expect(
      page.locator("p.eyebrow").filter({ hasText: "/ Sản phẩm" }),
    ).toBeHidden();
  }

  // Desktop keeps the approved media stage and identity context.
  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE_URL}/shop/${PRODUCT_SLUG}`, { waitUntil: "networkidle" });
  const hero = page.getByRole("region", { name: `Ảnh chính của ${PRODUCT_NAME}` });
  const desktopBox = await hero.boundingBox();
  expect(desktopBox!.height).toBeGreaterThan(DESKTOP.height * 0.9);
  await expect(
    page.locator("p.eyebrow").filter({ hasText: "/ Sản phẩm" }),
  ).toBeVisible();
});

test("Áo dài, Set đồ and Váy, đầm are drawn with one visual system on a phone", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const aoDaiTitle = page.locator('[data-homepage-region="lead-category"] h2');
  const otherTitles = page.locator(".category-editorial__label");
  await expect(aoDaiTitle).toHaveText(`Áo dài La.na Design`);
  await expect(otherTitles).toHaveCount(2);

  const treatments = [
    await typeTreatmentOf(aoDaiTitle),
    await typeTreatmentOf(otherTitles.nth(0)),
    await typeTreatmentOf(otherTitles.nth(1)),
  ];

  // One type treatment across all three. Before this, Áo dài was ~16px sans in ink and the other
  // two were 24px serif in cream, positioned absolutely over their photographs.
  const [lead] = treatments;
  for (const treatment of treatments) {
    expect(treatment.fontFamily).toBe(lead!.fontFamily);
    expect(treatment.fontSize).toBeCloseTo(lead!.fontSize, 1);
    expect(treatment.fontWeight).toBe(lead!.fontWeight);
    expect(treatment.color).toBe(lead!.color);
    expect(treatment.textAlign).toBe(lead!.textAlign);
    expect(treatment.background).toBe(lead!.background);
    // In normal flow under the image, not floated over it.
    expect(treatment.position).toBe("static");
  }

  // The owner's actual complaint: the name read as a caption. It is a heading now.
  expect(lead!.fontSize).toBeGreaterThanOrEqual(24);
  expect(lead!.fontWeight).toBe("400");

  // Each image sits above its own name rather than behind it.
  for (const [media, title] of [
    [page.locator(".lead-editorial__media"), aoDaiTitle],
    [page.locator(".category-editorial__media").nth(0), otherTitles.nth(0)],
    [page.locator(".category-editorial__media").nth(1), otherTitles.nth(1)],
  ] as const) {
    const mediaBox = (await media.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.y).toBeGreaterThanOrEqual(mediaBox.y + mediaBox.height - 1);
    // Tight enough to read as one block: the gap was 3rem before.
    expect(titleBox.y - (mediaBox.y + mediaBox.height)).toBeLessThanOrEqual(24);
  }

  // Destinations are presentation-independent and must not have moved.
  const blocks = page.locator(".category-editorial__block");
  await expect(blocks.nth(0)).toHaveAttribute("href", "/set-do");
  await expect(blocks.nth(1)).toHaveAttribute("href", "/vay-dam");
  const subcategoryHrefs = await page
    .locator('[data-homepage-region="lead-category"]')
    .getByRole("navigation", { name: "Áo dài" })
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(subcategoryHrefs).toEqual([
    "/ao-dai/cach-tan",
    "/ao-dai/tet",
    "/ao-dai/cuoi",
    "/ao-dai/4-ta",
    "/ao-dai/6-ta",
  ]);

  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test("the service strip keeps all three facts in a compact block on a phone", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  const strip = page.locator('[data-homepage-region="service"]');
  const items = strip.locator("li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("Đổi trả trong 15 ngày");
  await expect(items.nth(1)).toHaveText("Giao hàng toàn quốc");
  await expect(items.nth(2)).toHaveText("Tư vấn size 08:00–22:00");

  // The block used to run to roughly 155px on this viewport: 2rem of padding top and bottom, three
  // 0.875rem rows and 1rem between them. A ceiling rather than an exact number, because what the
  // owner asked for is "materially shorter", not one specific height.
  const box = (await strip.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(120);

  // ...and not shrunk into illegibility. 12px is the floor the rest of the system's uppercase
  // micro-copy already sits on.
  const fontSize = await items
    .nth(0)
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(12);

  // Every fact is still on its own line: compacting must not have collapsed them into a run-on.
  const tops = await items.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(3);

  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test("the footer names the legal representative at both widths, without overflowing", async ({
  page,
}) => {
  for (const viewport of [MOBILE, DESKTOP]) {
    await page.setViewportSize(viewport);
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

    const legal = page.locator("[data-footer-legal]");
    await legal.scrollIntoViewIfNeeded();

    // The new line, beside the facts it must not have displaced.
    await expect(legal).toContainText(
      `Đại diện pháp luật: ${PUBLIC_LEGAL_FACTS.legalRepresentative}`,
    );
    await expect(legal).toContainText(PUBLIC_LEGAL_FACTS.legalEntityName);
    await expect(legal).toContainText(PUBLIC_LEGAL_FACTS.registeredAddress);
    await expect(legal).toContainText(
      `MST: ${PUBLIC_LEGAL_FACTS.taxCode} - ngày cấp: ${PUBLIC_LEGAL_FACTS.taxIdIssueDate}`,
    );
    await expect(legal).toContainText(`Email: ${PUBLIC_LEGAL_FACTS.legalEmail}`);

    // The line wraps inside the block rather than pushing it wider than the page.
    const box = (await legal.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  }
});

test("the mobile menu close control keeps a practical touch target", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const closeMenu = page.getByRole("button", { name: "Đóng menu", exact: true });
  await expect(closeMenu).toBeVisible();

  const box = await closeMenu.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);

  await closeMenu.click();
  await expect(page.getByRole("dialog", { name: "Menu điều hướng" })).toHaveCount(0);
});

test("the reworked surfaces stay accessible on a phone", async ({ page }) => {
  await page.setViewportSize(MOBILE);

  for (const path of ["/", `/shop/${PRODUCT_SLUG}`]) {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });

    // The category names lost their drop shadow when they came off the photographs, so their
    // contrast is now the page's own -- which is exactly what Axe is being asked about here.
    const results = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
    expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
      [],
    );

    // The first Tab must still leave the body, on both reworked pages.
    await page.keyboard.press("Tab");
    const tagName = await page.evaluate(() => document.activeElement?.tagName ?? "BODY");
    expect(tagName, path).not.toBe("BODY");
  }
});
