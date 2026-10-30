import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../src/db/prisma.ts";
import { createCartGiftSelectionService, readCartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildCartGiftPickerModel } from "../../src/routes/cart-gift-model.ts";
import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";
import { readBenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";

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
test("selected gift variant image outranks a different trusted product primary", async () => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: giftId }, select: { productId: true },
  });
  const primary = "https://content.pancake.vn/images/1/2/3/gift-green.jpg";
  const variant = "https://content.pancake.vn/images/1/2/3/gift-red.jpg";
  await prisma.productMirror.update({ where: { id: gift.productId }, data: { primaryImageUrl: primary } });
  await prisma.variantMirror.update({ where: { id: giftId }, data: { pancakeImageUrls: [variant] } });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  let result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.labels.find((label) => label.variantId === giftId)?.imageUrl, variant);
  let model = buildCartGiftPickerModel(result.state);
  assert.equal(model.campaigns[0]?.products.find((product) => product.productId === gift.productId)?.imageUrl, variant);
  assert.equal(model.selections[0]?.imageUrl, variant);

  // If the selected variant has no trusted image, retain the product primary fallback.
  await prisma.variantMirror.update({ where: { id: giftId }, data: { pancakeImageUrls: ["https://evil.example/wrong.jpg"] } });
  result = await service().get(NOW);
  assert.ok("state" in result);
  model = buildCartGiftPickerModel(result.state);
  assert.equal(result.state.labels.find((label) => label.variantId === giftId)?.imageUrl, primary);
  assert.equal(model.selections[0]?.imageUrl, primary);
});

test("sibling fallback caps total URL candidates and variant rows even with many invalid photos", async () => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: giftId }, select: { productId: true },
  });
  const valid = "https://content.pancake.vn/images/1/2/3/gift-bounded.jpg";
  const idAt = (i: number) => `${PREFIX}gift-sibling-${String(i).padStart(2, "0")}`;
  await prisma.variantMirror.createMany({
    data: Array.from({ length: 22 }, (_, i) => ({
      productId: gift.productId, pancakeVariationId: idAt(i),
      pancakeImageUrls: i < 5 ? Array.from({ length: 20 }, (__, j) => `https://evil.example/bad-${i}-${j}.jpg`)
        : i === 5 || i === 21 ? [valid] : [],
      isPresent: true, isActive: true, syncedAt: NOW,
      pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000,
    })),
  });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  const imageForGift = async () => {
    const result = await service().get(NOW);
    assert.ok("state" in result);
    return result.state.labels.find((label) => label.variantId === giftId)?.imageUrl ?? null;
  };
  // Five siblings consume all 100 untrusted candidate slots: sibling 6 may not be scanned.
  assert.equal(await imageForGift(), null);
  await prisma.variantMirror.updateMany({
    where: { productId: gift.productId, pancakeVariationId: { in: Array.from({ length: 5 }, (_, i) => idAt(i)) } },
    data: { pancakeImageUrls: [] },
  });
  assert.equal(await imageForGift(), valid, "the in-budget sixth sibling supplies the photo");
  await prisma.variantMirror.updateMany({ where: { productId: gift.productId, pancakeVariationId: idAt(5) }, data: { pancakeImageUrls: [] } });
  assert.equal(await imageForGift(), null, "sibling 22 stays outside the 20-variant query limit");
});
test("gift image skips untrusted product and variant URLs before accepting Pancake photo", async () => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: giftId }, select: { productId: true },
  });
  const image = "https://content.pancake.vn/images/1/2/3/gift-valid.jpg";
  await prisma.productMirror.update({
    where: { id: gift.productId }, data: { primaryImageUrl: "https://evil.example/fake.jpg" },
  });
  await prisma.variantMirror.update({
    where: { id: giftId },
    data: { pancakeImageUrls: ["https://evil.example/first.jpg", image] },
  });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.labels.find((row) => row.variantId === giftId)?.imageUrl, image);
  const model = buildCartGiftPickerModel(result.state);
  assert.equal(model.campaigns[0]?.products.find((product) => product.productId === gift.productId)?.imageUrl, image);
  assert.equal(model.selections[0]?.imageUrl, image);
});

