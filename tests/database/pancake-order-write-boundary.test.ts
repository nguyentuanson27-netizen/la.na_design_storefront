import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

/**
 * I6b — where the submission service's write boundary actually is.
 *
 * Every other test of this boundary runs against a double of `orderSubmission`, which can only
 * prove what the *caller* does with the hook. This file is the other half: it runs the real service
 * against a real database and pins that the hook is invoked at the write and nowhere else.
 *
 * That matters because the failure it guards is silent. If this service stopped calling
 * `beforeExternalWrite`, every unit test would still pass — the double would keep calling it — while
 * production wrote to Pancake with the capacity hold still RESERVED. And if it called the hook on
 * entry instead, a pre-write bailout would leave a non-expiring SUBMITTING hold on an order that was
 * never sent, which is the permanent false hold ADR 0014 §8 cannot undo on a timer.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-17T03:00:00.000Z");
const prefix = "i6b-boundary";

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
    async fetchCompleteCatalog() {
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

test("I6b the write-boundary hook runs after every read and immediately before the create", async () => {
  const { product, variant, publicCode } = await seedDraft("ordered", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);

  const result = await createPancakeOrderSubmissionService(
    prisma,
    recordingGateway(events, live),
    { now: () => now },
  ).submit({
    publicCode,
    shopId,
    beforeExternalWrite: async () => {
      events.push("hook");
      return true;
    },
  });

  assert.equal(result.ok, true, "a valid order must still submit");
  // The ordering IS the contract. `hook` after `catalog` is what keeps a capacity hold RESERVED —
  // and therefore expirable — through the whole read-and-reprice phase; `hook` before `create` is
  // what makes it SUBMITTING before anything can exist in Pancake.
  assert.deepEqual(events, ["catalog", "hook", "create"]);
});

test("I6b a refused hook sends nothing and leaves the order submittable again", async () => {
  const { product, variant, publicCode } = await seedDraft("refused", 500_000);
  const events: string[] = [];
  const live = liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000);

  const result = await createPancakeOrderSubmissionService(
    prisma,
    recordingGateway(events, live),
    { now: () => now },
  ).submit({
    publicCode,
    shopId,
    beforeExternalWrite: async () => {
      events.push("hook");
      return false;
    },
  });

  assert.deepEqual(result, {
    ok: false,
    state: "DRAFT",
    reason: "VALIDATION_UNAVAILABLE",
  });
  assert.deepEqual(events, ["catalog", "hook"], "a refused precondition must not reach Pancake");

  // Back to DRAFT rather than stranded mid-claim: the buyer's retry re-reserves and gets the
  // truthful capacity answer from the ledger, which is the component that actually knows.
  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode } });
  assert.equal(order.state, "DRAFT");
  assert.equal(order.pancakeOrderId, null);
});

test("I6b a pre-write ending never reaches the hook at all", async () => {
  // The defect this file exists for. Both of these end the submission with nothing sent, and both
  // must leave the caller's hold exactly as it was — for I6b that means still RESERVED, and
  // therefore still able to expire when the buyer abandons checkout.
  for (const [label, live] of [
    ["unavailable", null],
    ["repriced", "drift"],
  ] as const) {
    const { product, variant, publicCode } = await seedDraft(label, 500_000);
    const events: string[] = [];
    const variation =
      live === null
        ? null
        : liveVariation(variant.pancakeVariationId, product.pancakeProductId, 520_000);

    const result = await createPancakeOrderSubmissionService(
      prisma,
      recordingGateway(events, variation),
      { now: () => now },
    ).submit({
      publicCode,
      shopId,
      beforeExternalWrite: async () => {
        events.push("hook");
        return true;
      },
    });

    assert.equal(result.ok, false, `${label} must not confirm`);
    assert.equal(result.state, "DRAFT", `${label} must return the order to DRAFT`);
    assert.ok(
      !events.includes("hook"),
      `${label} sent nothing, so it must not have claimed the write`,
    );
    assert.ok(!events.includes("create"), `${label} must not reach Pancake`);
    await cleanup();
  }
});
