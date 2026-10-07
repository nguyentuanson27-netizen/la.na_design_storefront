import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

test.after(async () => {
  await prisma.$disconnect();
});

test("deployed schema stores the immutable guest checkout snapshot fields", async () => {
  const orderColumns = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'OrderMirror'
      AND column_name IN (
        'checkoutSnapshottedAt',
        'guestName',
        'guestPhone',
        'provinceRef',
        'districtRef',
        'communeRef',
        'addressDetail',
        'note',
        'pancakeShopId',
        'purchaseOccurredAt',
        'metaPurchaseContext',
        'metaPurchasePayload',
        'metaPurchaseSentAt',
        'merchandiseSubtotalVnd',
        'shippingFeeVnd',
        'totalVnd'
      )
    ORDER BY column_name
  `;

  assert.deepEqual(orderColumns, [
    { column_name: "addressDetail", data_type: "text" },
    { column_name: "checkoutSnapshottedAt", data_type: "timestamp without time zone" },
    { column_name: "communeRef", data_type: "text" },
    { column_name: "districtRef", data_type: "text" },
    { column_name: "guestName", data_type: "text" },
    { column_name: "guestPhone", data_type: "text" },
    { column_name: "merchandiseSubtotalVnd", data_type: "bigint" },
    { column_name: "metaPurchaseContext", data_type: "text" },
    { column_name: "metaPurchasePayload", data_type: "text" },
    { column_name: "metaPurchaseSentAt", data_type: "timestamp without time zone" },
    { column_name: "note", data_type: "text" },
    { column_name: "pancakeShopId", data_type: "integer" },
    { column_name: "provinceRef", data_type: "text" },
    { column_name: "purchaseOccurredAt", data_type: "timestamp without time zone" },
    { column_name: "shippingFeeVnd", data_type: "bigint" },
    { column_name: "totalVnd", data_type: "bigint" },
  ]);

  const lineColumns = await prisma.$queryRaw<Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'OrderLineSnapshot'
    ORDER BY ordinal_position
  `;

  assert.deepEqual(lineColumns, [
    { column_name: "id", data_type: "text", is_nullable: "NO" },
    { column_name: "orderId", data_type: "text", is_nullable: "NO" },
    { column_name: "variantId", data_type: "text", is_nullable: "NO" },
    { column_name: "pancakeVariationId", data_type: "text", is_nullable: "NO" },
    { column_name: "productName", data_type: "text", is_nullable: "NO" },
    { column_name: "color", data_type: "text", is_nullable: "YES" },
    { column_name: "size", data_type: "text", is_nullable: "NO" },
    { column_name: "quantity", data_type: "integer", is_nullable: "NO" },
    { column_name: "unitPriceVnd", data_type: "bigint", is_nullable: "NO" },
    { column_name: "lineTotalVnd", data_type: "bigint", is_nullable: "NO" },
    { column_name: "createdAt", data_type: "timestamp without time zone", is_nullable: "NO" },
    // P1 promotion audit. Appended and nullable, so the immutable snapshot contract above is
    // unchanged and rows written before promotions existed stay valid.
    { column_name: "baseUnitPriceVnd", data_type: "bigint", is_nullable: "YES" },
    { column_name: "promotionCampaignId", data_type: "text", is_nullable: "YES" },
    { column_name: "promotionName", data_type: "text", is_nullable: "YES" },
    { column_name: "promotionKind", data_type: "USER-DEFINED", is_nullable: "YES" },
    { column_name: "promotionDiscountType", data_type: "USER-DEFINED", is_nullable: "YES" },
    { column_name: "promotionPercentageValue", data_type: "integer", is_nullable: "YES" },
    { column_name: "promotionFixedPriceVnd", data_type: "bigint", is_nullable: "YES" },
    { column_name: "metaContentId", data_type: "text", is_nullable: "YES" },
  ]);
});
