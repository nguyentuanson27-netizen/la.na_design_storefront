import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/prisma.ts";
import { NEXT_SERVER_COMMAND, nextServerEnv } from "./next-server-mode";

/**
 * The product page names the gift / quantity-tier campaigns covering it under the price, by the
 * campaign's own name and nothing else. A gift campaign whose gifts cannot be granted today is not
 * named at all.
 */

const HOST = "127.0.0.1";
const PORT = 3341;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = resolve(import.meta.dirname, "../..");
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const SHOP_ID = 920_041;
const runId = `${Date.now()}-${process.pid}`;
const P = `pdp-offers-${runId}`;
const syncedAt = new Date("2026-10-01T03:00:00.000Z");
const productSlug = `${P}-product`;
const productName = `PDP Offers Dress ${runId}`;
const tierName = `Mua 2 giảm 10% ${runId}`;
const giftName = `Mua 2 tặng túi vải ${runId}`;
const soldOutGiftName = `Mua 2 tặng khăn lụa ${runId}`;

let server: ChildProcess | undefined;
let serverOutput = "";

async function cleanup() {
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: "pdp-offers-" } } });
  await prisma.cartItem.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP_ID } } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

async function product(suffix: string, name: string, stock: number) {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name,
      isPresent: true, isActive: true, syncedAt,
      content: { create: { status: "PUBLISHED", editorialDescription: `${name} fixture.` } },
    },
  });
  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId: `${P}-${suffix}-v`, productId: created.id, size: "M", isPresent: true, isActive: true,
      pancakeRetailPrice: 790_000, pancakeRetailPriceAfterDiscount: 790_000, syncedAt,
    },
  });
  await prisma.warehouseStock.create({
    data: { variantId: variant.id, pancakeWarehouseId: `${P}-${suffix}-wh`, quantity: stock, syncedAt },
  });
  return { productId: created.id, variantId: variant.id };
}

function giftCampaign(id: string, name: string, giftVariantId: string, stackPriority: number) {
  return prisma.giftQuantityCampaign.create({
    data: {
      id, kind: "GIFT_ITEM", name, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"],
      giftTrigger: "QUANTITY", minimumQuantity: 2, maxGiftsPerOrder: 1, allowDuplicateGifts: false,
      isEnabled: true, enabledAt: syncedAt, stackPriority,
      giftOptions: { create: [{ variantId: giftVariantId }] },
    },
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Next.js PDP offers server exited with ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const [pageResponse, authResponse] = await Promise.all([
        fetch(`${BASE_URL}/shop/${productSlug}`, { redirect: "manual" }),
        fetch(`${BASE_URL}/api/auth/get-session`, { redirect: "manual" }),
      ]);
      if (pageResponse.status === 200 && authResponse.status === 200 && (await pageResponse.text()).includes(productName)) {
        return;
      }
    } catch {
      // Next dev may still be compiling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for the PDP offers server\n${serverOutput}`);
}

test.beforeAll(async () => {
  await cleanup();
  const paid = await product("product", productName, 5);
  await prisma.productCategoryMembership.create({ data: { productId: paid.productId, categoryKey: "vayDam" } });
  const gift = await product("gift", `Gift bag ${runId}`, 3);
  const soldOutGift = await product("sold-out-gift", `Gift scarf ${runId}`, 0);

  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-tier`, kind: "QUANTITY_TIER", name: tierName, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"],
      tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      isEnabled: true, enabledAt: syncedAt, stackPriority: 1,
      tiers: { create: [{ minQuantity: 2, discountValue: 10 }] },
    },
  });
  // Ahead of the in-stock gift in stack order, so it would take a slot if it were named.
  await giftCampaign(`${P}-sold-out-gift`, soldOutGiftName, soldOutGift.variantId, 2);
  await giftCampaign(`${P}-gift`, giftName, gift.variantId, 3);

  server = spawn(process.execPath, [NEXT_CLI, NEXT_SERVER_COMMAND, "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      ...nextServerEnv(".next-test/pdp-promotion-offers"),
      PANCAKE_SHOP_ID: String(SHOP_ID),
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
      LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
      LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP_ID),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => (serverOutput = `${serverOutput}${chunk}`.slice(-20_000)));
  server.stderr?.on("data", (chunk: Buffer) => (serverOutput = `${serverOutput}${chunk}`.slice(-20_000)));
  await waitForServer();
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await cleanup();
  await prisma.$disconnect();
});

test("gift and tier campaigns are named under the price by name only; a gift that cannot be granted is not", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/shop/${productSlug}`, { waitUntil: "networkidle" });
  const panel = page.getByRole("region", { name: "Mua sản phẩm" });
  const offers = panel.getByRole("list", { name: "Ưu đãi áp dụng" });
  await expect(offers).toBeVisible();

  const items = offers.getByRole("listitem");
  await expect(items).toHaveCount(2);
  // Owner request 2026-10-18: the campaign's name and nothing after it.
  await expect(items.nth(0)).toHaveText(tierName);
  await expect(items.nth(1)).toHaveText(giftName);
  // The campaign whose only gift is out of READY stock is left out.
  await expect(panel.getByText(soldOutGiftName)).toHaveCount(0);
});
