import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { createVoucherOrderAcceptance } from "../../src/commerce/voucher-order-acceptance.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import { resolveTwoLevelAddressNames } from "../support/pancake-geo-names.ts";

/**
 * V13 -- where the website's acceptance runs inside the real submission service.
 *
 * `acceptAtWriteBoundary` must run INSIDE the boundary transaction, after the order is POS_SUBMITTING and before
 * that transaction commits, and before anything is sent. A refusal (or a throw) rolls back everything the acceptor
 * wrote and sends nothing. These tests drive the real service against a real database with a recording gateway; the
 * acceptor itself is tested against real vouchers in voucher-order-acceptance.test.ts.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_013;
const now = new Date("2026-09-17T03:00:00.000Z");
const prefix = "v13-boundary";

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: prefix } } });
  await prisma.cart.deleteMany({
    where: { items: { some: { variant: { pancakeVariationId: { startsWith: prefix } } } } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: prefix } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function liveVariation(id: string, productId: string, retailPrice: number): PancakeCatalogVariation {
  return {
    id,
    productId,
    displayId: `${id}-display`,
    barcode: `${id}-barcode`,
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice,
    retailPriceAfterDiscount: retailPrice,
    product: { id: productId, name: productId },
    warehouseStocks: [{ warehouseId: `${id}-warehouse`, remainQuantity: 9 }],
    sellableStock: 9,
  };
}

async function seedDraft(label: string, mirroredBaseVnd: number) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `I6B ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${label}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: mirroredBaseVnd,
          pancakeRetailPriceAfterDiscount: mirroredBaseVnd,
          syncedAt: now,
          warehouseStocks: {
            create: { pancakeWarehouseId: `${prefix}-wh-${label}`, quantity: 9, syncedAt: now },
          },
        },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0]!;
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId: variant.id, quantity: 1 } },
    },
  });
  const publicCode = `${prefix}-${label}-order`;
  const snapshot = await createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  }).create({ cartId: cart.id, shopId, publicCode, checkoutInput, now });
  assert.equal(snapshot.ok, true, "the DRAFT must be snapshotted before submission");
  return { product, variant, publicCode };
}

/**
 * A gateway that records the order of everything the service does externally, so the hook's
 * position can be asserted rather than assumed.
 */
function recordingGateway(
  events: string[],
  variation: PancakeCatalogVariation | null,
) {
  return {
    resolveTwoLevelAddressNames,
    async fetchVariations() {
      events.push("catalog");
      if (!variation) throw new Error("catalog unavailable");
      return [variation];
    },
    async createOrder() {
      events.push("create");
      return { id: 900_101 };
    },
  };
}

test("V13 the acceptor runs in the boundary transaction: order already POS_SUBMITTING, nothing sent yet, then the create", async () => {
  const { product, variant, publicCode } = await seedDraft("accept", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);

  const result = await createPancakeOrderSubmissionService(prisma, recordingGateway(events, live), {
    now: () => now,
    async acceptAtWriteBoundary(tx, order) {
      const row = await tx.orderMirror.findUniqueOrThrow({ where: { id: order.id }, select: { state: true } });
      events.push(`accept:${row.state}`);
      return true;
    },
  }).submit({ publicCode, shopId, beforeExternalWrite: async () => { events.push("hook"); return true; } });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["catalog", "hook", "accept:POS_SUBMITTING", "create"]);
});

test("V13 a refused acceptance sends nothing, rolls back what the acceptor wrote and closes the order for a new attempt", async () => {
  const { product, variant, publicCode } = await seedDraft("refuse", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);
  const outcomes: string[] = [];

  const result = await createPancakeOrderSubmissionService(prisma, recordingGateway(events, live), {
    now: () => now,
    onEvent: (event) => outcomes.push(event.name),
    async acceptAtWriteBoundary(tx, order) {
      // A write that must vanish with the refusal (the real acceptor writes the marker, redemptions and counters).
      await tx.orderMirror.update({ where: { id: order.id }, data: { note: "written-by-acceptor" } });
      return false;
    },
  }).submit({ publicCode, shopId, beforeExternalWrite: async () => { events.push("hook"); return true; } });

  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "VOUCHER_REQUOTE_REQUIRED" });
  assert.deepEqual(events, ["catalog", "hook"], "nothing reaches Pancake");
  assert.ok(outcomes.includes("pancake_order.voucher_requote_required"));
  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode } });
  assert.equal(order.state, "REJECTED");
  assert.equal(order.syncErrorCode, "VOUCHER_REQUOTE_REQUIRED");
  assert.equal(order.pancakeOrderId, null);
  assert.equal(order.purchaseOccurredAt, null, "the POS_SUBMITTING transition rolled back with the acceptor's writes");
  assert.notEqual(order.note, "written-by-acceptor");

  // The stored reason round-trips for a retry that only reads the order back.
  const again = await createPancakeOrderSubmissionService(prisma, recordingGateway([], live), { now: () => now }).submit({ publicCode, shopId });
  assert.deepEqual(again, { ok: false, state: "REJECTED", reason: "VOUCHER_REQUOTE_REQUIRED" });
});

test("V13 an acceptor that throws sends nothing and leaves no half-state (same as any boundary failure)", async () => {
  const { product, variant, publicCode } = await seedDraft("throws", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);

  const result = await createPancakeOrderSubmissionService(prisma, recordingGateway(events, live), {
    now: () => now,
    async acceptAtWriteBoundary(tx, order) {
      await tx.orderMirror.update({ where: { id: order.id }, data: { note: "written-by-acceptor" } });
      throw new Error("database went away");
    },
  }).submit({ publicCode, shopId });

  assert.equal(result.ok, false);
  assert.ok(!events.includes("create"), "nothing reaches Pancake");
  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode } });
  assert.notEqual(order.state, "POS_SUBMITTING");
  assert.notEqual(order.note, "written-by-acceptor");
});

test("V13 a plain order passes through the REAL acceptor untouched and confirms exactly as before", async () => {
  const { product, variant, publicCode } = await seedDraft("plain", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);
  const acceptance = createVoucherOrderAcceptance({ readAttemptSecret: () => { throw new Error("a plain order must not need the secret"); } });

  const result = await createPancakeOrderSubmissionService(prisma, recordingGateway(events, live), {
    now: () => now,
    async acceptAtWriteBoundary(tx, order) { return (await acceptance.acceptWithin(tx, { orderId: order.id })).ok; },
  }).submit({ publicCode, shopId });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["catalog", "create"]);
  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode }, include: { voucherAcceptance: true } });
  assert.equal(order.voucherAcceptance, null, "no marker for a no-voucher order: its path is unchanged");
});
