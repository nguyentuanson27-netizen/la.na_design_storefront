import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";
import { createCartLineAuthorityResolver } from "../../src/commerce/cart-line-authority.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { deriveStorefrontProjectionSelection } from "../../src/commerce/storefront-projection.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 910_081;
const cartId = "combo-subsets-cart";
const publicCodePrefix = "combo-subsets-order";
const syncedAt = new Date("2026-09-25T16:00:00.000Z");
const now = new Date("2026-09-26T00:00:00.000Z");

const checkoutInput = {
  name: "Nguyen Van A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-01",
  communeRef: "commune-01",
  detail: "12 Duong A",
  note: "",
};

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: publicCodePrefix } } });
  await prisma.cart.deleteMany({ where: { id: cartId } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

async function createProduct(key: string, isActive: boolean) {
  return prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `combo-subsets-${key}`,
      slug: `combo-subsets-${key}`,
      name: `Product ${key}`,
      isPresent: true,
      isActive,
      syncedAt,
    },
  });
}

async function createVariant({
  key,
  productId,
  sku,
  price,
  stock,
}: {
  key: string;
  productId: string;
  sku: string;
  price: number;
  stock: number;
}) {
  return prisma.variantMirror.create({
    data: {
      pancakeVariationId: `combo-subsets-${key}`,
      productId,
      sku,
      size: "M",
      isPresent: true,
      isActive: true,
      pancakeRetailPrice: price,
      pancakeRetailPriceAfterDiscount: price,
      syncedAt,
      warehouseStocks: {
        create: { pancakeWarehouseId: `combo-subsets-wh-${key}`, quantity: stock, syncedAt },
      },
    },
  });
}

async function compose(parentVariantId: string, componentVariantIds: readonly string[]) {
  await prisma.compositeComponentMirror.createMany({
    data: componentVariantIds.map((componentVariantId) => ({
      parentVariantId,
      componentVariantId,
      quantity: 1,
      syncedAt,
    })),
  });
}

/**
 * Two public combos (555 and 747), each built from its own inactive Áo, CV and Quần products.
 * Sibling composites are kept `isActive = false` on the product, as the unified PDP intends.
 * Composite variants carry zero Pancake stock of their own: capacity comes from components.
 */
async function seedCatalog() {
  const combo555 = await createProduct("combo-555", true);
  const combo747 = await createProduct("combo-747", true);
  const ao555 = await createProduct("ao-555", false);
  const cv555 = await createProduct("cv-555", false);
  const quan555 = await createProduct("quan-555", false);
  const ao747 = await createProduct("ao-747", false);
  const cv747 = await createProduct("cv-747", false);
  const quan747 = await createProduct("quan-747", false);
  const setVay555 = await createProduct("sv-555", false);
  const setQuan555 = await createProduct("sq-555", false);
  const cvOnly555 = await createProduct("cv-only-555", false);
  const crossCombo = await createProduct("cross-combo", false);

  const aoM = await createVariant({ key: "ao-555-m", productId: ao555.id, sku: "AO-555-M", price: 429_000, stock: 4 });
  const cvM = await createVariant({ key: "cv-555-m", productId: cv555.id, sku: "CV-555-M", price: 429_000, stock: 4 });
  const quanM = await createVariant({ key: "quan-555-m", productId: quan555.id, sku: "QUAN-555-M", price: 299_000, stock: 4 });
  const ao747M = await createVariant({ key: "ao-747-m", productId: ao747.id, sku: "AO-747-M", price: 429_000, stock: 4 });
  const cv747M = await createVariant({ key: "cv-747-m", productId: cv747.id, sku: "CV-747-M", price: 429_000, stock: 4 });
  const quan747M = await createVariant({ key: "quan-747-m", productId: quan747.id, sku: "QUAN-747-M", price: 299_000, stock: 4 });

  const combo555M = await createVariant({ key: "combo-555-m", productId: combo555.id, sku: "COMBO-555-M", price: 749_000, stock: 0 });
  const combo747M = await createVariant({ key: "combo-747-m", productId: combo747.id, sku: "COMBO-747-M", price: 749_000, stock: 0 });
  const setVayM = await createVariant({ key: "sv-555-m", productId: setVay555.id, sku: "SV555-M", price: 599_000, stock: 0 });
  const setQuanM = await createVariant({ key: "sq-555-m", productId: setQuan555.id, sku: "SQ555-M", price: 579_000, stock: 0 });
  const cvOnlyM = await createVariant({ key: "cv-only-555-m", productId: cvOnly555.id, sku: "SV555-CV-M", price: 399_000, stock: 0 });
  const crossM = await createVariant({ key: "cross-combo-m", productId: crossCombo.id, sku: "SV-CROSS-M", price: 499_000, stock: 0 });

  await compose(combo555M.id, [aoM.id, cvM.id, quanM.id]);
  await compose(combo747M.id, [ao747M.id, cv747M.id, quan747M.id]);
  await compose(setVayM.id, [aoM.id, cvM.id]);
  await compose(setQuanM.id, [aoM.id, quanM.id]);
  // Role-shaped but wrong: only the CV piece of 555.
  await compose(cvOnlyM.id, [cvM.id]);
  // Áo from active COMBO 555 and Váy from active COMBO 747 — each piece has *some* active combo,
  // but no single combo contains both.
  await compose(crossM.id, [aoM.id, cv747M.id]);

  return { combo555M, aoM, cvM, quanM, setVayM, setQuanM, cvOnlyM, crossM };
}

