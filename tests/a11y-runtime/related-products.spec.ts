import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3223;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_016;
const suffix = `${Date.now()}-${process.pid}`;
const collectionSlug = `u4-related-${suffix}`;
const currentSlug = `u4-current-${suffix}`;
const soloSlug = `u4-solo-${suffix}`;
const currentName = `Current U4 Jacket ${suffix}`;
const draftCandidateName = `Alpha Draft Candidate ${suffix}`;
const publishedCandidateName = `Bravo Published Candidate ${suffix}`;
const hiddenCandidateName = `Hidden Candidate ${suffix}`;
const pinnedName = `Zulu Pinned Override ${suffix}`;
const collectionOnlyName = `Collection Only Candidate ${suffix}`;
const syncedAt = new Date("2026-08-26T00:00:00.000Z");

/**
 * The category the candidates share. Related products are selected by website-owned category
 * membership (ADR 0013 §7), not by collection: this spec previously seeded a shared collection and
 * asserted the resulting list, which was the contract M3a supersedes.
 */
const SHARED_CATEGORY = "aoDaiTet";
/** A different top-level tree, so the pinned product can only arrive as a manual override. */
const PINNED_CATEGORY = "vayDam";

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`U4 server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${currentSlug}`, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for U4 server\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) server.kill("SIGKILL");
}

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
  await prisma.collectionDefinition.deleteMany({ where: { slug: collectionSlug } });
}

async function seedProduct({
  key,
  slug,
  name,
  collectionSlugs = [],
  categoryKeys = [],
  status = "PUBLISHED",
  isActive = true,
}: {
  key: string;
  slug: string;
  name: string;
  collectionSlugs?: string[];
  categoryKeys?: string[];
  status?: "DRAFT" | "PUBLISHED";
  isActive?: boolean;
}): Promise<string> {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `u4-${key}-${suffix}`,
      slug,
      name,
      isPresent: true,
      isActive,
      syncedAt,
      content: {
        create: {
          status,
          editorialDescription: status === "PUBLISHED" ? `Editorial ${key}` : null,
          collectionSlugs,
        },
      },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `u4-${key}-variant-${suffix}`,
      productId: product.id,
      color: "Ink",
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: 900_000,
      pancakeRetailPriceAfterDiscount: 900_000,
      syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: {
      variantId: variant.id,
      pancakeWarehouseId: `u4-${key}-warehouse-${suffix}`,
      quantity: 2,
      syncedAt,
    },
  });
  if (categoryKeys.length > 0) {
    await prisma.productCategoryMembership.createMany({
      data: categoryKeys.map((categoryKey) => ({ productId: product.id, categoryKey })),
    });
  }
  return product.id;
}

test.beforeAll(async () => {
  await cleanup();
  await prisma.collectionDefinition.create({
    data: {
      slug: collectionSlug,
      title: "U4 Published Collection",
      description: "Published collection for deterministic related products.",
      isPublished: true,
    },
  });
  // The source product shares a category with the candidates AND a collection with the
  // collection-only product below. Both are seeded on purpose: the collection is what proves the
  // superseded fallback is gone rather than merely unused.
  const currentId = await seedProduct({
    key: "current",
    slug: currentSlug,
    name: currentName,
    collectionSlugs: [collectionSlug],
    categoryKeys: [SHARED_CATEGORY],
  });
  await seedProduct({
    key: "draft",
    slug: `u4-draft-${suffix}`,
    name: draftCandidateName,
    status: "DRAFT",
    categoryKeys: [SHARED_CATEGORY],
  });
  const publishedId = await seedProduct({
    key: "published",
    slug: `u4-published-${suffix}`,
    name: publishedCandidateName,
    categoryKeys: [SHARED_CATEGORY],
  });
  await seedProduct({
    key: "hidden",
    slug: `u4-hidden-${suffix}`,
    name: hiddenCandidateName,
    isActive: false,
    categoryKeys: [SHARED_CATEGORY],
  });
  // Shares the source product's collection but no category. Under the superseded contract this
  // would have been a related product; under ADR 0013 §7 step 4 it must never appear.
  await seedProduct({
    key: "collection-only",
    slug: `u4-collection-only-${suffix}`,
    name: collectionOnlyName,
    collectionSlugs: [collectionSlug],
  });
  // In a different top-level tree, so it can only reach the list as a manual override (§7 step 1).
  const pinnedId = await seedProduct({
    key: "pinned",
    slug: `u4-pinned-${suffix}`,
    name: pinnedName,
    categoryKeys: [PINNED_CATEGORY],
  });
  await seedProduct({ key: "solo", slug: soloSlug, name: `Solo Product ${suffix}` });

  await prisma.relatedProductOverride.create({
    data: { productId: currentId, relatedProductId: pinnedId, position: 0 },
  });
  // Ranking the published candidate first in this category must beat the unranked draft
  // candidate's earlier name — rank is a decision, name is only a tie-break (§7).
  await prisma.categoryProductOrder.create({
    data: { categoryKey: SHARED_CATEGORY, productId: publishedId, position: 0 },
  });

  server = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      // Next 16 dev permits one server per build directory and guards it with a lock
      // file there. Every spec drives this one project, so they share that lock unless
      // each gets its own directory -- and a server that has to be SIGKILLed leaves the
      // lock behind, which makes the next spec's server refuse to start entirely.
      NEXT_DIST_DIR: ".next-test/related-products",
      APP_DOMAIN: `${HOST}:${PORT}`,
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

test("U4 PDP renders deterministic visible related products from website-owned category membership", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/shop/${currentSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const related = page.getByRole("region", { name: "Hoàn thiện phối đồ" });
  await expect(related).toBeVisible();
  const names = await related.locator("article h2").allTextContents();
  // ADR 0013 §7, end to end: the manual override first even though it sits in another tree, then
  // the merchandised rank, then the unranked candidate by name.
  expect(names).toEqual([pinnedName, publishedCandidateName, draftCandidateName]);
  await expect(related.getByText(currentName, { exact: true })).toHaveCount(0);
  await expect(related.getByText(hiddenCandidateName, { exact: true })).toHaveCount(0);
  // §7 step 4: no collection fallback at any stage. This product shares the source's collection and
  // nothing else, and the superseded implementation would have listed it.
  await expect(related.getByText(collectionOnlyName, { exact: true })).toHaveCount(0);
  await expect(related.locator('a[href="/size-guide"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const accessibilityScan = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test("U4 PDP omits the related-products region when category membership has no candidates", async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/shop/${soloSlug}`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("region", { name: "Hoàn thiện phối đồ" })).toHaveCount(0);
});
