import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  readCanonicalPurchaseSnapshot,
  readCanonicalPurchaseSnapshotSafely,
  type CanonicalPurchaseClient,
} from "../../src/commerce/canonical-purchase-snapshot.ts";
import { readMetaPurchaseSnapshot } from "../../src/commerce/meta-purchase-snapshot.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

type TestVariantItem = {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
  item_variant?: string;
  item_group_id?: string;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const shopId = 930_093;
const orderCode = "CANONICAL-TEST-0001";
const syncedAt = new Date("2026-08-29T05:00:00.000Z");

async function cleanup() {
  await prisma.orderLineSnapshot.deleteMany({
    where: { order: { publicCode: orderCode } },
  });
  await prisma.orderMirror.deleteMany({ where: { publicCode: orderCode } });
  await prisma.variantMirror.deleteMany({
    where: { product: { pancakeShopId: shopId } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function seedConfirmedOrderFixture(options?: {
  state?: "CONFIRMED" | "DRAFT" | "VALIDATING" | "POS_SUBMITTING" | "SYNC_UNKNOWN" | "REJECTED";
  pancakeVariationId?: string;
  quantity?: number;
  unitPriceVnd?: number;
  baseUnitPriceVnd?: number;
  catalogRetailPrice?: number;
  shippingFeeVnd?: number;
  merchandiseSubtotalVnd?: number;
  totalVnd?: number;
}) {
  const state = options?.state ?? "CONFIRMED";
  const pancakeVariationId = options?.pancakeVariationId ?? "canonical-variation-001";
  const quantity = options?.quantity ?? 2;
  const unitPriceVnd = options?.unitPriceVnd ?? 399_000;
  const baseUnitPriceVnd = options?.baseUnitPriceVnd ?? 449_000;
  const catalogRetailPrice = options?.catalogRetailPrice ?? 449_000;
  const shippingFeeVnd = options?.shippingFeeVnd ?? 30_000;
  const merchandiseSubtotalVnd = options?.merchandiseSubtotalVnd ?? unitPriceVnd * quantity;
  const totalVnd = options?.totalVnd ?? merchandiseSubtotalVnd + shippingFeeVnd;

  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: "canonical-product-001",
      slug: "ao-so-mi-linen-premium",
      name: "Áo Sơ Mi Linen Premium",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });

  const variant = await prisma.variantMirror.create({
    data: {
      pancakeVariationId,
      productId: product.id,
      color: "Xanh Navy",
      size: "L",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: catalogRetailPrice,
      pancakeRetailPriceAfterDiscount: catalogRetailPrice,
      syncedAt,
    },
  });

  const order = await prisma.orderMirror.create({
    data: {
      publicCode: orderCode,
      state,
      checkoutSnapshottedAt: syncedAt,
      guestName: "Trần Văn Bình",
      guestPhone: "0901234567",
      provinceRef: "1",
      districtRef: "2",
      communeRef: "3",
      addressDetail: "123 Phố Huế",
      note: "",
      merchandiseSubtotalVnd: BigInt(merchandiseSubtotalVnd),
      shippingFeeVnd: BigInt(shippingFeeVnd),
      totalVnd: BigInt(totalVnd),
    },
  });

  await prisma.orderLineSnapshot.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      metaContentId: product.slug,
      productName: "Áo Sơ Mi Linen Premium",
      color: "Xanh Navy",
      size: "L",
      quantity,
      unitPriceVnd: BigInt(unitPriceVnd),
      lineTotalVnd: BigInt(unitPriceVnd * quantity),
      baseUnitPriceVnd: BigInt(baseUnitPriceVnd),
    },
  });

  return { product, variant, order };
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("Regression A: only CONFIRMED produces a canonical Purchase snapshot", async () => {
  const nonConfirmedStates = [
    "DRAFT",
    "VALIDATING",
    "POS_SUBMITTING",
    "SYNC_UNKNOWN",
    "REJECTED",
  ] as const;

  for (const state of nonConfirmedStates) {
    await cleanup();
    await seedConfirmedOrderFixture({ state });
    const snapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
    assert.equal(
      snapshot,
      null,
      `State ${state} must not emit a canonical Purchase snapshot`,
    );
  }

  // Non-existent order
  assert.equal(await readCanonicalPurchaseSnapshot(prisma, "NON-EXISTENT-ORDER-CODE"), null);

  // Confirmed produces valid snapshot
  await cleanup();
  await seedConfirmedOrderFixture({ state: "CONFIRMED" });
  const snapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(snapshot, null);
  assert.equal(snapshot?.publicCode, orderCode);
  assert.equal(snapshot?.event.event, "purchase");
});

test("Regression B: immutable finalized money derives strictly from snapshot without promotion recalculation", async () => {
  // Stored base: 449_000, stored final: 399_000.
  // We also set catalog retail price to 550_000 to verify current catalog price is ignored.
  const { variant } = await seedConfirmedOrderFixture({
    state: "CONFIRMED",
    baseUnitPriceVnd: 449_000,
    unitPriceVnd: 399_000,
    catalogRetailPrice: 550_000,
    quantity: 2,
    shippingFeeVnd: 30_000,
  });

  // Mutate catalog retail price even further
  await prisma.variantMirror.update({
    where: { id: variant.id },
    data: { pancakeRetailPrice: 600_000, pancakeRetailPriceAfterDiscount: 600_000 },
  });

  const snapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(snapshot, null);

  const ecommerce = snapshot!.event.ecommerce;
  assert.equal(ecommerce.currency, "VND");
  // Item unit price is strictly 399_000 (OrderLineSnapshot.unitPriceVnd)
  assert.equal(ecommerce.items[0].price, 399_000);
  // Value is strictly merchandise sum: 399_000 * 2 = 798_000
  assert.equal(ecommerce.value, 798_000);
  assert.equal(ecommerce.shipping, 30_000);
  assert.equal(ecommerce.la_total_vnd, 828_000);
});

test("Regression C: item identity uses external variation ID and snapshot quantity, never internal CUID", async () => {
  const { variant } = await seedConfirmedOrderFixture({
    pancakeVariationId: "external-pancake-var-888",
    quantity: 3,
  });

  const snapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(snapshot, null);

  const item = snapshot!.event.ecommerce.items[0] as TestVariantItem;
  assert.equal(item.item_id, "external-pancake-var-888");
  assert.notEqual(item.item_id, variant.id);
  assert.equal(item.quantity, 3);
  assert.equal(item.item_name, "Áo Sơ Mi Linen Premium");
  assert.equal(item.item_variant, "Xanh Navy / L");
});

test("Regression D: catalog deletion or enrichment loss does not suppress confirmed Purchase", async () => {
  await seedConfirmedOrderFixture();

  // Verify that initially with variants present, item_group_id is optionally enriched
  const initialSnapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(initialSnapshot, null);
  const initialItem = initialSnapshot!.event.ecommerce.items[0] as TestVariantItem;
  assert.equal(initialItem.item_group_id, "canonical-product-001");

  // Now delete the catalog mirrors entirely
  await prisma.variantMirror.deleteMany({
    where: { product: { pancakeShopId: shopId } },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });

  // Read snapshot again: must STILL succeed because immutable order facts are sufficient
  const degradedSnapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(degradedSnapshot, null);

  const degradedItem = degradedSnapshot!.event.ecommerce.items[0] as TestVariantItem;
  assert.equal(degradedItem.item_id, "canonical-variation-001");
  assert.equal(degradedItem.item_name, "Áo Sơ Mi Linen Premium");
  assert.equal(degradedItem.price, 399_000);
  assert.equal(degradedItem.quantity, 2);
  // item_group_id was lost with deleted product, but required item facts are preserved
  assert.equal("item_group_id" in degradedItem, false);
  assert.equal(degradedSnapshot!.event.ecommerce.value, 798_000);
});

test("Regression E: repeat reads produce identical transaction and event identity without random tokens", async () => {
  await seedConfirmedOrderFixture();

  const read1 = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  const read2 = await readCanonicalPurchaseSnapshot(prisma, orderCode);

  assert.notEqual(read1, null);
  assert.notEqual(read2, null);
  assert.deepEqual(read1, read2);
  assert.equal(read1!.event.ecommerce.transaction_id, orderCode);
  assert.equal(read1!.event.ecommerce.event_id, orderCode);
  assert.equal(read2!.event.ecommerce.transaction_id, orderCode);
  assert.equal(read2!.event.ecommerce.event_id, orderCode);
});

test("Regression F: tracking failure isolation ensures errors never leak or mutate order", async () => {
  await seedConfirmedOrderFixture();

  // Simulating a safe wrapper over an error (e.g. invalid publicCode or throwing client)
  const throwingClient = {
    orderMirror: {
      findUnique: async () => {
        throw new Error("Simulated database failure");
      },
    },
    variantMirror: prisma.variantMirror,
  };

  const safeResult = await readCanonicalPurchaseSnapshotSafely(
    throwingClient as unknown as CanonicalPurchaseClient,
    orderCode,
  );
  assert.equal(safeResult, null);

  // The actual database order remains untouched and confirmed
  const orderInDb = await prisma.orderMirror.findUnique({
    where: { publicCode: orderCode },
  });
  assert.equal(orderInDb?.state, "CONFIRMED");
});

test("Regression G: Meta Pixel + CAPI dedup compatibility", async () => {
  await seedConfirmedOrderFixture({
    unitPriceVnd: 399_000,
    quantity: 2,
    shippingFeeVnd: 30_000,
  });

  const metaSnapshot = await readMetaPurchaseSnapshot(prisma, orderCode);
  const canonicalSnapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);

  assert.notEqual(metaSnapshot, null);
  assert.notEqual(canonicalSnapshot, null);

  // Both share publicCode as the event identity
  assert.equal(canonicalSnapshot!.event.ecommerce.transaction_id, orderCode);
  assert.equal(canonicalSnapshot!.event.ecommerce.event_id, orderCode);

  // Meta uses order total (828_000)
  assert.equal(metaSnapshot!.valueVnd, 828_000);
  // Canonical reports merchandise value (798_000), shipping (30_000), total (828_000)
  assert.equal(canonicalSnapshot!.event.ecommerce.value, 798_000);
  assert.equal(canonicalSnapshot!.event.ecommerce.shipping, 30_000);
  assert.equal(canonicalSnapshot!.event.ecommerce.la_total_vnd, 828_000);

  // Both derive items from immutable line snapshot
  const canonicalItem = canonicalSnapshot!.event.ecommerce.items[0] as { price: number; quantity: number };
  assert.equal(canonicalItem.price, 399_000);
  assert.equal(metaSnapshot!.contents[0].itemPrice, 399_000);
  assert.equal(canonicalItem.quantity, 2);
  assert.equal(metaSnapshot!.contents[0].quantity, 2);
});

test("Regression H: database confirmed order with malformed catalog pancakeProductId still emits valid Purchase", async () => {
  await seedConfirmedOrderFixture();

  // Update the product in the DB to have whitespace pancakeProductId
  await prisma.productMirror.updateMany({
    where: { pancakeShopId: shopId },
    data: { pancakeProductId: "   " },
  });

  const snapshot = await readCanonicalPurchaseSnapshot(prisma, orderCode);
  assert.notEqual(snapshot, null);
  const item = snapshot!.event.ecommerce.items[0] as TestVariantItem;
  assert.equal(item.item_id, "canonical-variation-001");
  assert.equal("item_group_id" in item, false);
});
