import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";
import { createCartLineAuthorityResolver } from "../../src/commerce/cart-line-authority.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { deriveStorefrontProjectionSelection } from "../../src/commerce/storefront-projection.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
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

async function compose(
  parentVariantId: string,
  componentVariantIds: readonly string[],
  quantities: readonly number[] = [],
) {
  await prisma.compositeComponentMirror.createMany({
    data: componentVariantIds.map((componentVariantId, index) => ({
      parentVariantId,
      componentVariantId,
      quantity: quantities[index] ?? 1,
      syncedAt,
    })),
  });
}

/**
 * Three public combos (555, 747 and 999), each built from its own inactive Áo, CV and Quần
 * products; COMBO 999 consumes two Áo, so it is not the 3-piece combo the SET contract names.
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
  const aoTwice555 = await createProduct("ao-twice-555", false);
  const combo999 = await createProduct("combo-999", true);
  const ao999 = await createProduct("ao-999", false);
  const cv999 = await createProduct("cv-999", false);
  const quan999 = await createProduct("quan-999", false);
  const setVay999 = await createProduct("sv-999", false);

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
  const aoTwiceM = await createVariant({ key: "ao-twice-555-m", productId: aoTwice555.id, sku: "SV555-2AO-M", price: 699_000, stock: 0 });
  const ao999M = await createVariant({ key: "ao-999-m", productId: ao999.id, sku: "AO-999-M", price: 429_000, stock: 4 });
  const cv999M = await createVariant({ key: "cv-999-m", productId: cv999.id, sku: "CV-999-M", price: 429_000, stock: 4 });
  const quan999M = await createVariant({ key: "quan-999-m", productId: quan999.id, sku: "QUAN-999-M", price: 299_000, stock: 4 });
  const combo999M = await createVariant({ key: "combo-999-m", productId: combo999.id, sku: "COMBO-999-M", price: 999_000, stock: 0 });
  const setVay999M = await createVariant({ key: "sv-999-m", productId: setVay999.id, sku: "SV999-M", price: 599_000, stock: 0 });

  await compose(combo555M.id, [aoM.id, cvM.id, quanM.id]);
  await compose(combo747M.id, [ao747M.id, cv747M.id, quan747M.id]);
  await compose(setVayM.id, [aoM.id, cvM.id]);
  await compose(setQuanM.id, [aoM.id, quanM.id]);
  // Role-shaped but wrong: only the CV piece of 555.
  await compose(cvOnlyM.id, [cvM.id]);
  // Áo from active COMBO 555 and Váy from active COMBO 747 — each piece has *some* active combo,
  // but no single combo contains both.
  await compose(crossM.id, [aoM.id, cv747M.id]);
  // {ÁO x2, CV x1}: SET VÁY roles, but it consumes three physical pieces.
  await compose(aoTwiceM.id, [aoM.id, cvM.id], [2, 1]);
  // A parent {ÁO x2, CV x1, QUẦN x1} is not the 3-piece COMBO, so its {ÁO, CV} sibling is no SET.
  await compose(combo999M.id, [ao999M.id, cv999M.id, quan999M.id], [2, 1, 1]);
  await compose(setVay999M.id, [ao999M.id, cv999M.id]);

  return { combo555M, aoM, cvM, quanM, setVayM, setQuanM, cvOnlyM, crossM, aoTwiceM, setVay999M };
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
  assert.ok(!optionIds.includes(catalog.aoTwiceM.id), "{ÁO x2, CV x1} is not the 2-piece SET VÁY");
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

  const combo999 = await createStorefrontProductDetailRepository(prisma).getProductBySlug({
    shopId,
    slug: "combo-subsets-combo-999",
    now,
  });
  assert.ok(combo999);
  assert.deepEqual(
    combo999.projection.options
      .filter(({ kindKey }) => kindKey?.startsWith("sub-set-"))
      .map(({ id }) => id),
    [],
    "a parent {ÁO x2, CV x1, QUẦN x1} offers no SET",
  );

  for (const variant of [catalog.crossM, catalog.cvOnlyM, catalog.aoTwiceM, catalog.setVay999M]) {
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

function liveVariation(key: string, price: number, stock: number): PancakeCatalogVariation {
  return {
    id: `combo-subsets-${key}`,
    productId: `combo-subsets-live-${key}`,
    displayId: null,
    barcode: `barcode-${key}`,
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice: price,
    retailPriceAfterDiscount: price,
    product: { id: `combo-subsets-live-${key}`, name: `Live ${key}` },
    warehouseStocks: [{ warehouseId: "combo-subsets-live-wh", remainQuantity: stock }],
    sellableStock: stock,
  };
}

/** Real cart mutation → checkout snapshot, leaving a DRAFT ready for the submit boundary. */
async function checkoutDraft(publicCode: string, variantIds: readonly string[]) {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: publicCodePrefix } } });
  await prisma.cart.deleteMany({ where: { id: cartId } });
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date("2026-09-27T00:00:00.000Z") } });
  const cartService = createAnonymousCartService(prisma);
  for (const variantId of variantIds) {
    const added = await cartService.addItemUnit({
      cartId,
      variantId,
      now,
      resolveLine: createCartLineAuthorityResolver({ shopId, now }),
    });
    assert.equal(added.ok, true);
  }
  const snapshot = await createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  }).create({ cartId, shopId, publicCode, checkoutInput, now });
  assert.equal(snapshot.ok, true, snapshot.ok ? undefined : snapshot.reason);
}

