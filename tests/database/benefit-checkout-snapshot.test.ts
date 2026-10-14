import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { setLegacyPromotionStackConsent } from "../../src/commerce/gift-quantity-legacy-consent.ts";
import { resolveBenefitCheckoutQuote } from "../../src/commerce/benefit-checkout-quote.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import {
  issueBenefitQuoteProof,
  issueNonclaimAcknowledgement,
  verifyBenefitQuoteProof,
  verifyNonclaimAcknowledgement,
  type BenefitQuoteProofFacts,
} from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";
import { readOrderQuoteSnapshot } from "../../src/commerce/order-quote-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * GQ17 / GQ18 against a real database: the checkout DRAFT of a cart with quantity-tier segments and
 * gifts, the proof and the acknowledgement it requires, the hold taken for paid and gift units, and
 * the guarantee that such an order is never sent to the POS by the legacy submission.
 *
 * Fixtures: one paid product (100.001đ, category `vayDam`, 30 in stock) with a FROM_REACHED_THRESHOLD
 * 10% tier from 3 units (Q=3 -> 2 x 100.001đ + 1 x 90.001đ = 290.003đ, EX-17), and one gift product
 * (50.000đ, 5 in stock) offered by a quantity gift campaign (one slot per unit, at most 2).
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 910_170;
const P = "gq17";
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const secret = "gq17-server-secret-at-least-32-characters-long";
const checkoutInput = {
  name: "Nguyễn Văn A", phone: "0901234567", provinceRef: "province-01", districtRef: "district-001", communeRef: "commune-0001", detail: "12 Đường A", note: null,
};

let paid = { productId: "", variantId: "", variationId: "" };
let giftItem = { productId: "", variantId: "", variationId: "" };
let cartId = "";
let publicCodeCounter = 0;

async function cleanup() {
  await prisma.orderMirror.updateMany({ where: { publicCode: { startsWith: P } }, data: { state: "DRAFT" } });
  await prisma.$transaction(async (tx) => {
    const snapshots = await tx.orderQuoteSnapshot.findMany({ where: { order: { publicCode: { startsWith: P } } }, select: { id: true } });
    const ids = snapshots.map((snapshot) => snapshot.id);
    await tx.orderQuoteDiscountStep.deleteMany({ where: { line: { snapshotId: { in: ids } } } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: { in: ids } } });
    await tx.orderQuoteEntitlement.deleteMany({ where: { snapshotId: { in: ids } } });
    await tx.orderQuoteSnapshot.deleteMany({ where: { id: { in: ids } } });
  });
  await prisma.variantCapacityReservation.deleteMany({ where: { order: { publicCode: { startsWith: P } } } });
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: P } } });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId: { startsWith: `${P}-` } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.promotionCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function product(suffix: string, price: number, stock: number, categoryKey: string | null) {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: `GQ17 ${suffix}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: {
        create: {
          pancakeVariationId: `${P}-${suffix}-var`, color: "Black", size: "M", isActive: true, isPresent: true,
          pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
          warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${suffix}`, quantity: stock, syncedAt: PAST } },
        },
      },
    },
    include: { variants: true },
  });
  if (categoryKey !== null) await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey } });
  return { productId: created.id, variantId: created.variants[0]!.id, variationId: created.variants[0]!.pancakeVariationId };
}