test("gift image falls back to an active sibling variant not offered by the campaign", async () => {
  const gift = await prisma.variantMirror.findUniqueOrThrow({
    where: { id: giftId }, select: { productId: true },
  });
  const image = "https://content.pancake.vn/images/1/2/3/gift-sibling.jpg";
  await prisma.variantMirror.update({
    where: { id: giftId }, data: { pancakeImageUrls: [] },
  });
  await prisma.variantMirror.create({
    data: {
      productId: gift.productId,
      pancakeVariationId: `${PREFIX}gift-sibling`,
      pancakeImageUrls: [image],
      isPresent: true,
      isActive: true,
      syncedAt: NOW,
      pancakeRetailPrice: 100_000,
      pancakeRetailPriceAfterDiscount: 100_000,
    },
  });

  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.labels.find((row) => row.variantId === giftId)?.imageUrl, image);
  const model = buildCartGiftPickerModel(result.state);
  assert.equal(model.campaigns[0]?.products.find((product) => product.productId === gift.productId)?.imageUrl, image);
  assert.equal(model.selections[0]?.imageUrl, image);
});

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
test("paid reduction automatically trims surplus gift units and leaves valid chosen gifts", async () => {
  assert.deepEqual(await service().set(choice(giftId, 3), NOW), { ok: true });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.entitlements[0].entitled, 1);
  assert.equal(result.state.selections[0]?.quantity, 1);
  assert.equal(result.state.validation.ok, true);
  assert.equal(result.state.autoRemovedGiftCount, 2);
  assert.equal((await prisma.cartGiftSelection.findFirstOrThrow({ where: { cartId, campaignId } })).quantity, 1);
  const again = await service().get(NOW);
  assert.ok("state" in again);
  assert.equal(again.state.autoRemovedGiftCount ?? 0, 0, "a read never repeats a completed cleanup");
});

test("falling below an ORDER_SUBTOTAL gift threshold removes the ineligible gift without choosing a replacement", async () => {
  await prisma.giftQuantityCampaign.update({
    where: { id: campaignId },
    data: { minimumSubtotalVnd: 300_000, awardMode: "ONCE" },
  });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 2, now: NOW });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.entitlements[0]?.entitled, 0);
  assert.equal(result.state.validation.ok, true);
  assert.deepEqual(result.state.selections, []);
  assert.equal(result.state.autoRemovedGiftCount, 1);
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 0);
});

test("falling below a QUANTITY gift threshold removes the gift and checkout can quote the paid cart", async () => {
  await prisma.giftQuantityCampaign.update({
    where: { id: campaignId },
    data: { giftTrigger: "QUANTITY", minimumQuantity: 3, minimumSubtotalVnd: null, subtotalScope: null, awardMode: null },
  });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 2, now: NOW });
  const render = await renderCheckout();
  assert.equal(render.kind, "LEGACY");
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 0);
});

test("when entitlement drops from two gifts to one, the earliest saved gift stays", async () => {
  assert.deepEqual(await service().set(choice(secondId), NOW), { ok: true });
  assert.deepEqual(await service().set(choice(giftId), NOW), { ok: true });
  await prisma.cartGiftSelection.updateMany({
    where: { cartId, variantId: secondId },
    data: { createdAt: new Date("2026-10-12T00:00:00Z") },
  });
  await prisma.cartGiftSelection.updateMany({
    where: { cartId, variantId: giftId },
    data: { createdAt: new Date("2026-10-13T00:00:00Z") },
  });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.autoRemovedGiftCount, 1);
  assert.equal(result.state.validation.ok, true);
  assert.deepEqual(result.state.selections.map((line) => line.variantId), [secondId]);
  assert.deepEqual((await prisma.cartGiftSelection.findMany({ where: { cartId }, select: { variantId: true } })).map((row) => row.variantId), [secondId]);
});

test("an expired or revised campaign does not silently discard an old gift just because the basket shrank", async () => {
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { revision: 2 } });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW });
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.validation.ok, false);
  assert.equal(result.state.autoRemovedGiftCount ?? 0, 0);
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 1);
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
test("gift sets use component stock; paid set demand can deplete the same gift resource", async () => {
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: secondId, componentVariantId: giftId, quantity: 1, syncedAt: NOW } });
  assert.deepEqual(await service().set(choice(secondId), NOW), { ok: true });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.validation.ok, true);
  assert.equal(state.state.campaigns[0]?.options.find((option) => option.variantId === secondId)?.readyAvailable, 3);
  assert.deepEqual(await service().set(choice(secondId, 0), NOW), { ok: true });
  await prisma.compositeComponentMirror.deleteMany({ where: { parentVariantId: secondId } });
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: paidId, componentVariantId: giftId, quantity: 1, syncedAt: NOW } });
  assert.equal((await service().set(choice(), NOW)).ok, false);
});

