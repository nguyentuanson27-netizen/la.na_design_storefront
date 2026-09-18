import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-08-12T09:30:00.000Z");
const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};

async function createBareCart() {
  return prisma.cart.create({
    data: { expiresAt: new Date(now.getTime() + 60_000) },
  });
}

async function cleanup(cartId: string) {
  await prisma.orderMirror.deleteMany({ where: { sourceCartId: cartId } });
  await prisma.cart.deleteMany({ where: { id: cartId } });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("snapshot service fails closed when checkout geo authority is omitted", async () => {
  const cart = await createBareCart();
  const service = createGuestCheckoutSnapshotService(prisma, { verifyRenderedQuote: acceptAnyRenderedQuote });

  assert.deepEqual(
    await service.create({
      cartId: cart.id,
      shopId,
      publicCode: "checkout-geo-authority-default",
      checkoutInput,
      now,
    }),
    { ok: false, reason: "INVALID_INPUT" },
  );
  assert.equal(await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }), 0);

  await cleanup(cart.id);
});

test("unvalidated checkout input cannot create a fresh snapshot", async () => {
  const cart = await createBareCart();
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: false,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  assert.deepEqual(
    await service.create({
      cartId: cart.id,
      shopId,
      publicCode: "checkout-geo-authority-fresh",
      checkoutInput,
      now,
    }),
    { ok: false, reason: "INVALID_INPUT" },
  );
  assert.equal(await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }), 0);

  await cleanup(cart.id);
});

test("unvalidated checkout input cannot supersede a retryable draft", async () => {
  const cart = await createBareCart();
  const existing = await prisma.orderMirror.create({
    data: {
      publicCode: "checkout-geo-authority-retry",
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      state: "DRAFT",
      syncErrorCode: "VALIDATION_UNAVAILABLE",
    },
  });
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: false,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  assert.deepEqual(
    await service.create({
      cartId: cart.id,
      shopId,
      publicCode: "checkout-geo-authority-replacement",
      checkoutInput,
      now,
    }),
    { ok: false, reason: "INVALID_INPUT" },
  );

  const unchanged = await prisma.orderMirror.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(unchanged.state, "DRAFT");
  assert.equal(unchanged.syncErrorCode, "VALIDATION_UNAVAILABLE");
  assert.equal(
    await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }),
    1,
  );

  await cleanup(cart.id);
});

test("unvalidated current form input may reuse a confirmed snapshot without a fresh geo read", async () => {
  const cart = await createBareCart();
  const confirmed = await prisma.orderMirror.create({
    data: {
      publicCode: "checkout-geo-authority-confirmed",
      sourceCartId: cart.id,
      pancakeShopId: shopId,
      pancakeOrderId: "geo-authority-pancake-order",
      state: "CONFIRMED",
      checkoutSnapshottedAt: now,
      guestName: checkoutInput.name,
      guestPhone: checkoutInput.phone,
      provinceRef: checkoutInput.provinceRef,
      districtRef: checkoutInput.districtRef,
      communeRef: checkoutInput.communeRef,
      addressDetail: checkoutInput.detail,
      note: checkoutInput.note,
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
    },
  });
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: false,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  assert.deepEqual(
    await service.create({
      cartId: cart.id,
      shopId,
      publicCode: "checkout-geo-authority-unused",
      checkoutInput,
      now,
    }),
    {
      ok: true,
      order: {
        // I6b — the snapshot now reports the order id and its persisted lines, because ADR 0014 §3
        // makes the order the reservation's idempotency key and the lines are what gets held. This
        // fixture's confirmed order has no lines, so the reused snapshot reserves nothing.
        id: confirmed.id,
        publicCode: "checkout-geo-authority-confirmed",
        state: "CONFIRMED",
        merchandiseSubtotalVnd: BigInt(500_000),
        shippingFeeVnd: BigInt(30_000),
        totalVnd: BigInt(530_000),
        lines: [],
      },
    },
  );

  await cleanup(cart.id);
});