async function seed(options: Readonly<{ tier?: boolean; gift?: boolean; quantity?: number; fixedTier?: boolean }> = {}) {
  const { tier = true, gift = true, quantity = 3, fixedTier = false } = options;
  paid = await product("paid", 100_001, 30, "vayDam");
  giftItem = await product("giftitem", 50_000, 5, null);
  cartId = (await prisma.cart.create({
    data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: { variantId: paid.variantId, quantity } } },
  })).id;
  if (tier && fixedTier) {
    // 50.000đ off every unit, stackable on top of a flash sale (used by the EX-21 runtime-price case).
    await prisma.giftQuantityCampaign.create({
      data: {
        id: `${P}-tier`, kind: "QUANTITY_TIER", name: "GQ17 fixed tier", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
        scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "FIXED_AMOUNT_PER_UNIT_VND", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
        stackPriority: 2, stackingEnabled: true, tiers: { create: [{ minQuantity: 1, discountValue: 50_000 }] },
        stackPeers: { create: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] },
      },
    });
  } else if (tier) {
    await prisma.giftQuantityCampaign.create({
      data: {
        id: `${P}-tier`, kind: "QUANTITY_TIER", name: "GQ17 tier", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
        scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "FROM_REACHED_THRESHOLD",
        tierSelectionPriority: "CHEAPEST_FIRST", stackPriority: 1, tiers: { create: [{ minQuantity: 3, discountValue: 10 }] },
      },
    });
  }
  if (gift) {
    await prisma.giftQuantityCampaign.create({
      data: {
        id: `${P}-gift`, kind: "GIFT_ITEM", name: "GQ17 gift", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
        scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], giftTrigger: "QUANTITY", minimumQuantity: 1,
        maxGiftsPerOrder: 2, allowDuplicateGifts: true, giftOptions: { create: [{ variantId: giftItem.variantId }] },
      },
    });
  }
}

const chooseGift = (quantity: number) =>
  prisma.cartGiftSelection.upsert({
    where: { cartId_campaignId_variantId: { cartId, campaignId: `${P}-gift`, variantId: giftItem.variantId } },
    create: { cartId, campaignId: `${P}-gift`, variantId: giftItem.variantId, quantity, campaignRevision: 1 },
    update: { quantity },
  });

/** What the checkout render does: resolve the cart's benefit quote through the same derivation the DRAFT step uses. */
async function render(at: Date = NOW) {
  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: at });
  return prisma.$transaction((tx) => resolveBenefitCheckoutQuote({ tx, cartId, shopId: SHOP, now: at, env: ON, lines }));
}

async function renderedFacts(at: Date = NOW): Promise<BenefitQuoteProofFacts> {
  const resolution = await render(at);
  assert.equal(resolution.kind, "BENEFIT");
  if (resolution.kind !== "BENEFIT") throw new Error("unreachable");
  return resolution.facts;
}

function snapshotService(options: Readonly<{ proof?: unknown; acknowledgement?: unknown; env?: Record<string, string | undefined>; at?: Date; withBenefits?: boolean }> = {}) {
  const { proof, acknowledgement, env = ON, at = NOW, withBenefits = true } = options;
  return createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    env,
    // The legacy verifier must never be consulted for a benefit cart; accepting here would hide a mix-up.
    verifyRenderedQuote: () => ({ ok: true }),
    benefits: withBenefits
      ? {
          verifyBenefitQuote: (currentQuote) => verifyBenefitQuoteProof({ proof, cartId, currentQuote, secret }),
          verifyNonclaimAcknowledgement: (currentQuote) => verifyNonclaimAcknowledgement({ token: acknowledgement, cartId, currentQuote, secret, now: at }),
        }
      : undefined,
  });
}

const code = () => `${P}-order-${process.pid}-${(publicCodeCounter += 1)}`;
const create = (service: ReturnType<typeof snapshotService>, at: Date = NOW) => service.create({ cartId, shopId: SHOP, publicCode: code(), checkoutInput, now: at });
const orderCount = () => prisma.orderMirror.count({ where: { sourceCartId: cartId } });
const holds = () => prisma.variantCapacityReservation.findMany({ where: { order: { sourceCartId: cartId } }, orderBy: { variantId: "asc" }, select: { variantId: true, quantity: true, state: true } });

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// -- GQ17: the DRAFT ----------------------------------------------------------------------------------