async function submitAgainst(publicCode: string, liveCatalog: readonly PancakeCatalogVariation[]) {
  const posted: string[][] = [];
  const result = await createPancakeOrderSubmissionService(
    prisma,
    {
      async fetchCompleteCatalog(requestShopId) {
        assert.equal(requestShopId, shopId);
        return liveCatalog;
      },
      async createOrder(request) {
        posted.push(request.items.map((item) => item.variation_id));
        return { id: 781_001 };
      },
    },
    { now: () => now },
  ).submit({ publicCode, shopId });
  return { result, posted };
}

test("submit validates a SET from its components' live stock, not the parent's own zero row", async () => {
  const catalog = await seedCatalog();
  const code = `${publicCodePrefix}-submit`;

  // Pancake reports 0 on the SET VÁY variation itself while Áo and CV are stocked: the case every
  // inactive sibling SET is in. It must reach the external create call and confirm.
  await checkoutDraft(code, [catalog.setVayM.id]);
  const confirmed = await submitAgainst(code, [
    liveVariation("sv-555-m", 599_000, 0),
    liveVariation("ao-555-m", 429_000, 4),
    liveVariation("cv-555-m", 429_000, 4),
  ]);
  assert.deepEqual(confirmed.result, { ok: true, state: "CONFIRMED", pancakeOrderId: "781001" });
  assert.deepEqual(confirmed.posted, [["combo-subsets-sv-555-m"]]);

  // A sold-out component still stops the SET before any external call, however much the parent's
  // own row claims.
  await checkoutDraft(code, [catalog.setVayM.id]);
  const soldOut = await submitAgainst(code, [
    liveVariation("sv-555-m", 599_000, 50),
    liveVariation("ao-555-m", 429_000, 4),
    liveVariation("cv-555-m", 429_000, 0),
  ]);
  assert.deepEqual(soldOut.result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.deepEqual(soldOut.posted, []);

  // A component missing from the live catalog is not capacity either.
  await checkoutDraft(code, [catalog.setVayM.id]);
  const missing = await submitAgainst(code, [
    liveVariation("sv-555-m", 599_000, 0),
    liveVariation("ao-555-m", 429_000, 4),
  ]);
  assert.deepEqual(missing.result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.deepEqual(missing.posted, []);
});

test("submit sums a SET and a single piece that consume the same live component", async () => {
  const catalog = await seedCatalog();
  const code = `${publicCodePrefix}-shared`;
  const liveWithAo = (aoStock: number) => [
    liveVariation("sv-555-m", 599_000, 0),
    liveVariation("ao-555-m", 429_000, aoStock),
    liveVariation("cv-555-m", 429_000, 4),
  ];

  // SET VÁY (1 Áo + 1 CV) and ÁO LẺ (1 Áo) need two Áo; one on hand passes each line alone.
  await checkoutDraft(code, [catalog.setVayM.id, catalog.aoM.id]);
  const short = await submitAgainst(code, liveWithAo(1));
  assert.deepEqual(short.result, { ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" });
  assert.deepEqual(short.posted, []);

  await checkoutDraft(code, [catalog.setVayM.id, catalog.aoM.id]);
  const enough = await submitAgainst(code, liveWithAo(2));
  assert.equal(enough.result.ok, true);
  assert.equal(enough.posted.length, 1);
});
