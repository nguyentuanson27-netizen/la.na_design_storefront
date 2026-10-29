import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { auditListPrices } from "../../src/commerce/list-price-audit.ts";
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const shopId = 925226,
  now = new Date("2026-10-30T00:00:00Z");
test.after(async () => {
  await db.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await db.catalogSyncState.deleteMany({ where: { pancakeShopId: shopId } });
  await db.$disconnect();
  delete process.env.LIST_PRICE_DISPLAY;
});
test("post-sync and daily audits report outliers without capping or modifying catalog; failures retry durably", async () => {
  process.env.LIST_PRICE_DISPLAY = "true";
  await db.catalogSyncState.upsert({
    where: { pancakeShopId: shopId },
    create: { pancakeShopId: shopId, syncedAt: now },
    update: {
      syncedAt: now,
      listPriceAuditAt: null,
      listPriceAuditError: false,
      listPriceAuditRetryAt: null,
    },
  });
  const product = await db.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "audit-list-price",
      slug: "audit-list-price",
      name: "Audit",
      syncedAt: now,
      variants: {
        create: {
          pancakeVariationId: "audit-price-10000",
          pancakeRetailPrice: 10000,
          size: "M",
          syncedAt: now,
        },
      },
    },
  });
  const events: unknown[] = [];
  const first = await auditListPrices({
    client: db,
    shopId,
    now,
    emit: (s) => {
      events.push(s);
    },
  });
  assert.equal(first?.outliers, 1);
  assert.equal(first?.maxRatio, 4.9);
  assert.deepEqual(first?.affectedVariantIds, ["audit-price-10000"]);
  assert.equal(
    (
      await db.variantMirror.findFirstOrThrow({
        where: { productId: product.id },
      })
    ).pancakeRetailPrice,
    10000,
  );
  assert.equal(
    await auditListPrices({
      client: db,
      shopId,
      now: new Date(now.getTime() + 1000),
      emit: (s) => {
        events.push(s);
      },
    }),
    null,
  );
  const next = new Date(now.getTime() + 2000);
  await db.catalogSyncState.update({
    where: { pancakeShopId: shopId },
    data: { syncedAt: next },
  });
  await assert.rejects(
    auditListPrices({
      client: db,
      shopId,
      now: next,
      emit: async () => {
        throw new Error("delivery unavailable");
      },
    }),
  );
  const failed = await db.catalogSyncState.findUniqueOrThrow({
    where: { pancakeShopId: shopId },
  });
  assert.equal(failed.listPriceAuditError, true);
  assert.ok(failed.listPriceAuditRetryAt);
  assert.equal(
    await auditListPrices({
      client: db,
      shopId,
      now: new Date(next.getTime() + 1000),
      emit: () => undefined,
    }),
    null,
  );
  assert.ok(
    await auditListPrices({
      client: db,
      shopId,
      now: new Date(next.getTime() + 61000),
      emit: () => undefined,
    }),
  );
  assert.equal(
    (
      await db.catalogSyncState.findUniqueOrThrow({
        where: { pancakeShopId: shopId },
      })
    ).listPriceAuditError,
    false,
  );
  assert.ok(
    await auditListPrices({
      client: db,
      shopId,
      now: new Date(next.getTime() + 86461001),
      emit: () => undefined,
    }),
  );
});
