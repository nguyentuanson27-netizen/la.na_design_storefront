import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createMerchantOfferRepository } from "../../src/commerce/merchant-offer-repository.ts";
import { buildMerchantParentItems } from "../../src/commerce/merchant-parent-feed.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { createCartLineAuthorityResolver } from "../../src/commerce/cart-line-authority.ts";
import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { issueRenderedQuoteProof, verifyRenderedQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const shopId = 920_976;
const prefix = "pr176-parity";
const now = new Date("2026-10-16T00:00:00Z");
const date = new Date("2026-10-25T00:00:00Z");
const pdp = createStorefrontProductDetailRepository(prisma);

async function cleanup() {
  await prisma.variantCapacityReservation.deleteMany({ where: { variant: { product: { pancakeShopId: shopId } } } });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: prefix } } });
  await prisma.cart.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: { in: [shopId, shopId + 1] } } });
}
test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(() => prisma.$disconnect());

async function seed(key: string, stock: number, policy?: { sellingMode: "PREORDER" | "OVERSELL" | "STANDARD"; negativeStockLimit: number }) {
  const product = await prisma.productMirror.create({ data: {
    pancakeShopId: shopId, pancakeProductId: `${prefix}-${key}`, slug: `${prefix}-${key}`,
    name: key, primaryImageUrl: "https://content.pancake.vn/web-media/1/2/3/parity.jpg",
    isPresent: true, isActive: true, syncedAt: now,
    ...(policy ? { sellingPolicy: { create: policy } } : {}),
  } });
  const variant = await prisma.variantMirror.create({ data: {
    productId: product.id, pancakeVariationId: `${prefix}-${key}-m`, sku: `AO-${key}`, size: "M", color: key,
    isPresent: true, isActive: true, syncedAt: now, pancakeRetailPrice: 500_000,
    warehouseStocks: { create: { pancakeWarehouseId: "warehouse", quantity: stock, syncedAt: now } },
    availabilityCycle: { create: { cycleStartDate: now, availabilityDate: date, lastStockNonPositive: true, lastPreorder: true } },
  } });
  return { product, variant };
}

const cases = [
  { name: "mirror five is backorder when a component has zero", mirror: 5, a: 0, b: 5, multiplier: 1, floor: -20, ready: 0, reservable: 20, availability: "backorder" },
  { name: "multiplier two exhausts the last unit of headroom", mirror: 0, a: 0, b: 5, multiplier: 2, floor: -1, ready: 0, reservable: 0, availability: "out_of_stock" },
  { name: "negative parent mirror does not consume component stock", mirror: -20, a: 4, b: 5, multiplier: 2, floor: -20, ready: 2, reservable: 12, availability: "in_stock" },
  { name: "zero parent mirror does not hide available components", mirror: 0, a: 4, b: 5, multiplier: 2, floor: -20, ready: 2, reservable: 12, availability: "in_stock" },
  { name: "component at floor is verified sold out", mirror: 5, a: -20, b: 5, multiplier: 1, floor: -20, ready: 0, reservable: 0, availability: "out_of_stock" },
  { name: "component holds remove ready units", mirror: 5, a: 2, b: 5, held: 2, multiplier: 1, floor: -20, ready: 0, reservable: 20, availability: "backorder" },
  { name: "holds exhaust capacity at the negative floor", mirror: 5, a: 0, b: 5, held: 1, multiplier: 1, floor: -1, ready: 0, reservable: 0, availability: "out_of_stock" },
  { name: "unhanded committed resources still hold", mirror: 5, a: 2, b: 5, held: 2, state: "COMMITTED", multiplier: 1, floor: -20, ready: 0, reservable: 20, availability: "backorder" },
  { name: "handed-off committed resources do not hold twice", mirror: 0, a: 2, b: 5, held: 2, state: "COMMITTED", mirrored: true, multiplier: 1, floor: -20, ready: 2, reservable: 22, availability: "in_stock" },
  { name: "released resources do not hold", mirror: 0, a: 2, b: 5, held: 2, state: "RELEASED", multiplier: 1, floor: -20, ready: 2, reservable: 22, availability: "in_stock" },
  { name: "absent component remains unverifiable", mirror: 5, a: 2, b: 5, invalid: "absent", multiplier: 1, floor: -20, ready: 0, reservable: 0, availability: null },
  { name: "cross-shop component remains unverifiable", mirror: 5, a: 2, b: 5, invalid: "shop", multiplier: 1, floor: -20, ready: 0, reservable: 0, availability: null },
] as const;

