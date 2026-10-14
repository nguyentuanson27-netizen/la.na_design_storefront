import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../src/db/prisma.ts";
import { createCartGiftSelectionService } from "../../src/commerce/cart-gift-selection.ts";
import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";

const SHOP = 910_120;
const NOW = new Date("2026-10-14T12:00:00Z");
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" };
const PREFIX = "gq12-";
let cartId: string, paidId: string, giftId: string, secondId: string;
const campaignId = `${PREFIX}gift`;
const service = () => createCartGiftSelectionService(prisma, { get: () => ({ value: cartId }) }, { shopId: SHOP, env: ON });
const choice = (variantId = giftId, quantity = 1, campaignRevision = 1) => ({ campaignId, variantId, quantity, campaignRevision });
async function cleanup() {
  await prisma.variantCapacityReservation.deleteMany({ where: { variant: { product: { pancakeShopId: SHOP } } } });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: PREFIX } } });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId: { startsWith: PREFIX } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.user.deleteMany({ where: { id: `${PREFIX}user` } });
}
test.beforeEach(async () => {
  await cleanup();
  const product = async (suffix: string, stock: number) => prisma.productMirror.create({ data: {
    pancakeShopId: SHOP, pancakeProductId: `${PREFIX}${suffix}`, slug: `${PREFIX}${suffix}`, name: suffix,
    isActive: true, isPresent: true, syncedAt: NOW,
    variants: { create: { pancakeVariationId: `${PREFIX}${suffix}`, color: "White", size: "M", isActive: true, isPresent: true,
      pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000, syncedAt: NOW,
      warehouseStocks: { create: { pancakeWarehouseId: "gq12-wh", quantity: stock, syncedAt: NOW } } } },
  }, include: { variants: true } });
  paidId = (await product("paid", 50)).variants[0].id;
  giftId = (await product("gift", 3)).variants[0].id;
  secondId = (await product("second", 3)).variants[0].id;
  const cart = await prisma.cart.create({ data: { expiresAt: new Date("2027-01-01"), items: { create: { variantId: paidId, quantity: 3 } } } });
  cartId = cart.id;
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, kind: "GIFT_ITEM", name: "Gift",
    isEnabled: true, enabledAt: new Date("2026-01-01"), scopeMode: "GLOBAL_ALL_PAID_LINES",
    giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD",
    maxGiftsPerOrder: 3, allowDuplicateGifts: true, giftOptions: { create: [{ variantId: giftId }, { variantId: secondId }] },
  } });
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());
test("partial/zero choices are explicit, idempotent, separate from paid items and still require acknowledgement", async () => {
  assert.deepEqual(await service().set(choice()), { ok: true });
  assert.deepEqual(await service().set(choice()), { ok: true });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.selections.length, 1);
  assert.equal(state.state.quote.benefits.enabled && state.state.quote.benefits.ok && state.state.quote.benefits.subtotalVnd, 300_000);
  assert.ok(state.state.validation.ok);
  assert.equal(state.state.validation.summaries[0].requiresAcknowledgement, true);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
  assert.deepEqual(await service().set(choice(giftId, 0), NOW), { ok: true });
  assert.deepEqual(await service().set(choice(giftId, 0), NOW), { ok: true });
});
test("foreign cart payload, forged campaign/variant, quantity/cap and wrong revision cannot write", async () => {
  for (const input of [{ ...choice(), cartId: "forged" }, { ...choice(), campaignId: "forged" }, choice(paidId), choice(giftId, 4), choice(giftId, 1, 2)]) {
    assert.equal((await service().set(input, NOW)).ok, false);
  }
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 0);
});
test("expired and user-owned carts are refused and another cookie cannot edit this cart", async () => {
  await prisma.cart.update({ where: { id: cartId }, data: { expiresAt: new Date("2026-01-01") } });
  assert.deepEqual(await service().set(choice(), NOW), { ok: false, reason: "CART_UNAVAILABLE" });
  const other = await prisma.cart.create({ data: { expiresAt: new Date("2027-01-01") } });
  const otherService = createCartGiftSelectionService(prisma, { get: () => ({ value: other.id }) }, { shopId: SHOP, env: ON });
  assert.equal((await otherService.set(choice(), NOW)).ok, false);
  await prisma.cart.delete({ where: { id: other.id } });
});
test("admin revision bump remains stale, reselect requires live revision, disable preserves and allows removal", async () => {
  await service().set(choice(), NOW);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { revision: 2 } });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.selections[0].freshness, "STALE");
  assert.equal(state.state.validation.ok, false);
  assert.equal((await service().set(choice(), NOW)).ok, false);
  assert.deepEqual(await service().set(choice(giftId, 1, 2), NOW), { ok: true });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: 3 } });
  assert.equal((await service().set(choice(giftId, 1, 3), NOW)).ok, false);
  assert.deepEqual(await service().set(choice(giftId, 0), NOW), { ok: true });
});
test("paid demand of the same variant and gift choices share READY stock", async () => {
  await prisma.cartItem.create({ data: { cartId, variantId: giftId, quantity: 2 } });
  assert.equal((await service().set(choice(giftId, 2), NOW)).ok, false);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
});
test("inactive, sold-out and composite options cannot be granted or replaced automatically", async () => {
  await service().set(choice(), NOW);
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.selections[0].variantId, giftId);
  assert.equal(state.state.validation.ok, false);
  assert.equal((await service().set(choice(), NOW)).ok, false);
  await prisma.variantMirror.update({ where: { id: secondId }, data: { isActive: false } });
  assert.equal((await service().set(choice(secondId), NOW)).ok, false);
});
test("concurrent choices serialize the shared entitlement cap", async () => {
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { maxGiftsPerOrder: 1 } });
  const results = await Promise.all([service().set(choice(), NOW), service().set(choice(secondId), NOW)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 1);
});
test("paid mutation invalidates prior entitlement without silently deleting the selection", async () => {
  await service().set(choice(giftId, 3), NOW);
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.entitlements[0].entitled, 1);
  assert.equal(state.state.selections[0].quantity, 3);
  assert.equal(state.state.validation.ok, false);
});
test("a user-owned cart is never authorized by an anonymous cookie", async () => {
  await prisma.user.create({ data: { id: `${PREFIX}user`, name: "Test", email: "gq12@example.test", emailVerified: false, createdAt: NOW, updatedAt: NOW } });
  await prisma.cart.update({ where: { id: cartId }, data: { userId: `${PREFIX}user` } });
  assert.deepEqual(await service().set(choice(), NOW), { ok: false, reason: "CART_UNAVAILABLE" });
});
test("active reservation holds consume gift stock; a released hold does not", async () => {
  const order = await prisma.orderMirror.create({ data: { publicCode: `${PREFIX}hold` } });
  const hold = await prisma.variantCapacityReservation.create({ data: { orderId: order.id, variantId: giftId, quantity: 3,
    resources: { create: { variantId: giftId, quantity: 3 } } } });
  assert.equal((await service().set(choice(), NOW)).ok, false);
  await prisma.variantCapacityReservation.update({ where: { id: hold.id }, data: { state: "RELEASED", releasedAt: NOW } });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
});
test("composite gifts are excluded; paid composite components consume gift capacity", async () => {
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: secondId, componentVariantId: giftId, quantity: 1, syncedAt: NOW } });
  assert.equal((await service().set(choice(secondId), NOW)).ok, false);
  await prisma.compositeComponentMirror.deleteMany({ where: { parentVariantId: secondId } });
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: paidId, componentVariantId: giftId, quantity: 1, syncedAt: NOW } });
  assert.equal((await service().set(choice(), NOW)).ok, false);
});
test("racing paid reduction and gift write leaves a recomputed invalid choice or a refusal, never auto-repairs", async () => {
  await Promise.all([
    service().set(choice(giftId, 3), NOW),
    createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW }),
  ]);
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.entitlements[0].entitled, 1);
  if (state.state.selections.length) {
    assert.equal(state.state.selections[0].quantity, 3);
    assert.equal(state.state.validation.ok, false);
  }
});
