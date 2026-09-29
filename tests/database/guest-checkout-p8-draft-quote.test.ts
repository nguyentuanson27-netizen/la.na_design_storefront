import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-03T03:00:00.000Z");
const prefix = "u20-p8-draft-quote";

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: "Gọi trước khi giao",
  // Deliberately browser-controlled historical money-looking fields. They must stay non-authoritative.
  price: 1,
  stock: 999,
  discount: 999_999,
  shippingFee: 0,
  promotionCampaignId: "browser-controlled",
};

type SeededProduct = Awaited<ReturnType<typeof seedProduct>>;

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: prefix } } });
  await prisma.cart.deleteMany({
    where: {
      items: {
        some: {
          variant: { pancakeVariationId: { startsWith: prefix } },
        },
      },
    },
  });
  await prisma.promotionCampaign.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: prefix } } });
}

async function seedProduct(label: string, unitPriceVnd: number) {
  return prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `U20 Product ${label.toUpperCase()}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${label}`,
          color: label === "b" ? "White" : "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: unitPriceVnd,
          pancakeRetailPriceAfterDiscount: unitPriceVnd,
          syncedAt: now,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-warehouse-${label}`,
              quantity: 10,
              syncedAt: now,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
}

async function seedCart(variantId: string, quantity = 1) {
  return prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 60_000),
      items: { create: { variantId, quantity } },
    },
  });
}

async function seedPercentagePromotion(product: SeededProduct, percentageValue: number) {
  const variant = product.variants[0]!;
  return prisma.promotionCampaign.create({
    data: {
      kind: "PROMOTION",
      name: `${prefix}-percentage-${percentageValue}`,
      discountType: "PERCENTAGE",
      percentageValue,
      fixedPriceVnd: null,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: variant.id } },
    },
  });
}

async function seedFixedPromotion(product: SeededProduct, fixedPriceVnd: bigint) {
  const variant = product.variants[0]!;
  return prisma.promotionCampaign.create({
    data: {
      kind: "FLASH_SALE",
      name: `${prefix}-fixed-${fixedPriceVnd}`,
      discountType: "FIXED_PRICE",
      percentageValue: null,
      fixedPriceVnd,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId: variant.id } },
    },
  });
}

async function createDraft({
  cartId,
  publicCode,
  input = checkoutInput,
  at = now,
}: {
  cartId: string;
  publicCode: string;
  input?: unknown;
  at?: Date;
}) {
  const snapshot = createGuestCheckoutSnapshotService(prisma, { checkoutInputValidated: true, verifyRenderedQuote: acceptAnyRenderedQuote });
  const result = await snapshot.create({
    cartId,
    shopId,
    publicCode,
    checkoutInput: input,
    now: at,
  });
  if (!result.ok) throw new Error(`snapshot failed: ${result.reason}`);
  return result;
}

async function readDraft(publicCode: string) {
  return prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("P8 no-promotion DRAFT records authoritative base=final money and no promotion audit", async () => {
  const product = await seedProduct("no-promo", 500_000);
  const variant = product.variants[0]!;
  const cart = await seedCart(variant.id, 2);
  const publicCode = `${prefix}-no-promo-order`;

  await createDraft({ cartId: cart.id, publicCode });
  const order = await readDraft(publicCode);
  assert.equal(order.state, "DRAFT");
  assert.equal(order.merchandiseSubtotalVnd, BigInt(1_000_000));
  assert.equal(order.lines.length, 1);

  const line = order.lines[0]!;
  assert.equal(line.pancakeVariationId, variant.pancakeVariationId);
  assert.equal(line.quantity, 2);
  assert.equal(line.baseUnitPriceVnd, BigInt(500_000));
  assert.equal(line.unitPriceVnd, BigInt(500_000));
  assert.equal(line.lineTotalVnd, BigInt(1_000_000));
  assert.equal(line.promotionCampaignId, null);
  assert.equal(line.promotionName, null);
  assert.equal(line.promotionKind, null);
  assert.equal(line.promotionDiscountType, null);
  assert.equal(line.promotionPercentageValue, null);
  assert.equal(line.promotionFixedPriceVnd, null);
});

test("P8 percentage DRAFT records one coherent base/final/campaign audit snapshot", async () => {
  const product = await seedProduct("percentage", 500_000);
  const variant = product.variants[0]!;
  const campaign = await seedPercentagePromotion(product, 20);
  const cart = await seedCart(variant.id);
  const publicCode = `${prefix}-percentage-order`;

  await createDraft({ cartId: cart.id, publicCode });
  const order = await readDraft(publicCode);
  const line = order.lines[0]!;

  assert.equal(line.baseUnitPriceVnd, BigInt(500_000));
  assert.equal(line.unitPriceVnd, BigInt(400_000));
  assert.equal(line.lineTotalVnd, BigInt(400_000));
  assert.equal(line.promotionCampaignId, campaign.id);
  assert.equal(line.promotionName, campaign.name);
  assert.equal(line.promotionKind, "PROMOTION");
  assert.equal(line.promotionDiscountType, "PERCENTAGE");
  assert.equal(line.promotionPercentageValue, 20);
  assert.equal(line.promotionFixedPriceVnd, null);
});

test("P8 fixed-price DRAFT records fixed audit without fabricating a percentage", async () => {
  const product = await seedProduct("fixed", 500_000);
  const variant = product.variants[0]!;
  const campaign = await seedFixedPromotion(product, BigInt(350_000));
  const cart = await seedCart(variant.id);
  const publicCode = `${prefix}-fixed-order`;

  await createDraft({ cartId: cart.id, publicCode });
  const line = (await readDraft(publicCode)).lines[0]!;

  assert.equal(line.baseUnitPriceVnd, BigInt(500_000));
  assert.equal(line.unitPriceVnd, BigInt(350_000));
  assert.equal(line.promotionCampaignId, campaign.id);
  assert.equal(line.promotionName, campaign.name);
  assert.equal(line.promotionKind, "FLASH_SALE");
  assert.equal(line.promotionDiscountType, "FIXED_PRICE");
  assert.equal(line.promotionPercentageValue, null);
  assert.equal(line.promotionFixedPriceVnd, BigInt(350_000));
});

test("P8 retry refresh mutates the same DRAFT identity and atomically replaces stale line/customer facts", async () => {
  const productA = await seedProduct("retry-a", 400_000);
  const productB = await seedProduct("retry-b", 650_000);
  const variantA = productA.variants[0]!;
  const variantB = productB.variants[0]!;
  const cart = await seedCart(variantA.id);
  const publicCode = `${prefix}-retry-order`;

  const first = await createDraft({ cartId: cart.id, publicCode });
  const firstOrder = await readDraft(publicCode);

  const unavailable = createPancakeOrderSubmissionService(prisma, {
    async fetchVariations() {
      throw new Error("temporary validation transport failure");
    },
    async createOrder() {
      throw new Error("must not POST while validation is unavailable");
    },
  });
  assert.deepEqual(await unavailable.submit({ publicCode, shopId }), {
    ok: false,
    state: "DRAFT",
    reason: "VALIDATION_UNAVAILABLE",
  });

  await prisma.$transaction([
    prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
    prisma.cartItem.create({ data: { cartId: cart.id, variantId: variantB.id, quantity: 2 } }),
  ]);

  const refreshedInput = {
    ...checkoutInput,
    name: "Nguyễn Văn B",
    phone: "0987654321",
    provinceRef: "province-02",
    districtRef: "district-002",
    communeRef: "commune-0002",
    detail: "34 Đường B",
    note: "Địa chỉ mới",
    price: 7,
    discount: 7,
    shippingFee: 7,
    promotionCampaignId: "still-browser-controlled",
  };

  const snapshot = createGuestCheckoutSnapshotService(prisma, { checkoutInputValidated: true, verifyRenderedQuote: acceptAnyRenderedQuote });
  const retry = await snapshot.create({
    cartId: cart.id,
    shopId,
    publicCode: `${prefix}-unused-new-code`,
    checkoutInput: refreshedInput,
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;

  assert.equal(retry.order.publicCode, publicCode, "retry must preserve the DRAFT public identity");
  const refreshed = await readDraft(publicCode);
  assert.equal(refreshed.id, firstOrder.id);
  assert.equal(refreshed.publicCode, first.order.publicCode);
  assert.equal(refreshed.state, "DRAFT");
  assert.equal(refreshed.syncErrorCode, null);
  assert.equal(refreshed.guestName, "Nguyễn Văn B");
  assert.equal(refreshed.guestPhone, "0987654321");
  assert.equal(refreshed.addressDetail, "34 Đường B");
  assert.equal(refreshed.note, "Địa chỉ mới");
  assert.equal(refreshed.lines.length, 1);
  assert.equal(refreshed.lines[0]!.variantId, variantB.id);
  assert.equal(refreshed.lines[0]!.pancakeVariationId, variantB.pancakeVariationId);
  assert.equal(refreshed.lines[0]!.quantity, 2);
  assert.equal(refreshed.lines[0]!.baseUnitPriceVnd, BigInt(650_000));
  assert.equal(refreshed.lines[0]!.unitPriceVnd, BigInt(650_000));
  assert.equal(refreshed.merchandiseSubtotalVnd, BigInt(1_300_000));

  assert.equal(
    await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }),
    1,
    "retry refresh must not manufacture a rejected superseded order",
  );
});

test("P8 quote freezes once the order has left DRAFT even when cart and browser fields change", async () => {
  const productA = await seedProduct("freeze-a", 400_000);
  const productB = await seedProduct("freeze-b", 650_000);
  const variantA = productA.variants[0]!;
  const variantB = productB.variants[0]!;
  const cart = await seedCart(variantA.id);
  const publicCode = `${prefix}-freeze-order`;

  await createDraft({ cartId: cart.id, publicCode });
  const before = await readDraft(publicCode);
  await prisma.orderMirror.update({ where: { id: before.id }, data: { state: "VALIDATING" } });
  await prisma.$transaction([
    prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
    prisma.cartItem.create({ data: { cartId: cart.id, variantId: variantB.id, quantity: 3 } }),
  ]);

  const snapshot = createGuestCheckoutSnapshotService(prisma, { checkoutInputValidated: true, verifyRenderedQuote: acceptAnyRenderedQuote });
  const result = await snapshot.create({
    cartId: cart.id,
    shopId,
    publicCode: `${prefix}-ignored-freeze-code`,
    checkoutInput: { ...checkoutInput, name: "Attacker-controlled new name", price: 1 },
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.publicCode, publicCode);
  assert.equal(result.order.state, "VALIDATING");

  const after = await readDraft(publicCode);
  assert.equal(after.guestName, before.guestName);
  assert.equal(after.merchandiseSubtotalVnd, before.merchandiseSubtotalVnd);
  assert.deepEqual(
    after.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceVnd: line.unitPriceVnd,
    })),
    before.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceVnd: line.unitPriceVnd,
    })),
  );
});
