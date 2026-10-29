import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { benefitQuoteDigest } from "../../src/commerce/checkout-quote-proof.ts";
import {
  replaceOrderQuoteSnapshot,
  clearOrderQuoteSnapshot,
  type OrderQuoteSnapshotInput,
} from "../../src/commerce/order-quote-snapshot.ts";

test("quote reference reuses priced server POS when a later catalog read has changed", async () => {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  const key = "list-price-snapshot-consistency";
  const cleanup = async () => {
    await client.$transaction(async (tx) => {
      const orders = await tx.orderMirror.findMany({
        where: { publicCode: key },
        select: { id: true },
      });
      for (const order of orders) await clearOrderQuoteSnapshot(tx, order.id);
      await tx.orderMirror.deleteMany({ where: { publicCode: key } });
    });
    await client.productMirror.deleteMany({ where: { pancakeProductId: key } });
  };
  try {
    await cleanup();
    const product = await client.productMirror.create({
      data: {
        pancakeShopId: 925231,
        pancakeProductId: key,
        slug: key,
        name: key,
        syncedAt: new Date(),
        variants: {
          create: {
            pancakeVariationId: key,
            pancakeRetailPrice: 100001,
            size: "M",
            syncedAt: new Date(),
          },
        },
      },
      include: { variants: true },
    });
    const variant = product.variants[0]!;
    const order = await client.orderMirror.create({
      data: { publicCode: key },
    });
    const facts: OrderQuoteSnapshotInput = {
      quoteFormat: "laq3",
      quoteDigest: "",
      paidSubtotalVnd: 100001,
      shippingFeeVnd: 0,
      totalVnd: 100001,
      lines: [
        {
          lineId: "paid",
          role: "PAID",
          variantId: variant.id,
          pancakeVariationId: key,
          quantity: 1,
          unitPriceVnd: 100001,
          lineTotalVnd: 100001,
          baseUnitPriceVnd: null,
          fulfillmentState: "READY",
          campaign: null,
          discountSteps: [],
        },
      ],
      entitlements: [],
      acknowledgedAt: null,
    };
    const quote = { ...facts, quoteDigest: benefitQuoteDigest(facts) };
    process.env.LIST_PRICE_DISPLAY = "true";
    process.env.LIST_PRICE_CAMPAIGN_BASIS = "true";
    await client.$transaction(async (tx) => {
      // Models a catalog commit visible after checkout's original server pricing read.
      await tx.variantMirror.update({
        where: { id: variant.id },
        data: { pancakeRetailPrice: 10000 },
      });
      assert.deepEqual(
        await replaceOrderQuoteSnapshot(
          tx,
          order.id,
          quote,
          new Map([[variant.id, { basePriceVnd: 100001, productName: product.name, color: variant.color, size: variant.size }]]),
        ),
        { ok: true },
      );
    });
    const line = await client.orderQuoteLine.findFirstOrThrow({
      where: { snapshot: { orderId: order.id } },
    });
    assert.equal(line.listUnitPriceVnd, BigInt(149000));
    assert.equal(line.unitPriceVnd, BigInt(100001));
    assert.equal(line.baseUnitPriceVnd, null);
    assert.equal(
      (
        await client.orderQuoteSnapshot.findUniqueOrThrow({
          where: { orderId: order.id },
        })
      ).quoteDigest,
      quote.quoteDigest,
    );
  } finally {
    delete process.env.LIST_PRICE_DISPLAY;
    delete process.env.LIST_PRICE_CAMPAIGN_BASIS;
    await cleanup();
    await client.$disconnect();
  }
});