test("two gift sets with one remaining shared component cannot both be saved", async () => {
  await prisma.warehouseStock.updateMany({ where: { variantId: paidId }, data: { quantity: 4 } });
  await prisma.compositeComponentMirror.createMany({ data: [giftId, secondId].map((parentVariantId) => ({
    parentVariantId, componentVariantId: paidId, quantity: 1, syncedAt: NOW,
  })) });
  const before = await service().get(NOW);
  assert.ok("state" in before);
  assert.equal(before.state.campaigns[0]?.options.find((option) => option.variantId === giftId)?.readyAvailable, 1);
  assert.equal(before.state.campaigns[0]?.options.find((option) => option.variantId === secondId)?.readyAvailable, 1);
  assert.deepEqual(await service().set(choice(giftId), NOW), { ok: true });
  assert.equal((await service().set(choice(secondId), NOW)).ok, false);
  const after = await service().get(NOW);
  assert.ok("state" in after);
  assert.equal(after.state.validation.ok, true);
  assert.deepEqual(after.state.selections.map((selection) => selection.variantId), [giftId]);
});
test("racing paid reduction and gift write converges to an entitled choice or a refusal", async () => {
  await Promise.all([
    service().set(choice(giftId, 3), NOW),
    createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW }),
  ]);
  const result = await service().get(NOW);
  assert.ok("state" in result);
  assert.equal(result.state.entitlements[0].entitled, 1);
  assert.ok(result.state.selections.reduce((sum, line) => sum + line.quantity, 0) <= 1);
  assert.equal(result.state.validation.ok, true);
});
test("earning gift campaigns require mutual stack consent and share the same stock", async () => {
  const otherId = `${PREFIX}other`;
  await prisma.giftQuantityCampaign.create({ data: { id: otherId, kind: "GIFT_ITEM", name: "Other",
    isEnabled: true, enabledAt: NOW, scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL",
    minimumSubtotalVnd: 100_000, subtotalScope: "ALL_PAID_LINES", awardMode: "REPEAT_PER_THRESHOLD", allowDuplicateGifts: true,
    giftOptions: { create: { variantId: giftId } } } });
  assert.equal((await service().set(choice(), NOW)).ok, false);
  let state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.giftStackDropped.length, 2);
  for (const id of [campaignId, otherId]) await prisma.giftQuantityCampaign.update({ where: { id }, data: { stackingEnabled: true, stackPeers: { create: { peerKind: "GIFT_ITEM", peerCampaignId: "*" } } } });
  assert.deepEqual(await service().set(choice(giftId, 2), NOW), { ok: true });
  assert.equal((await service().set({ ...choice(giftId, 2), campaignId: otherId }, NOW)).ok, false);
  assert.deepEqual(await service().set({ ...choice(), campaignId: otherId }, NOW), { ok: true });
  state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.validation.ok, true);
});
const higherMilestone = (id: string, variantIds: readonly string[], minimumSubtotalVnd = 400_000) => prisma.giftQuantityCampaign.create({ data: {
  id, kind: "GIFT_ITEM", name: id, isEnabled: true, enabledAt: NOW, scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL",
  minimumSubtotalVnd, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE", allowDuplicateGifts: true,
  giftOptions: { create: variantIds.map((variantId) => ({ variantId })) } } });
const storedSelections = () => prisma.cartGiftSelection.findMany({ where: { cartId }, select: { campaignId: true, variantId: true }, orderBy: { campaignId: "asc" } });

