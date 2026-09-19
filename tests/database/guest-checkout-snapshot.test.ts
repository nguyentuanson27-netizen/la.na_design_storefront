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

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const shopId = 920_007;
const now = new Date("2026-08-11T08:40:00.000Z");

const checkoutInput = {
  name: "  Nguyễn Văn A  ",
  phone: "  0901234567  ",
  provinceRef: "  province-01  ",
  districtRef: "  district-001  ",
  communeRef: "  commune-0001  ",
  detail: "  12 Đường A  ",
  note: "  Gọi trước khi giao  ",
  price: 1,
  stock: 999,
  discount: 999_999,
  shippingFee: 0,
  pancakeOrderId: "browser-controlled",
};

async function createCartProduct({
  key,
  unitPriceVnd,
  quantity,
  stock,
  productShopId = shopId,
  sellingMode,
}: {
  key: string;
  unitPriceVnd: number;
  quantity: number;
  stock: number;
  productShopId?: number;
  sellingMode?: "STANDARD" | "OVERSELL" | "PREORDER";
}) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: productShopId,
      pancakeProductId: `checkout-product-${key}`,
      slug: `checkout-product-${key}`,
      name: `Checkout Product ${key}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      // Absent by default, which is the approved missing-row answer and what every existing case
      // in this file relies on.
      ...(sellingMode === undefined
        ? {}
        : { sellingPolicy: { create: { sellingMode, negativeStockLimit: -20 } } }),
      variants: {
        create: {
          pancakeVariationId: `checkout-variation-${key}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: unitPriceVnd,
          pancakeRetailPriceAfterDiscount: unitPriceVnd,
          syncedAt: now,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `checkout-warehouse-${key}`,
              quantity: stock,
              syncedAt: now,
            },
          },
        },
      },
    },
    include: { variants: true },
  });

  const variant = product.variants[0]!;
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 60_000),
      items: {
        create: {
          variantId: variant.id,
          quantity,
        },
      },
    },
  });

  return { product, variant, cart };
}

async function cleanup(key: string) {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: `checkout-${key}` } } });
  await prisma.cart.deleteMany({
    where: {
      items: {
        some: {
          variant: { pancakeVariationId: `checkout-variation-${key}` },
        },
      },
    },
  });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: `checkout-product-${key}` } });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("checkout snapshot persists server-authoritative lines, shop scope, and the default 30,000 VND shipping fee", async () => {
  const key = "default-shipping";
  await cleanup(key);
  const { product, variant, cart } = await createCartProduct({
    key,
    unitPriceVnd: 500_000,
    quantity: 2,
    stock: 2,
  });
  const publicCode = `checkout-${key}-001`;
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  const result = await service.create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.publicCode, publicCode);
  assert.equal(result.order.state, "DRAFT");
  assert.equal(result.order.merchandiseSubtotalVnd, BigInt(1_000_000));
  assert.equal(result.order.shippingFeeVnd, BigInt(30_000));
  assert.equal(result.order.totalVnd, BigInt(1_030_000));

  const persisted = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });

  assert.equal(persisted.pancakeShopId, shopId);
  assert.equal(persisted.checkoutSnapshottedAt?.toISOString(), now.toISOString());
  assert.equal(persisted.guestName, "Nguyễn Văn A");
  assert.equal(persisted.guestPhone, "0901234567");
  assert.equal(persisted.provinceRef, "province-01");
  assert.equal(persisted.districtRef, "district-001");
  assert.equal(persisted.communeRef, "commune-0001");
  assert.equal(persisted.addressDetail, "12 Đường A");
  assert.equal(persisted.note, "Gọi trước khi giao");
  assert.equal(persisted.merchandiseSubtotalVnd, BigInt(1_000_000));
  assert.equal(persisted.shippingFeeVnd, BigInt(30_000));
  assert.equal(persisted.totalVnd, BigInt(1_030_000));
  assert.deepEqual(
    persisted.lines.map((line) => ({
      variantId: line.variantId,
      pancakeVariationId: line.pancakeVariationId,
      productName: line.productName,
      color: line.color,
      size: line.size,
      quantity: line.quantity,
      unitPriceVnd: line.unitPriceVnd,
      lineTotalVnd: line.lineTotalVnd,
    })),
    [
      {
        variantId: variant.id,
        pancakeVariationId: `checkout-variation-${key}`,
        productName: `Checkout Product ${key}`,
        color: "Black",
        size: "M",
        quantity: 2,
        unitPriceVnd: BigInt(500_000),
        lineTotalVnd: BigInt(1_000_000),
      },
    ],
  );

  await prisma.productMirror.update({
    where: { id: product.id },
    data: { name: "Changed after snapshot" },
  });
  await prisma.variantMirror.update({
    where: { id: variant.id },
    data: {
      color: "Stone",
      pancakeRetailPrice: 1,
      pancakeRetailPriceAfterDiscount: 1,
    },
  });

  const unchanged = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(unchanged.lines[0]?.productName, `Checkout Product ${key}`);
  assert.equal(unchanged.lines[0]?.color, "Black");
  assert.equal(unchanged.lines[0]?.unitPriceVnd, BigInt(500_000));

  await cleanup(key);
});

