/**
 * I9 — the `Dự kiến có hàng` line on a real product page, in a real browser.
 *
 * This is not a nicety. Google's `availability_date` contract requires the date to be **visible on
 * the landing page**, so the feed's `backorder` row is only truthful if this line actually renders
 * for the same variant. The parity unit suite proves the three surfaces agree about the value; this
 * proves the page a crawler and a shopper both land on says it out loud.
 *
 * The seed puts two sizes of one preorder product in deliberately different cycle states — M live,
 * L already lapsed — because owner rule 10's real content is what must *not* appear: L's absence of
 * a date must not be filled in by M's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { BUYER_AXE_TAGS } from "./axe-tags";

const HOST = "127.0.0.1";
const PORT = 3231;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_026;
const runId = `${Date.now()}-${process.pid}`;
const slug = `i9-preorder-availability-${runId}`;
const productExternalId = `i9-product-${runId}`;
const variationM = `i9-variant-m-${runId}`;
const variationL = `i9-variant-l-${runId}`;
const productName = `I9 Preorder Availability Shirt ${runId}`;

/**
 * Dates are pinned relative to the run, not hard-coded: a fixed `2026-10-03` would start passing
 * for the wrong reason the day it falls into the past. The live one is comfortably inside Google's
 * one-year limit; the lapsed one is yesterday in Vietnam whatever day the suite runs.
 */
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
function vietnamDay(offsetDays: number): { iso: string; label: string } {
  const shifted = new Date(Date.now() + VIETNAM_OFFSET_MS + offsetDays * 86_400_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return { iso: `${year}-${month}-${day}`, label: `${day}/${month}/${year}` };
}
const live = vietnamDay(10);
const lapsed = vietnamDay(-1);

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer) {
  serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js preorder PDP server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/shop/${slug}`, { redirect: "manual" });
      if (response.status === 200 && (await response.text()).includes(productName)) return;
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for preorder PDP server\n${serverOutput}`);
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
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: productExternalId } });
}

test.beforeAll(async () => {
  await cleanup();
  const now = new Date();
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: productExternalId,
      slug,
      name: productName,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      content: { create: { editorialDescription: "I9 preorder availability browser regression." } },
      // The variant is only ever `Đặt trước` because the owner put this product on preorder.
      sellingPolicy: { create: { sellingMode: "PREORDER", negativeStockLimit: -20 } },
    },
  });

  for (const [externalId, size, availabilityDate] of [
    [variationM, "M", live.iso],
    [variationL, "L", lapsed.iso],
  ] as const) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: externalId,
        productId: product.id,
        color: null,
        size,
        pancakeRetailPrice: 500_000,
        pancakeRetailPriceAfterDiscount: 500_000,
        isPresent: true,
        isActive: true,
        syncedAt: now,
      },
    });
    // Sold out, which is what puts a preorder variant into a cycle at all.
    await prisma.warehouseStock.create({
      data: {
        variantId: variant.id,
        pancakeWarehouseId: `i9-wh-${size}-${runId}`,
        quantity: 0,
        syncedAt: now,
      },
    });
    // Fifteen days back, as the rule produced it — the table's CHECK also refuses a promise that
    // precedes its own cycle start, so a lazy `start = date` fixture would not even insert.
    const availableOn = new Date(`${availabilityDate}T00:00:00.000Z`);
    const startedOn = new Date(availableOn.getTime() - 15 * 86_400_000);
    await prisma.variantAvailabilityCycle.create({
      data: {
        variantId: variant.id,
        cycleStartDate: startedOn,
        availabilityDate: availableOn,
        lastStockNonPositive: true,
        lastPreorder: true,
      },
    });
  }

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

test("I9 the preorder date is on the landing page for the selected size only", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const dateLine = page.getByText(/Dự kiến có hàng:/);
  const sizes = page.getByRole("group", { name: "Kích cỡ" });
  // The radio itself is `sr-only` with the visible swatch over it, so the swatch is what a shopper
  // actually hits — the same way every other storefront spec here chooses a size.
  const chooseSize = async (size: string) => {
    await sizes.getByText(size, { exact: true }).click();
    await expect(page.getByRole("radio", { name: size, exact: true })).toBeChecked();
  };

  await page.goto(`${BASE_URL}/shop/${slug}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: productName })).toBeVisible();
  // Nothing before the shopper chooses a size: a date shown here would belong to no variant.
  await expect(dateLine).toHaveCount(0);

  await chooseSize("M");
  await expect(dateLine).toBeVisible();
  await expect(dateLine).toHaveText(`Dự kiến có hàng: ${live.label}`);
  // It is a live region, because it changes under the shopper as they switch sizes.
  await expect(dateLine).toHaveAttribute("aria-live", "polite");
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();

  // Owner rule 8: L's cycle lapsed, so its dated promise is over — and M's date must not stand in
  // for it. The shopper can still order, which is the half the feed is not allowed to copy.
  await chooseSize("L");
  await expect(dateLine).toHaveCount(0);
  await expect(page.getByText(live.label)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm vào giỏ hàng" })).toBeEnabled();

  // Back to M, so a disappearing line cannot be mistaken for a line that never renders twice.
  await chooseSize("M");
  await expect(dateLine).toHaveText(`Dự kiến có hàng: ${live.label}`);

  const accessibility = await new AxeBuilder({ page }).withTags(BUYER_AXE_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
});