for (const fixture of cases) test(`repository → PDP → parent feed: ${fixture.name}`, async () => {
  const parent = await seed("parent", fixture.mirror, { sellingMode: "PREORDER", negativeStockLimit: fixture.floor });
  const a = await seed("a", fixture.a);
  const b = await seed("b", fixture.b);
  await prisma.compositeComponentMirror.createMany({ data: [
    { parentVariantId: parent.variant.id, componentVariantId: a.variant.id, quantity: fixture.multiplier, syncedAt: now },
    { parentVariantId: parent.variant.id, componentVariantId: b.variant.id, quantity: 1, syncedAt: now },
  ] });
  if ("invalid" in fixture) {
    if (fixture.invalid === "absent") await prisma.variantMirror.update({ where: { id: a.variant.id }, data: { isPresent: false } });
    else await prisma.productMirror.update({ where: { id: a.product.id }, data: { pancakeShopId: shopId + 1 } });
  }
  if ("held" in fixture) {
    const order = await prisma.orderMirror.create({ data: { publicCode: `${prefix}-hold` } });
    await prisma.variantCapacityReservation.create({ data: {
      orderId: order.id, variantId: a.variant.id, quantity: fixture.held, state: "state" in fixture ? fixture.state : "UNKNOWN",
      committedAt: "state" in fixture && fixture.state === "COMMITTED" ? new Date(now.getTime() - 2_000) : null,
      releasedAt: "state" in fixture && fixture.state === "RELEASED" ? now : null,
      resources: { create: {
        variantId: a.variant.id, quantity: fixture.held,
        mirroredAt: "mirrored" in fixture ? now : null,
        mirrorObservationStartedAt: "mirrored" in fixture ? new Date(now.getTime() - 1_000) : null,
      } },
    } });
  }
  const candidates = await createMerchantOfferRepository(prisma).readCandidateProducts({ shopId, now });
  const candidate = candidates.find(p => p.pancakeProductId === parent.product.pancakeProductId)!;
  const detail = await pdp.getProductBySlug({ shopId, slug: parent.product.slug, now });
  const option = candidate.projection.options.find(o => o.id === parent.variant.id)!;
  const pdpOption = detail!.projection.options.find(o => o.id === parent.variant.id)!;
  assert.deepEqual(option.availability, pdpOption.availability);
  assert.equal(option.purchasable, fixture.reservable > 0);
  assert.equal(option.isPreorderSale, fixture.availability === "backorder");
  // Both surfaces retain a component-derived snapshot, never a parent mirror approximation.
  const snapshot = detail!.variants.find(v => v.id === parent.variant.id)!.compositeCapacity!;
  assert.equal(snapshot.readyQuantity, fixture.ready);
  assert.equal(snapshot.reservableQuantity, fixture.reservable);
  assert.equal(snapshot.reason, "invalid" in fixture ? "invalid-stock" : fixture.reservable > 0 ? "capacity-available" : "negative-limit-reached");
  const item = buildMerchantParentItems([candidate], "https://la.example.test")[0];
  assert.equal(item?.availability ?? null, fixture.availability);
  assert.equal(item?.availabilityDate ?? null, fixture.availability === "backorder" ? "2026-10-25" : null);
  assert.equal((await prisma.warehouseStock.findFirstOrThrow({ where: { variantId: parent.variant.id } })).quantity, fixture.mirror);
});