test("EX-17: a proven tier cart becomes a DRAFT with both paid segments of one variation, stored by lineId", async () => {
  await seed({ gift: false });
  const facts = await renderedFacts();
  assert.deepEqual(facts.lines.map((line) => [line.lineId, line.quantity, line.unitPriceVnd]), [[`P:${paid.variationId}:0`, 2, 100_001], [`P:${paid.variationId}:1`, 1, 90_001]]);
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;

  const result = await create(snapshotService({ proof }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.order.merchandiseSubtotalVnd, BigInt(290_003));
  assert.equal(result.order.totalVnd, BigInt(290_003) + result.order.shippingFeeVnd);
  assert.equal(result.order.state, "DRAFT");

  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { id: result.order.id }, include: { lines: { orderBy: { unitPriceVnd: "desc" } } } });
  assert.deepEqual(order.lines.map((line) => [line.variantId, line.quantity, line.unitPriceVnd, line.baseUnitPriceVnd]), [
    [paid.variantId, 2, BigInt(100_001), BigInt(100_001)],
    [paid.variantId, 1, BigInt(90_001), BigInt(100_001)],
  ]);
  const stored = (await readOrderQuoteSnapshot(prisma, order.id))!;
  assert.equal(stored.paidSubtotalVnd, 290_003);
  assert.equal(stored.nonclaimAcknowledged, false);
  assert.equal(stored.lines.length, 2);
  assert.equal(stored.lines[1]!.discountSteps[0]!.campaignId, `${P}-tier`);
});

test("EX-18: reservation lines sum the paid segments and the gift of one variation into ONE hold per variant", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  // The gift product is separate here; the same-variation case is covered by the next test.
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    // The legacy POS submission is out of scope; what matters here is the hold taken before it.
    orderSubmission: { submit: async () => ({ ok: false as const, state: "DRAFT" as const, reason: "BENEFIT_SUBMISSION_UNAVAILABLE" as const }) },
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: false, status: "RETRYABLE", reason: "CHECKOUT_UNAVAILABLE", orderCode: (await prisma.orderMirror.findFirstOrThrow({ where: { sourceCartId: cartId } })).publicCode });

  const held = await holds();
  assert.deepEqual(held.map((hold) => [hold.variantId, hold.quantity, hold.state]).sort(), [
    [giftItem.variantId, 2, "RESERVED"],
    [paid.variantId, 3, "RESERVED"], // 2 x 100.001đ + 1 x 90.001đ: three physical pieces, held once
  ].sort());
  assert.equal(held.length, 2, "one reservation row per variant, never one per price segment");
});

test("a gift of a variation that is also bought is held together with the paid units, once", async () => {
  await seed({ tier: false });
  // Offer the paid variation itself as the gift: 3 bought + 2 free = 5 pieces of one variant.
  await prisma.giftOption.deleteMany({ where: { campaignId: `${P}-gift` } });
  await prisma.giftOption.create({ data: { campaignId: `${P}-gift`, variantId: paid.variantId } });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId: `${P}-gift`, variantId: paid.variantId, quantity: 2, campaignRevision: 1 } });
  const facts = await renderedFacts();
  assert.deepEqual(facts.lines.map((line) => line.role).sort(), ["GIFT", "PAID"]);
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;

  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: { submit: async () => ({ ok: false as const, state: "DRAFT" as const, reason: "BENEFIT_SUBMISSION_UNAVAILABLE" as const }) },
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const held = await holds();
  assert.deepEqual(held.map((hold) => [hold.variantId, hold.quantity, hold.state]), [[paid.variantId, 5, "RESERVED"]]);

  // A retry of the same submission neither adds a hold nor a second order.
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(await orderCount(), 1);
  assert.deepEqual((await holds()).map((hold) => hold.quantity), [5]);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 1);
});

test("a gift that cannot be served as READY together with the paid units is refused at the reservation lock, with nothing sent", async () => {
  await seed({ tier: false });
  await prisma.giftOption.deleteMany({ where: { campaignId: `${P}-gift` } });
  await prisma.giftOption.create({ data: { campaignId: `${P}-gift`, variantId: paid.variantId } });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId: `${P}-gift`, variantId: paid.variantId, quantity: 1, campaignRevision: 1 } });
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const calls: string[] = [];
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: { submit: async () => { calls.push("submit"); return { ok: false as const, state: "DRAFT" as const, reason: "BENEFIT_SUBMISSION_UNAVAILABLE" as const }; } },
    generatePublicCode: code,
    // Someone else takes the stock between the quote and the lock: only 3 pieces remain for 3 + 1.
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
  await prisma.warehouseStock.updateMany({ where: { variantId: paid.variantId }, data: { quantity: 3 } });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, "RETRYABLE");
  assert.deepEqual(calls, [], "no external write after a refused hold");
  assert.deepEqual(await holds(), []);
});

