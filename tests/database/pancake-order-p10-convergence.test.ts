import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { calculateGuestShippingFeeVnd } from "../../src/commerce/guest-shipping-policy.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-04T06:00:00.000Z");
const prefix = "u23-p10";

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
  await prisma.promotionCampaign.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: prefix } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function liveVariation(
  id: string,
  productId: string,
  retailPrice: number,
  sellableStock = 9,
  retailPriceAfterDiscount = retailPrice,
): PancakeCatalogVariation {
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
    retailPriceAfterDiscount,
    product: { id: productId, name: productId },
    warehouseStocks: [{ warehouseId: `${id}-warehouse`, remainQuantity: sellableStock }],
    sellableStock,
  };
}

async function seedVariant(label: string, mirroredBaseVnd: number) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `P10 ${label}`,
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
  return { product, variant: product.variants[0]! };
}

async function seedCampaign(
  variantId: string,
  campaign: (
    | { discountType: "PERCENTAGE"; percentageValue: number }
    | { discountType: "FIXED_PRICE"; fixedPriceVnd: bigint }
  ) & {
    startsAt?: Date;
    endsAt?: Date;
  },
) {
  const startsAt = campaign.startsAt ?? new Date(now.getTime() - 60_000);
  return prisma.promotionCampaign.create({
    data: {
      kind: "PROMOTION",
      name: `${prefix}-${campaign.discountType}`,
      discountType: campaign.discountType,
      percentageValue: "percentageValue" in campaign ? campaign.percentageValue : null,
      fixedPriceVnd: "fixedPriceVnd" in campaign ? campaign.fixedPriceVnd : null,
      startsAt,
      endsAt: campaign.endsAt ?? new Date(now.getTime() + 600_000),
      isEnabled: true,
      enabledAt: startsAt,
      targets: { create: { variantId } },
    },
  });
}

async function createDraft(variantId: string, publicCode: string, quantity = 1) {
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId, quantity } },
    },
  });
  const result = await createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  }).create({ cartId: cart.id, shopId, publicCode, checkoutInput, now });
  assert.equal(result.ok, true, "the DRAFT must be snapshotted before submission");
  return cart;
}

function submissionService(
  gateway: Parameters<typeof createPancakeOrderSubmissionService>[1],
  submittedAt: Date = now,
  client: PrismaClient = prisma,
) {
  return createPancakeOrderSubmissionService(client, gateway, { now: () => submittedAt });
}

// ---------------------------------------------------------------------------
// Regression 1 — comparison must not use raw livePrice
// ---------------------------------------------------------------------------
test("P10 regression 1: price-change comparison evaluates fresh effective quote and does not false-reject on raw livePrice", async () => {
  // Fixture:
  // Fresh Pancake base (500_000) != promotional effective price (400_000).
  // Buyer-confirmed DRAFT price is 400_000 (valid fixed promotion).
  // Fresh effective quote from central resolver at submission time is 400_000.
  const { product, variant } = await seedVariant("reg1-comparison", 500_000);
  await seedCampaign(variant.id, { discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(400_000) });
  const publicCode = `${prefix}-reg1-order`;
  await createDraft(variant.id, publicCode, 1);

  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(draft.lines[0]!.unitPriceVnd, BigInt(400_000));
  assert.equal(draft.lines[0]!.baseUnitPriceVnd, BigInt(500_000));

  const createdRequests: unknown[] = [];
  const gateway = {
    async fetchVariations() {
      // Pancake reports raw catalog base 500_000.
      return [liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000)];
    },
    async createOrder(request: unknown) {
      createdRequests.push(request);
      return { id: 910_001 };
    },
  };

  const result = await submissionService(gateway).submit({ publicCode, shopId });

  // Expected: submission continues to CONFIRMED, no false PRICE_CHANGED.
  // Must fail if comparison reverts to: line.unitPriceVnd !== BigInt(live.retailPrice).
  assert.equal(result.ok, true, "an unchanged promotional effective price must not trigger PRICE_CHANGED");
  if (!result.ok) return;
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.pancakeOrderId, "910001");
  assert.equal(createdRequests.length, 1, "order reaches Pancake gateway exactly once");
});