test("real PDP merges two component products without borrowing policy; cart and checkout agree", async () => {
  const parent = await seed("parent", 2, { sellingMode: "PREORDER", negativeStockLimit: -20 });
  const standard = await seed("a-standard", 0);
  const preorder = await seed("b-preorder", 0, { sellingMode: "PREORDER", negativeStockLimit: -20 });
  await prisma.compositeComponentMirror.createMany({ data: [standard, preorder].map(c => ({
    parentVariantId: parent.variant.id, componentVariantId: c.variant.id, quantity: 1, syncedAt: now,
  })) });
  for (const reversed of [false, true]) {
    if (reversed) {
      await prisma.productMirror.update({ where: { id: standard.product.id }, data: { name: "z-standard" } });
      await prisma.productMirror.update({ where: { id: preorder.product.id }, data: { name: "a-preorder" } });
    }
    const detail = (await pdp.getProductBySlug({ shopId, slug: parent.product.slug, now }))!;
    const parts = detail.projection.options.filter(o => o.kindKey !== "parent");
    assert.equal(new Set(parts.map(o => o.kindKey)).size, 1);
    assert.equal(parts.find(o => o.id === standard.variant.id)!.purchasable, false);
    const allowed = parts.find(o => o.id === preorder.variant.id)!;
    assert.equal(allowed.purchasable, true);
    assert.equal(allowed.isPreorderSale, true);
    assert.equal(allowed.availability.published && allowed.availability.availabilityDate, "2026-10-25");
  }
  const cart = createAnonymousCartService(prisma);
  const resolveLine = createCartLineAuthorityResolver({ shopId, now, pdpSlug: parent.product.slug });
  const cartId = `${prefix}-cart`;
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date("2026-11-01T00:00:00Z") } });
  const rejected = await cart.addItemUnit({ cartId, variantId: standard.variant.id, now, resolveLine });
  assert.equal(rejected.ok, false);
  const accepted = await cart.addItemUnit({ cartId, variantId: preorder.variant.id, now, resolveLine });
  assert.equal(accepted.ok, true);
  const [line] = await createStorefrontCartRepository(prisma).getLines({ shopId, items: [{ variantId: preorder.variant.id, quantity: 1 }], now });
  assert.equal(line?.available, true);
  assert.equal(line?.isPreorderSale, true);
  const checkout = await createGuestCheckoutSnapshotService(prisma, { checkoutInputValidated: true, verifyRenderedQuote: acceptAnyRenderedQuote }).create({
    shopId, cartId, publicCode: `${prefix}-checkout`, now,
    checkoutInput: { name: "Nguyen Van A", phone: "0901234567", provinceRef: "province-01", districtRef: "district-01", communeRef: "commune-01", detail: "12 Duong A", note: "" },
  });
  assert.equal(checkout.ok, true);
  assert.equal(checkout.ok && checkout.verifiedFulfillmentStateByVariantId?.get(preorder.variant.id), "PREORDER");
});

const compositeProofSecret = "pr215-composite-checkout-proof-secret-at-least-32-characters";