// -- GQ16/GQ18: proofs and acknowledgement --------------------------------------------------------------

test("an unproven benefit quote leaves no order, no snapshot and no hold, and returns the quote to show", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;

  // The buyer changes the gift choice after the render: same total, different benefits (EX-13/14).
  await chooseGift(1);
  const result = await create(snapshotService({ proof }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "BENEFIT_QUOTE_UNPROVEN");
  if (result.reason !== "BENEFIT_QUOTE_UNPROVEN") return;
  assert.equal(result.quoteReason, "PRICE_CHANGED");
  assert.equal(result.refreshedBenefitQuote.totalVnd, facts.totalVnd, "the total did not move; the proof still went stale");
  assert.equal(await orderCount(), 0);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 0);
  assert.deepEqual(await holds(), []);
  // The stored choice is exactly what the buyer last made; nothing was swapped.
  assert.equal((await prisma.cartGiftSelection.findFirstOrThrow({ where: { cartId } })).quantity, 1);

  // Missing, forged and another cart's proofs converge on the same outcome.
  for (const bad of [undefined, "", "garbage", `${proof.slice(0, -3)}AAA`]) {
    const refused = await create(snapshotService({ proof: bad }));
    assert.ok(!refused.ok && refused.reason === "BENEFIT_QUOTE_UNPROVEN", String(bad));
  }
});

test("FR-06: slots left unclaimed need a signed acknowledgement of exactly this quote; with it the draft records the non-claim", async () => {
  await seed();
  await chooseGift(1); // 2 slots earned, 1 taken -> 1 left unclaimed
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;

  const missing = await create(snapshotService({ proof }));
  assert.ok(!missing.ok && missing.reason === "NONCLAIM_UNACKNOWLEDGED");
  if (missing.ok || missing.reason !== "NONCLAIM_UNACKNOWLEDGED") return;
  assert.equal(missing.acknowledgementReason, "ACK_MISSING");
  assert.equal(await orderCount(), 0);

  // An acknowledgement of another quote (one more slot taken) does not count.
  await chooseGift(2);
  const otherFacts = await renderedFacts();
  assert.equal(otherFacts.entitlements[0]!.selected, 2);
  await chooseGift(1);
  const wrongAck = issueNonclaimAcknowledgement({ quote: { ...facts, entitlements: [{ ...facts.entitlements[0]!, entitled: 3, skippedWhileAvailable: 2 }] }, cartId, secret, now: NOW })!;
  const stale = await create(snapshotService({ proof, acknowledgement: wrongAck }));
  assert.ok(!stale.ok && stale.reason === "NONCLAIM_UNACKNOWLEDGED");
  if (!stale.ok && stale.reason === "NONCLAIM_UNACKNOWLEDGED") assert.equal(stale.acknowledgementReason, "ACK_STALE");
  assert.equal(await orderCount(), 0);

  const acknowledgement = issueNonclaimAcknowledgement({ quote: facts, cartId, secret, now: NOW })!;
  const ok = await create(snapshotService({ proof, acknowledgement }));
  assert.ok(ok.ok);
  if (!ok.ok) return;
  const stored = (await readOrderQuoteSnapshot(prisma, ok.order.id))!;
  assert.equal(stored.unclaimedSlots, 1);
  assert.equal(stored.nonclaimAcknowledged, true);
  assert.deepEqual(stored.acknowledgedAt, new Date(Math.floor(NOW.getTime() / 1000) * 1000));
  assert.deepEqual(stored.entitlements.map((entry) => [entry.entitled, entry.selected]), [[2, 1]]);
  assert.equal(stored.giftQuantity, 1);

  // The gift is part of the reservation lines but is not a paid line of the order.
  assert.equal(await prisma.orderLineSnapshot.count({ where: { orderId: ok.order.id } }), 2);
  assert.deepEqual([...ok.order.lines].map((line) => [line.variantId === giftItem.variantId ? "gift" : "paid", line.quantity]).sort(), [["gift", 1], ["paid", 1], ["paid", 2]]);
});