// ---------------------------------------------------------------------------
// Regression 2 — totals must use final/effective money
// ---------------------------------------------------------------------------
test("P10 regression 2: line total, subtotal, shipping and order total derive strictly from authoritative effective money", async () => {
  // Fixture:
  // Fresh catalog base = 550_000 VND.
  // Promotion fixed price = 400_000 VND.
  // Quantity = 2.
  // Under authoritative effective money:
  //   unitPriceVnd = 400_000
  //   lineTotalVnd = 800_000
  //   merchandiseSubtotalVnd = 800_000 (< 1_000_000 threshold and quantity 2 < 3)
  //   shippingFeeVnd = calculateGuestShippingFeeVnd({ subtotalVnd: 800_000, totalQuantity: 2 }) = 30_000
  //   totalVnd = 830_000
  // Under raw base (if erroneously used):
  //   raw subtotal = 2 * 550_000 = 1_100_000 (>= 1_000_000 => free shipping 0 VND)
  //   raw total = 1_100_000 != 830_000.
  const { product, variant } = await seedVariant("reg2-totals", 550_000);
  await seedCampaign(variant.id, { discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(400_000) });
  const publicCode = `${prefix}-reg2-order`;
  await createDraft(variant.id, publicCode, 2);

  let capturedRequest: PancakeCreateOrderRequest | null = null;
  const gateway = {
    async fetchVariations() {
      return [liveVariation(variant.pancakeVariationId, product.pancakeProductId, 550_000, 10)];
    },
    async createOrder(request: unknown) {
      capturedRequest = request as PancakeCreateOrderRequest;
      return { id: 910_002 };
    },
  };

  const result = await submissionService(gateway).submit({ publicCode, shopId });
  assert.equal(result.ok, true, "valid promotional order with quantity 2 must succeed");

  const confirmed = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });

  // Assert each money component independently:
  const line = confirmed.lines[0]!;
  const expectedUnitPrice = 400_000;
  const expectedLineTotal = 800_000;
  const expectedSubtotal = 800_000;
  const expectedShipping = calculateGuestShippingFeeVnd({
    subtotalVnd: expectedSubtotal,
    totalQuantity: 2,
  });
  const expectedTotal = expectedSubtotal + expectedShipping;

  assert.equal(line.unitPriceVnd, BigInt(expectedUnitPrice), "line unitPriceVnd must be effective price 400_000");
  assert.equal(line.lineTotalVnd, BigInt(expectedLineTotal), "line lineTotalVnd must be 800_000");
  assert.equal(confirmed.merchandiseSubtotalVnd, BigInt(expectedSubtotal), "merchandiseSubtotalVnd must be 800_000");
  assert.equal(confirmed.shippingFeeVnd, BigInt(expectedShipping), "shippingFeeVnd must be 30_000");
  assert.equal(confirmed.totalVnd, BigInt(expectedTotal), "totalVnd must be 830_000");

  // Outbound create request must also reflect effective shipping and free shipping state
  assert.ok(capturedRequest);
  const req = capturedRequest as PancakeCreateOrderRequest;
  assert.equal(req.shipping_fee, expectedShipping);
  assert.equal(req.is_free_shipping, false);
});

// ---------------------------------------------------------------------------
// Regression 3 — outbound requested price
// ---------------------------------------------------------------------------
test("P10 regression 3: outbound Pancake request sends finalized effective unitPriceVnd, not fresh catalog base", async () => {
  // Case: OrderLineSnapshot.unitPriceVnd (400_000) != fresh Pancake catalog base (500_000).
  const { product, variant } = await seedVariant("reg3-outbound", 500_000);
  await seedCampaign(variant.id, { discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(400_000) });
  const publicCode = `${prefix}-reg3-order`;
  await createDraft(variant.id, publicCode, 1);

  let capturedRequest: PancakeCreateOrderRequest | null = null;
  let createOrderCalls = 0;
  const gateway = {
    async fetchVariations() {
      // Fresh catalog base = 500_000, sellableStock = 7
      return [liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000, 7)];
    },
    async createOrder(request: unknown) {
      createOrderCalls += 1;
      capturedRequest = request as PancakeCreateOrderRequest;
      return { id: 910_003 };
    },
  };

  const result = await submissionService(gateway).submit({ publicCode, shopId });

  // Order reaches normal confirmed path
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.pancakeOrderId, "910003");

  // create-order exactly once
  assert.equal(createOrderCalls, 1, "createOrder must be called exactly once");

  // Check captured request shape
  assert.ok(capturedRequest, "gateway must have received the create order request");
  const req = capturedRequest as PancakeCreateOrderRequest;

  // External variation identity checked
  assert.equal(req.items.length, 1);
  const item = req.items[0]!;
  assert.equal(item.variation_id, variant.pancakeVariationId, "variation identity must match purchased variant");
  assert.equal(item.quantity, 1);

  // Outbound retail_price must be finalized OrderLineSnapshot.unitPriceVnd (400_000), NOT livePrice (500_000)
  const confirmed = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  const snapshotUnitPrice = Number(confirmed.lines[0]!.unitPriceVnd);
  assert.equal(snapshotUnitPrice, 400_000);
  assert.equal(
    item.variation_info.retail_price,
    400_000,
    "variation_info.retail_price must be 400_000, not the raw live base 500_000",
  );
  assert.equal(
    item.variation_info.retail_price,
    snapshotUnitPrice,
    "outbound retail_price must strictly equal OrderLineSnapshot.unitPriceVnd",
  );
});