for (const scenario of [
  { name: "PREORDER with no ready component stock", mode: "PREORDER", componentStock: 0, held: false, preorder: true },
  { name: "OVERSELL with no ready component stock", mode: "OVERSELL", componentStock: 0, held: false, preorder: false },
  { name: "PREORDER with the last ready component held by another order", mode: "PREORDER", componentStock: 1, held: true, preorder: true },
  { name: "PREORDER retry with its own last ready component held", mode: "PREORDER", componentStock: 1, held: false, preorder: false, ownRetry: true },
] as const) test(`composite parent signed checkout and reservation: ${scenario.name}`, async () => {
  const parent = await seed("parent", -20, { sellingMode: scenario.mode, negativeStockLimit: -20 });
  const component = await seed("a", scenario.componentStock);
  const other = await seed("b", 3);
  await prisma.compositeComponentMirror.createMany({ data: [component, other].map((child) => ({
    parentVariantId: parent.variant.id, componentVariantId: child.variant.id, quantity: 1, syncedAt: now,
  })) });

  const capacity = createCapacityReservationRepository(prisma);
  if (scenario.held) {
    const competingOrder = await prisma.orderMirror.create({ data: { publicCode: `${prefix}-competing-order` } });
    const held = await capacity.reserveOrderCapacity({
      orderId: competingOrder.id, lines: [{ variantId: component.variant.id, quantity: 1 }],
    });
    assert.equal(held.ok, true, "test fixture must really reserve the component");
  }

  const detail = await pdp.getProductBySlug({ shopId, slug: parent.product.slug, now });
  const option = detail!.projection.options.find((item) => item.id === parent.variant.id)!;
  assert.equal(option.purchasable, true);
  assert.equal(option.isPreorderSale, scenario.preorder);

  const cartId = `${prefix}-parent-checkout-cart`;
  await prisma.cart.create({ data: { id: cartId, expiresAt: new Date("2026-11-01T00:00:00Z") } });
  const added = await createAnonymousCartService(prisma).addItemUnit({
    cartId, variantId: parent.variant.id, now,
    resolveLine: createCartLineAuthorityResolver({ shopId, now, pdpSlug: parent.product.slug }),
  });
  assert.equal(added.ok, true, "buyer must be able to add the parent combo");

  const lines = await createStorefrontCartRepository(prisma).getLines({
    shopId, items: [{ variantId: parent.variant.id, quantity: 1 }], now,
  });
  assert.equal(lines[0]?.available, true);
  assert.equal(lines[0]?.isPreorderSale, scenario.preorder);
  const quote = buildRenderedCheckoutQuoteFacts(lines);
  assert.ok(quote, "buyer must receive a valid composite quote");
  const proof = issueRenderedQuoteProof({ quote, cartId, secret: compositeProofSecret });
  assert.ok(proof, "buyer must receive a real signed quote proof");

  const checkoutInput = {
    name: "Nguyen Van A", phone: "0901234567", provinceRef: "province-01",
    districtRef: "district-01", communeRef: "commune-01", detail: "12 Duong A", note: "",
  };
  const snapshotService = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: (currentQuote) => verifyRenderedQuoteProof({
      proof, cartId, currentQuote, secret: compositeProofSecret,
    }),
  });
  const checkout = await snapshotService.create({
    shopId, cartId, publicCode: `${prefix}-parent-checkout-order`, now, checkoutInput,
  });
  assert.equal(checkout.ok, true, checkout.ok ? "" : checkout.reason);
  if (!checkout.ok) return;
  const expectedFulfillmentState = scenario.preorder ? "PREORDER" : "READY";
  assert.equal(checkout.verifiedFulfillmentStateByVariantId.get(parent.variant.id), expectedFulfillmentState);

  const reserved = await capacity.reserveOrderCapacity({
    orderId: checkout.order.id,
    lines: [{ variantId: parent.variant.id, quantity: 1, expectedFulfillmentState }],
  });
  assert.equal(reserved.ok, true, reserved.ok ? "" : reserved.reason);
  if ("ownRetry" in scenario) {
    // A previous pre-write failure may leave the website DRAFT and its READY hold intact.
    // The same signed proof must not be invalidated by subtracting that order's own last unit.
    const retry = await snapshotService.create({
      shopId, cartId, publicCode: `${prefix}-parent-checkout-retry`, now, checkoutInput,
    });
    assert.equal(retry.ok, true, retry.ok ? "" : retry.reason);
    if (retry.ok) {
      assert.equal(retry.order.id, checkout.order.id, "the retry must reuse the held DRAFT");
      assert.equal(retry.verifiedFulfillmentStateByVariantId.get(parent.variant.id), "READY");
    }
  }
});

test("composite graph and hold reads stay batched as parent variant count grows", async () => {
  const parent = await seed("parent", 5, { sellingMode: "PREORDER", negativeStockLimit: -20 });
  const a = await seed("a", 0);
  const edge = (id: string) => ({ parentVariantId: id, componentVariantId: a.variant.id, quantity: 2, syncedAt: now });
  await prisma.compositeComponentMirror.create({ data: edge(parent.variant.id) });
  let operations = 0;
  const counted = prisma.$extends({ query: { async $allOperations({ args, query }) {
    operations += 1;
    return query(args);
  } } });
  const repository = createMerchantOfferRepository(counted as unknown as PrismaClient);
  await repository.readCandidateProducts({ shopId, now });
  const single = operations;
  const extraIds = [];
  for (let i = 1; i < 201; i++) {
    const variant = await prisma.variantMirror.create({ data: {
      productId: parent.product.id, pancakeVariationId: `${prefix}-parent-${i}`, size: `SIZE-${i}`, color: "parent",
      isPresent: true, isActive: true, syncedAt: now, pancakeRetailPrice: 500_000,
    } });
    extraIds.push(variant.id);
  }
  await prisma.compositeComponentMirror.createMany({ data: extraIds.map(edge) });
  operations = 0;
  const candidates = await repository.readCandidateProducts({ shopId, now });
  assert.equal(operations, single);
  assert.ok(operations <= 7, `expected <=7 repository operations, got ${operations}`);
  const options = candidates.find(p => p.pancakeProductId === parent.product.pancakeProductId)!.projection.options;
  assert.equal(options.length, 201);
  assert.equal(options.every(o => o.purchasable && o.isPreorderSale), true);
});