test("taking every earned slot needs no acknowledgement; taking none is a full non-claim that does", async () => {
  await seed();
  await chooseGift(2);
  const full = await renderedFacts();
  assert.equal(full.entitlements[0]!.entitled, 2);
  const done = await create(snapshotService({ proof: issueBenefitQuoteProof({ quote: full, cartId, secret })! }));
  assert.ok(done.ok);
  await cleanup();

  await seed();
  const none = await renderedFacts();
  assert.deepEqual(none.lines.map((line) => line.role), ["PAID", "PAID"]);
  assert.equal(none.entitlements[0]!.selected, 0);
  const proof = issueBenefitQuoteProof({ quote: none, cartId, secret })!;
  const refused = await create(snapshotService({ proof }));
  assert.ok(!refused.ok && refused.reason === "NONCLAIM_UNACKNOWLEDGED");
  const accepted = await create(snapshotService({ proof, acknowledgement: issueNonclaimAcknowledgement({ quote: none, cartId, secret, now: NOW })! }));
  assert.ok(accepted.ok);
  if (accepted.ok) assert.equal((await readOrderQuoteSnapshot(prisma, accepted.order.id))!.unclaimedSlots, 2);
});

test("a gift choice that no longer holds is reported, never swapped: nothing is written and the choice is untouched", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  await prisma.warehouseStock.updateMany({ where: { variantId: giftItem.variantId }, data: { quantity: 0 } });

  const result = await create(snapshotService({ proof }));
  assert.deepEqual(result, { ok: false, reason: "GIFT_SELECTION_INVALID" });
  assert.equal(await orderCount(), 0);
  const row = await prisma.cartGiftSelection.findFirstOrThrow({ where: { cartId } });
  assert.deepEqual([row.variantId, row.quantity], [giftItem.variantId, 2]);

  // Through the submit service this is a cart change the buyer resolves in the cart.
  const submit = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: { submit: async () => { throw new Error("must not be reached"); } },
    generatePublicCode: code,
    clock: () => NOW,
  });
  assert.deepEqual(await submit.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW }), { ok: false, status: "RETRYABLE", reason: "CART_CHANGED" });
});

test("a category change that removes the entitlement is reported against the stored gift choice and never swapped", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  // The product leaves the campaign's category: the tier and the gifts stop applying.
  await prisma.productCategoryMembership.deleteMany({ where: { productId: paid.productId } });
  const result = await create(snapshotService({ proof }));
  // The tier and the gift campaign stop applying, so the stored choice no longer validates: it is
  // reported, not repaired, and the order is not created at an unproven price.
  assert.deepEqual(result, { ok: false, reason: "GIFT_SELECTION_INVALID" });
  assert.equal(await orderCount(), 0);
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 1);
});