test("F8a the submit path judges a line by the stored selling policy, not by STANDARD", async () => {
  // Review finding: this path hydrated products without `ProductSellingPolicy`, so
  // `buildStorefrontCartLines()` fell back to STANDARD's floor of 0. A PREORDER variant at stock 0
  // and an OVERSELL variant below zero were both shown as purchasable on the PDP, the cart and the
  // checkout, and then refused here as CART_LINE_UNAVAILABLE — before I6b's reservation ever got to
  // make the authoritative decision. Nothing about the request distinguishes them; only the row.
  for (const [key, sellingMode, stock] of [
    ["preorder-policy", "PREORDER", 0],
    ["oversell-policy", "OVERSELL", -5],
  ] as const) {
    await cleanup(key);
    const { cart } = await createCartProduct({
      key,
      unitPriceVnd: 500_000,
      quantity: 1,
      stock,
      sellingMode,
    });
    const publicCode = `checkout-${key}-001`;
    const service = createGuestCheckoutSnapshotService(prisma, {
      checkoutInputValidated: true,
      verifyRenderedQuote: acceptAnyRenderedQuote,
    });

    const result = await service.create({
      cartId: cart.id,
      shopId,
      publicCode,
      checkoutInput,
      now,
    });

    assert.equal(
      result.ok,
      true,
      `${sellingMode} at stock ${stock} must survive to the capacity boundary, not be refused here`,
    );
    await cleanup(key);
  }
});

test("checkout snapshot grants freeship when total quantity reaches three products", async () => {
  const key = "quantity-freeship";
  await cleanup(key);
  const { cart } = await createCartProduct({
    key,
    unitPriceVnd: 200_000,
    quantity: 3,
    stock: 3,
  });
  const publicCode = `checkout-${key}-001`;
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  const result = await service.create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.order.merchandiseSubtotalVnd, BigInt(600_000));
    assert.equal(result.order.shippingFeeVnd, BigInt(0));
    assert.equal(result.order.totalVnd, BigInt(600_000));
  }

  await cleanup(key);
});

test("checkout snapshot fails closed for unavailable lines, wrong-shop catalog data, expired carts, and malformed customer input", async () => {
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  const unavailableKey = "unavailable";
  await cleanup(unavailableKey);
  const unavailable = await createCartProduct({
    key: unavailableKey,
    unitPriceVnd: 300_000,
    quantity: 2,
    stock: 1,
  });
  assert.deepEqual(
    await service.create({
      cartId: unavailable.cart.id,
      shopId,
      publicCode: `checkout-${unavailableKey}-001`,
      checkoutInput,
      now,
    }),
    { ok: false, reason: "CART_LINE_UNAVAILABLE" },
  );
  assert.equal(
    await prisma.orderMirror.count({ where: { publicCode: `checkout-${unavailableKey}-001` } }),
    0,
  );
  await cleanup(unavailableKey);

  const wrongShopKey = "wrong-shop";
  await cleanup(wrongShopKey);
  const wrongShop = await createCartProduct({
    key: wrongShopKey,
    unitPriceVnd: 300_000,
    quantity: 1,
    stock: 1,
    productShopId: shopId + 1,
  });
  assert.deepEqual(
    await service.create({
      cartId: wrongShop.cart.id,
      shopId,
      publicCode: `checkout-${wrongShopKey}-001`,
      checkoutInput,
      now,
    }),
    { ok: false, reason: "CART_LINE_UNAVAILABLE" },
  );
  await cleanup(wrongShopKey);

  const expiredKey = "expired";
  await cleanup(expiredKey);
  const expired = await createCartProduct({
    key: expiredKey,
    unitPriceVnd: 300_000,
    quantity: 1,
    stock: 1,
  });
  await prisma.cart.update({
    where: { id: expired.cart.id },
    data: { expiresAt: now },
  });
  assert.deepEqual(
    await service.create({
      cartId: expired.cart.id,
      shopId,
      publicCode: `checkout-${expiredKey}-001`,
      checkoutInput,
      now,
    }),
    { ok: false, reason: "CART_UNAVAILABLE" },
  );
  await cleanup(expiredKey);

  assert.deepEqual(
    await service.create({
      cartId: "not-a-live-cart",
      shopId,
      publicCode: "checkout-malformed-001",
      checkoutInput: { ...checkoutInput, phone: 123 },
      now,
    }),
    { ok: false, reason: "INVALID_INPUT" },
  );
});