test("an inactive sibling SET VÁY goes PDP selection → cart → checkout snapshot on one authority", async () => {
  const catalog = await seedCatalog();

  // PDP: the unified combo page offers exactly the authorized subsets, in the UX order.
  const detail = await createStorefrontProductDetailRepository(prisma).getProductBySlug({
    shopId,
    slug: "combo-subsets-combo-555",
    now,
  });
  assert.ok(detail);
  assert.equal(detail.projection.mode, "composite");
  const optionIds = detail.projection.options.map(({ id }) => id);
  assert.ok(!optionIds.includes(catalog.cvOnlyM.id), "a one-piece CV composite is not a SET VÁY");
  assert.ok(!optionIds.includes(catalog.crossM.id), "a cross-combo composite is not a subset");
  assert.deepEqual(
    detail.projection.options
      .filter(({ kindKey }) => kindKey === "parent" || kindKey?.startsWith("sub-set-"))
      .map(({ id, kindLabel }) => ({ id, kindLabel })),
    [
      { id: catalog.combo555M.id, kindLabel: "COMBO" },
      { id: catalog.setVayM.id, kindLabel: "SET VÁY" },
      { id: catalog.setQuanM.id, kindLabel: "SET QUẦN" },
    ],
  );
  assert.equal(detail.variantSkuById[catalog.setVayM.id], "SV555-M");
  assert.equal(detail.variantSkuById[catalog.cvOnlyM.id], undefined);

  const selection = deriveStorefrontProjectionSelection(detail.projection.options, {
    kindKey: "sub-set-vay",
    color: null,
    size: "M",
  });
  assert.equal(selection.selectedVariantId, catalog.setVayM.id);
  assert.equal(selection.selectedPrice, 599_000);
  assert.equal(selection.canAdd, true);

  // Cart: the real add-to-cart mutation with the production line authority.
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date("2026-09-27T00:00:00.000Z") } });
  const cartService = createAnonymousCartService(prisma);
  const added = await cartService.addItemUnit({
    cartId,
    variantId: selection.selectedVariantId!,
    now,
    resolveLine: createCartLineAuthorityResolver({ shopId, now }),
  });
  assert.equal(added.ok, true);

  const [line] = await createStorefrontCartRepository(prisma).getLines({
    shopId,
    items: [{ variantId: catalog.setVayM.id, quantity: 1 }],
    now,
  });
  assert.equal(line?.available, true);
  assert.equal(line?.price, 599_000);

  // Checkout snapshot: the same line the cart accepted is accepted here.
  const checkout = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });
  const result = await checkout.create({
    cartId,
    shopId,
    publicCode: `${publicCodePrefix}-sv`,
    checkoutInput,
    now,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  if (!result.ok) return;
  assert.equal(result.order.merchandiseSubtotalVnd, BigInt(599_000));

  const order = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: `${publicCodePrefix}-sv` },
    include: { lines: true },
  });
  assert.deepEqual(
    order.lines.map(({ variantId, pancakeVariationId, unitPriceVnd }) => ({
      variantId,
      pancakeVariationId,
      unitPriceVnd,
    })),
    [
      {
        variantId: catalog.setVayM.id,
        pancakeVariationId: "combo-subsets-sv-555-m",
        unitPriceVnd: BigInt(599_000),
      },
    ],
  );
});

test("composites that are not an exact subset of one active combo fail closed at cart and checkout", async () => {
  const catalog = await seedCatalog();
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date("2026-09-27T00:00:00.000Z") } });
  const cartService = createAnonymousCartService(prisma);
  const checkout = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  });

  for (const variant of [catalog.crossM, catalog.cvOnlyM]) {
    assert.deepEqual(
      await cartService.addItemUnit({
        cartId,
        variantId: variant.id,
        now,
        resolveLine: createCartLineAuthorityResolver({ shopId, now }),
      }),
      { ok: false, reason: "VARIANT_UNAVAILABLE" },
    );

    const [line] = await createStorefrontCartRepository(prisma).getLines({
      shopId,
      items: [{ variantId: variant.id, quantity: 1 }],
      now,
    });
    assert.equal(line?.available, false);
    assert.equal(line?.unavailableReason, "PRODUCT_UNAVAILABLE");

    // A line smuggled past the cart mutation is still refused by the checkout snapshot.
    await prisma.cartItem.deleteMany({ where: { cartId } });
    await prisma.cartItem.create({ data: { cartId, variantId: variant.id, quantity: 1 } });
    assert.deepEqual(
      await checkout.create({
        cartId,
        shopId,
        publicCode: `${publicCodePrefix}-rogue`,
        checkoutInput,
        now,
      }),
      { ok: false, reason: "CART_LINE_UNAVAILABLE" },
    );
  }

  // Deactivating the combo withdraws its subsets everywhere at once.
  await prisma.variantMirror.update({
    where: { id: catalog.combo555M.id },
    data: { isActive: false },
  });
  const [setVayLine] = await createStorefrontCartRepository(prisma).getLines({
    shopId,
    items: [{ variantId: catalog.setVayM.id, quantity: 1 }],
    now,
  });
  assert.equal(setVayLine?.available, false);
  await prisma.cartItem.deleteMany({ where: { cartId } });
  assert.deepEqual(
    await cartService.addItemUnit({
      cartId,
      variantId: catalog.setVayM.id,
      now,
      resolveLine: createCartLineAuthorityResolver({ shopId, now }),
    }),
    { ok: false, reason: "VARIANT_UNAVAILABLE" },
  );
});