test("EX-21: when a tier's runtime price becomes invalid the whole tier is dropped, the price recomputed, the buyer must reconfirm, and the reason is kept", async () => {
  await seed({ gift: false, quantity: 3, fixedTier: true });
  // A fixed 50.000đ-per-unit tier is valid on 100.001đ (50.001đ left) ...
  const shown = await renderedFacts();
  assert.deepEqual(shown.lines.map((line) => [line.quantity, line.unitPriceVnd]), [[3, 50_001]]);
  const shownProof = issueBenefitQuoteProof({ quote: shown, cartId, secret })!;

  // ... until a 40.000đ flash sale, which the tier may stack on, starts mid-checkout: 40.000đ - 50.000đ is not a price.
  const later = new Date(NOW.getTime() + 120_000);
  await prisma.promotionCampaign.create({
    data: { id: `${P}-flash`, kind: "FLASH_SALE", name: "GQ17 flash", discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(40_000), startsAt: new Date(NOW.getTime() + 60_000), endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: paid.productId }] } },
  });
  await setLegacyPromotionStackConsent({ campaignId: `${P}-flash`, stackPriority: 1, now: later, session: { user: { id: "admin", role: "ADMIN" }, session: { id: "s" } }, client: prisma, env: ON });

  const refused = await create(snapshotService({ proof: shownProof, at: later }), later);
  assert.ok(!refused.ok && refused.reason === "BENEFIT_QUOTE_UNPROVEN");
  if (refused.ok || refused.reason !== "BENEFIT_QUOTE_UNPROVEN") return;
  assert.deepEqual(refused.refreshedBenefitQuote.lines.map((line) => [line.quantity, line.unitPriceVnd, line.discountSteps.map((step) => step.source)]), [[3, 40_000, ["LEGACY"]]]);
  assert.equal(refused.refreshedBenefitQuote.paidSubtotalVnd, 120_000, "recomputed without the tier, never the shown 150.003đ");
  assert.equal(await orderCount(), 0);

  // The buyer reconfirms the new quote; the order carries it and remembers why the tier is absent.
  const freshProof = issueBenefitQuoteProof({ quote: refused.refreshedBenefitQuote, cartId, secret })!;
  const accepted = await create(snapshotService({ proof: freshProof, at: later }), later);
  assert.ok(accepted.ok);
  if (!accepted.ok) return;
  assert.equal(accepted.order.merchandiseSubtotalVnd, BigInt(120_000));
  const stored = (await readOrderQuoteSnapshot(prisma, accepted.order.id))!;
  assert.deepEqual(stored.droppedBenefits, [{ campaignId: `${P}-tier`, reason: "TIER_PRICE_INVALID", otherCampaignId: null }]);
  assert.equal(stored.lines.some((line) => line.discountSteps.some((step) => step.source === "QUANTITY_TIER")), false);
});

// -- GQ18: idempotency and the state gate -----------------------------------------------------------------

test("a DRAFT retry with the same proof is idempotent: one order, one set of quote rows, same public code", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const first = await create(snapshotService({ proof }));
  const second = await create(snapshotService({ proof }));
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(second.order.publicCode, first.order.publicCode);
  assert.equal(await orderCount(), 1);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 1);
  assert.equal(await prisma.orderQuoteLine.count({ where: { snapshot: { order: { sourceCartId: cartId } } } }), 2);
  assert.equal(await prisma.orderLineSnapshot.count({ where: { orderId: first.order.id } }), 2);
});

test("once the order has left DRAFT, create() hands it back untouched: no new quote, no new hold, in every later state", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const drafted = await create(snapshotService({ proof }));
  assert.ok(drafted.ok);
  if (!drafted.ok) return;
  const reservation = createCapacityReservationRepository(prisma);
  assert.equal((await reservation.reserveOrderCapacity({ orderId: drafted.order.id, lines: drafted.order.lines })).ok, true);
  const before = { holds: await holds(), quoteRows: await prisma.orderQuoteLine.count(), orderLines: await prisma.orderLineSnapshot.count({ where: { orderId: drafted.order.id } }) };

  for (const state of ["VALIDATING", "POS_SUBMITTING", "SYNC_UNKNOWN", "CONFIRMED"] as const) {
    await prisma.orderMirror.update({ where: { id: drafted.order.id }, data: { state } });
    // Even with a proof that is now stale and a different cart content, the frozen order is returned as is.
    await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 4 } });
    const again = await create(snapshotService({ proof: "stale" }));
    assert.ok(again.ok, state);
    if (!again.ok) return;
    assert.equal(again.order.id, drafted.order.id);
    assert.equal(again.order.state, state);
    assert.equal(again.order.lines.reduce((sum, line) => sum + line.quantity, 0), 3, "the frozen basket, not the cart's new one");
    assert.deepEqual(await holds(), before.holds);
    assert.equal(await prisma.orderQuoteLine.count(), before.quoteRows);
    assert.equal(await prisma.orderLineSnapshot.count({ where: { orderId: drafted.order.id } }), before.orderLines);
    assert.equal(await orderCount(), 1);
    await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 3 } });
  }
});