test("moving up to a higher unstacked milestone retires the earlier gift on the next cart read and does not bring it back", async () => {
  const higherId = `${PREFIX}higher`;
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  await higherMilestone(higherId, [secondId]);
  const cart = createAnonymousCartService(prisma);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  let state = await service().get(NOW);
  assert.ok("state" in state);
  assert.equal(state.state.validation.ok, true, "the lower milestone's gift no longer blocks the cart");
  assert.deepEqual(state.state.selections, []);
  assert.deepEqual(state.state.replacedSelections, [], "the superseded gift is retired, not kept aside");
  assert.deepEqual(await storedSelections(), [], "the higher milestone does not offer this variant, so nothing is carried over");
  const model = buildCartGiftPickerModel(state.state);
  assert.equal(model.stackConflict, false);
  assert.equal(model.invalid, false);
  assert.deepEqual(model.replaced ?? [], []);
  // Back at the lower milestone the retired choice is gone for good.
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 3, now: NOW });
  state = await service().get(NOW);
  assert.ok("state" in state);
  assert.deepEqual(state.state.selections, []);
  assert.equal(state.state.validation.ok, true);
  // Up again, the higher milestone's gift is a plain new choice.
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  assert.equal((await service().set({ ...choice(giftId), campaignId }, NOW)).ok, false, "the replaced milestone cannot take new gifts");
  assert.deepEqual(await service().set({ ...choice(secondId), campaignId: higherId }, NOW), { ok: true });
  assert.deepEqual(await storedSelections(), [{ campaignId: higherId, variantId: secondId }]);
});
test("moving up carries the identical variant to the higher milestone when it is offered, eligible and in stock", async () => {
  const higherId = `${PREFIX}higher`;
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  await higherMilestone(higherId, [giftId, secondId]);
  const cart = createAnonymousCartService(prisma);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.deepEqual(await storedSelections(), [{ campaignId: higherId, variantId: giftId }], "moved, not duplicated");
  assert.deepEqual(state.state.selections.map((row) => [row.campaignId, row.variantId]), [[higherId, giftId]]);
  assert.deepEqual(state.state.replacedSelections, []);
  assert.equal(state.state.validation.ok, true);
  // Dropping back down does not resurrect a lower-milestone row.
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 3, now: NOW });
  assert.deepEqual(await storedSelections(), [{ campaignId: higherId, variantId: giftId }]);
});
test("moving up does not carry a variant that is sold out at the higher milestone", async () => {
  const higherId = `${PREFIX}higher`;
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  await higherMilestone(higherId, [giftId]);
  const cart = createAnonymousCartService(prisma);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  const state = await service().get(NOW);
  assert.ok("state" in state);
  assert.deepEqual(await storedSelections(), []);
  assert.deepEqual(state.state.replacedSelections, []);
});
// Checkout is reached without opening /cart (PDP, drawer, direct link), so it must reconcile exactly as the cart page does.
async function renderCheckout() {
  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: NOW });
  return readBenefitCheckoutRender({ client: prisma, cartId, lines, shopId: SHOP, now: NOW, secret: "x".repeat(32), env: { ...ON, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) } });
}
test("checkout render carries the identical variant to the higher milestone without the cart page being opened", async () => {
  const higherId = `${PREFIX}higher`;
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  await higherMilestone(higherId, [giftId, secondId]);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  const render = await renderCheckout();
  assert.deepEqual(await storedSelections(), [{ campaignId: higherId, variantId: giftId }]);
  const picker = "giftPicker" in render ? render.giftPicker : undefined;
  assert.deepEqual(picker?.selections.map((row) => [row.campaignId, row.variantId]), [[higherId, giftId]]);
  assert.deepEqual(picker?.replaced ?? [], []);
});
test("checkout render retires a gift the higher milestone does not offer, and one that is sold out", async () => {
  const higherId = `${PREFIX}higher`;
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  await higherMilestone(higherId, [secondId]);
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  await renderCheckout();
  assert.deepEqual(await storedSelections(), [], "different variant: retired, not carried");

  await prisma.giftQuantityCampaign.update({ where: { id: higherId }, data: { giftOptions: { create: { variantId: giftId } } } });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 3, now: NOW });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await prisma.warehouseStock.updateMany({ where: { variantId: giftId }, data: { quantity: 0 } });
  await createAnonymousCartService(prisma).setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  await renderCheckout();
  assert.deepEqual(await storedSelections(), [], "sold out at the higher milestone: retired, not carried");
});
test("with two stacking higher milestones, taking a gift from either one swaps out the replaced lower choice in the same write", async () => {
  const [highA, highB] = [`${PREFIX}high-a`, `${PREFIX}high-b`];
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { awardMode: "ONCE" } });
  for (const [id, minimumSubtotalVnd] of [[highA, 300_000], [highB, 400_000]] as const) {
    await prisma.giftQuantityCampaign.create({ data: { id, kind: "GIFT_ITEM", name: id,
      isEnabled: true, enabledAt: NOW, scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL",
      minimumSubtotalVnd, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE", allowDuplicateGifts: true,
      stackingEnabled: true, giftOptions: { create: { variantId: secondId } } } });
  }
  for (const [id, peer] of [[highA, highB], [highB, highA]]) {
    await prisma.giftQuantityCampaign.update({ where: { id }, data: { stackPeers: { create: { peerKind: "GIFT_ITEM", peerCampaignId: peer } } } });
  }
  const cart = createAnonymousCartService(prisma);
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: NOW });
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  await cart.setItemQuantity({ cartId, variantId: paidId, quantity: 4, now: NOW });
  // `get()` retires superseded gifts, so read the stored state directly to exercise `set()`'s swap.
  const state = await prisma.$transaction((tx) => readCartGiftState(tx, cartId, SHOP, NOW, ON));
  assert.deepEqual(state.replacedSelections.map((row) => [row.campaignId, row.replacedByCampaignIds]), [[campaignId, [highA, highB]]]);
  assert.deepEqual(await service().set({ ...choice(secondId), campaignId: highB }, NOW), { ok: true, replaced: 1 });
  assert.deepEqual(await prisma.cartGiftSelection.findMany({ where: { cartId }, select: { campaignId: true } }), [{ campaignId: highB }]);
});
