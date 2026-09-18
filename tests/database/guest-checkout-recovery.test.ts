import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { recoverStrandedGuestCheckouts } from "../../src/commerce/guest-checkout-recovery.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const key = "guest-checkout-recovery";
const shopId = 920_007;
const now = new Date("2026-08-12T06:45:00.000Z");
const staleAt = new Date(now.getTime() - 10 * 60_000);
const freshAt = new Date(now.getTime() - 10_000);

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: key } } });
}

async function createOrder(
  suffix: string,
  state: "VALIDATING" | "POS_SUBMITTING",
  updatedAt: Date,
  sourceCartId: string,
) {
  return prisma.orderMirror.create({
    data: {
      publicCode: `${key}-${suffix}`,
      sourceCartId,
      pancakeShopId: shopId,
      state,
      checkoutSnapshottedAt: staleAt,
      guestName: "Nguyễn Văn A",
      guestPhone: "0901234567",
      provinceRef: "province-01",
      districtRef: "district-001",
      communeRef: "commune-0001",
      addressDetail: "12 Đường A",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      updatedAt,
      lines: {
        create: {
          variantId: `${key}-${suffix}-variant`,
          pancakeVariationId: `${key}-${suffix}-variation`,
          productName: "Recovery Product",
          color: "Black",
          size: "M",
          quantity: 1,
          unitPriceVnd: BigInt(500_000),
          lineTotalVnd: BigInt(500_000),
        },
      },
    },
  });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("stale VALIDATING is rejected, stale POS_SUBMITTING becomes SYNC_UNKNOWN, and neither path authorizes a repost", async () => {
  await cleanup();
  const validatingCartId = "44444444-4444-4444-8444-444444444444";
  const submittingCartId = "55555555-5555-4555-8555-555555555555";
  const freshCartId = "66666666-6666-4666-8666-666666666666";

  const validating = await createOrder("validating", "VALIDATING", staleAt, validatingCartId);
  const submitting = await createOrder("submitting", "POS_SUBMITTING", staleAt, submittingCartId);
  const fresh = await createOrder("fresh", "VALIDATING", freshAt, freshCartId);

  assert.deepEqual(
    await recoverStrandedGuestCheckouts(prisma, { now, staleAfterMs: 60_000 }),
    // `reservedExpired: 0` is load-bearing here, not noise: with no approved §8 window the sweep
    // must free nothing at all, and this pins that it stays off unless a window is supplied.
    { validatingRejected: 1, submittingUnknown: 1, reservedExpired: 0 },
  );

  const recoveredValidating = await prisma.orderMirror.findUniqueOrThrow({ where: { id: validating.id } });
  assert.equal(recoveredValidating.state, "REJECTED");
  assert.equal(recoveredValidating.syncErrorCode, "VALIDATION_INTERRUPTED");

  const recoveredSubmitting = await prisma.orderMirror.findUniqueOrThrow({ where: { id: submitting.id } });
  assert.equal(recoveredSubmitting.state, "SYNC_UNKNOWN");
  assert.equal(recoveredSubmitting.syncErrorCode, "CREATE_OUTCOME_UNKNOWN");

  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: fresh.id } })).state, "VALIDATING");

  const replacement = await prisma.orderMirror.create({
    data: {
      publicCode: `${key}-replacement`,
      sourceCartId: validatingCartId,
      pancakeShopId: shopId,
      state: "DRAFT",
    },
  });
  assert.equal(replacement.state, "DRAFT");

  let fetchCalls = 0;
  let createCalls = 0;
  const submission = createPancakeOrderSubmissionService(prisma, {
    async fetchCompleteCatalog() {
      fetchCalls += 1;
      return [];
    },
    async createOrder() {
      createCalls += 1;
      return { id: 1 };
    },
  });

  assert.deepEqual(await submission.submit({ publicCode: submitting.publicCode, shopId }), {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "CREATE_OUTCOME_UNKNOWN",
  });
  assert.equal(fetchCalls, 0);
  assert.equal(createCalls, 0);
});