test("a re-quote of a DRAFT whose cart is no longer a benefit cart removes the stale quote rows", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const drafted = await create(snapshotService({ proof }));
  assert.ok(drafted.ok);
  if (!drafted.ok) return;
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: drafted.order.id } }), 1);

  // Fewer units: Q=2 never reaches the tier, so the cart is plain again. The legacy proof is accepted here on purpose.
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 2 } });
  const plain = await create(snapshotService({ proof: "unused" }));
  assert.ok(plain.ok);
  if (!plain.ok) return;
  assert.equal(plain.order.id, drafted.order.id);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: drafted.order.id } }), 0);
  assert.equal(await prisma.orderQuoteLine.count({ where: { snapshot: { orderId: drafted.order.id } } }), 0);
  assert.equal(plain.order.merchandiseSubtotalVnd, BigInt(200_002));
  assert.equal(plain.order.lines.length, 1);
});

// -- Parity and the gate ----------------------------------------------------------------------------------

test("with the gate OFF the checkout is the legacy one byte for byte: no quote rows, the tier price is not applied, no benefit read", async () => {
  await seed();
  await chooseGift(2);
  const statements: string[] = [];
  const counting = new PrismaClient({ adapter: new PrismaPg({ connectionString }), log: [{ emit: "event", level: "query" }] });
  (counting as unknown as { $on: (event: string, handler: (event: { query: string }) => void) => void }).$on("query", (event) => statements.push(event.query));
  try {
    const service = createGuestCheckoutSnapshotService(counting, { checkoutInputValidated: true, env: {}, verifyRenderedQuote: () => ({ ok: true }) });
    const result = await service.create({ cartId, shopId: SHOP, publicCode: code(), checkoutInput, now: NOW });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.order.merchandiseSubtotalVnd, BigInt(300_003), "3 x 100.001đ: the tier and the gift are not part of a gate-OFF checkout");
    assert.equal(await prisma.orderQuoteSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 0);
    const offending = statements.filter((statement) => /GiftQuantityCampaign|CartGiftSelection|QuantityTier|GiftOption/.test(statement));
    assert.deepEqual(offending, [], "no gift/tier read");
    assert.deepEqual(result.order.lines.map((line) => line.variantId), [paid.variantId]);
  } finally {
    await counting.$disconnect();
  }
});

test("a benefit cart is refused, not silently stripped, by a service that cannot prove benefits", async () => {
  await seed({ gift: false });
  const result = await create(snapshotService({ withBenefits: false }));
  assert.deepEqual(result, { ok: false, reason: "BENEFIT_CHECKOUT_UNAVAILABLE" });
  assert.equal(await orderCount(), 0);
});

// -- GQ18: the POS gate -----------------------------------------------------------------------------------

test("a benefit order is never sent to the POS by the legacy submission: it stays DRAFT, holds untouched, no external call", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const calls: string[] = [];
  const gateway = {
    fetchVariations: async () => { calls.push("fetchVariations"); return []; },
    createOrder: async () => { calls.push("createOrder"); return {}; },
  };
  const events: string[] = [];
  const pos = createPancakeOrderSubmissionService(prisma, gateway, { onEvent: (event) => events.push(event.name) });
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: pos,
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });

  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await prisma.orderMirror.findFirstOrThrow({ where: { sourceCartId: cartId } });
  assert.deepEqual(result, { ok: false, status: "RETRYABLE", reason: "CHECKOUT_UNAVAILABLE", orderCode: order.publicCode });
  assert.deepEqual(calls, [], "not one call to Pancake");
  assert.equal(order.state, "DRAFT");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RESERVED", "RESERVED"], "holds stay expirable RESERVED, not SUBMITTING");
  assert.deepEqual(events, ["pancake_order.benefit_submission_withheld"]);

  // Asking again changes nothing: no second order, no second hold, still DRAFT.
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(await orderCount(), 1);
  assert.equal((await holds()).length, 2);
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).state, "DRAFT");
});
