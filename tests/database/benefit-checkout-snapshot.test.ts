import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { setLegacyPromotionStackConsent } from "../../src/commerce/gift-quantity-legacy-consent.ts";
import { resolveBenefitCheckoutQuote } from "../../src/commerce/benefit-checkout-quote.ts";
import { readBenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { readCartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { buildCartViewModel } from "../../src/routes/cart-model.ts";
import type { BenefitQuoteSummary } from "../../src/commerce/benefit-quote-summary.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import {
  issueBenefitQuoteProof,
  benefitQuoteDigest,
  issueNonclaimAcknowledgement,
  verifyBenefitQuoteProof,
  verifyNonclaimAcknowledgement,
  type BenefitQuoteProofFacts,
} from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";
import { readOrderQuoteSnapshot } from "../../src/commerce/order-quote-snapshot.ts";
import { createPancakeOrderSubmissionService, type PancakeOrderSubmissionEvent } from "../../src/commerce/pancake-order-submit.ts";
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
  // Test data only: confirmed orders carry immutable history (the I7 preorder snapshot and, since GQ15,
  // frozen quote rows), protected by triggers and RESTRICT keys. Removing it needs the triggers off, and
  // that is done for this one transaction and nothing else.
  const orderIds = (await prisma.orderMirror.findMany({ where: { publicCode: { startsWith: P } }, select: { id: true } })).map((order) => order.id);
  if (orderIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`DELETE FROM "OrderPreorderLineSnapshot" WHERE "snapshotId" IN (SELECT "id" FROM "OrderPreorderSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
      await tx.$executeRaw`DELETE FROM "OrderPreorderSnapshot" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "OrderQuoteDiscountStep" WHERE "lineRowId" IN (SELECT l."id" FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId" WHERE s."orderId" = ANY(${orderIds}))`;
      await tx.$executeRaw`DELETE FROM "OrderQuoteLine" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
      await tx.$executeRaw`DELETE FROM "OrderQuoteEntitlement" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
      await tx.$executeRaw`DELETE FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "CapacityReservationResource" WHERE "reservationId" IN (SELECT "id" FROM "VariantCapacityReservation" WHERE "orderId" = ANY(${orderIds}))`;
      await tx.$executeRaw`DELETE FROM "VariantCapacityReservation" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "OrderLineSnapshot" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "OrderMirror" WHERE "id" = ANY(${orderIds})`;
    });
  }
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId: { startsWith: `${P}-` } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.promotionCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
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

function snapshotService(options: Readonly<{ proof?: unknown; acknowledgement?: unknown; env?: Record<string, string | undefined>; at?: Date; withBenefits?: boolean; onBenefitQuote?: (summary: BenefitQuoteSummary) => void }> = {}) {
  const { proof, acknowledgement, env = ON, at = NOW, withBenefits = true, onBenefitQuote } = options;
  return createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    env,
    // The legacy verifier must never be consulted for a benefit cart; accepting here would hide a mix-up.
    verifyRenderedQuote: () => ({ ok: true }),
    benefits: withBenefits
      ? {
          onBenefitQuote,
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
    orderSubmission: { submit: async () => ({ ok: false as const, state: "DRAFT" as const, reason: "SUBMISSION_BUSY" as const }) },
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: false, status: "PROCESSING", orderCode: (await prisma.orderMirror.findFirstOrThrow({ where: { sourceCartId: cartId } })).publicCode });

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

  // Through the submit service this is a repairable gift change; no order/POS write is allowed.
  const submit = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: { submit: async () => { throw new Error("must not be reached"); } },
    generatePublicCode: code,
    clock: () => NOW,
  });
  assert.deepEqual(await submit.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW }), { ok: false, status: "RETRYABLE", reason: "CART_CHANGED", giftRepairRequired: true });
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

test("a benefit order is never sent to the POS by the legacy submission: it is closed, its holds go back, no external call", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const calls: string[] = [];
  const gateway = {
    fetchVariations: async () => { calls.push("fetchVariations"); return []; },
    createOrder: async () => { calls.push("createOrder"); return {}; },
  };
  const events: string[] = [];
  const pos = createPancakeOrderSubmissionService(prisma, gateway, { onEvent: (event) => events.push(event.name), env: ON });
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
  // A quote-bearing order can never re-enter DRAFT, so "not now" is a closed order, not a parked one.
  assert.equal(order.state, "REJECTED");
  assert.equal(order.syncErrorCode, "BENEFIT_SUBMISSION_UNAVAILABLE");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED", "RELEASED"], "the units go back at once");
  assert.deepEqual(events, ["pancake_order.validation_started", "pancake_order.benefit_submission_withheld"]);

  // Asking again starts a new order from the unchanged cart; it is withheld the same way and never reaches Pancake.
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(await orderCount(), 2);
  assert.deepEqual(calls, []);
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id } })).state, "REJECTED");
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: order.id } }), 1, "the closed order keeps its quote as history");
});

// -- GQ20: the POS submission of a benefit order ------------------------------------------------------------

import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";
import type { PancakeOrderReadBack } from "../../src/integrations/pancake/order-readback.ts";

/** A read-back as a test writes it; the order's own identity defaults to the order that was asked about, status 0 (new). */
type LooseReadBack = Omit<PancakeOrderReadBack, "orderId" | "shopId" | "status"> & Partial<Pick<PancakeOrderReadBack, "orderId" | "shopId" | "status">>;
const identified = (readBack: LooseReadBack, orderId: string, shopId: number = SHOP): PancakeOrderReadBack => ({ orderId, shopId, status: 0, ...readBack });
import { createPancakeOrderReconciliationService } from "../../src/commerce/pancake-order-reconciliation.ts";
import { PancakeHttpError } from "../../src/integrations/pancake/client.ts";

type LiveOverrides = Readonly<Record<string, Partial<Pick<PancakeCatalogVariation, "retailPrice" | "sellableStock">>>>;

/** A Pancake gateway whose live rows mirror the database, with per-variation overrides; records every call. */
function fakePancake(
  overrides: LiveOverrides = {},
  behaviour: Readonly<{
    create?: (request: PancakeCreateOrderRequest) => Promise<unknown>;
    /** What the POS reports for a created order; default echoes the request exactly. `null` removes the capability. */
    readBack?: ((request: PancakeCreateOrderRequest | undefined) => Promise<LooseReadBack>) | null;
  }> = {},
) {
  const calls = { fetch: 0, create: [] as PancakeCreateOrderRequest[], readBack: 0 };
  const gateway = {
    async fetchVariations(_shopId: number, variationIds: readonly string[]) {
      calls.fetch += 1;
      const rows = await prisma.variantMirror.findMany({ where: { pancakeVariationId: { in: [...variationIds] } }, include: { warehouseStocks: true } });
      return rows.map((row): PancakeCatalogVariation => {
        const override = overrides[row.pancakeVariationId] ?? {};
        const stock = row.warehouseStocks.reduce((sum, entry) => sum + entry.quantity, 0);
        const price = override.retailPrice ?? Number(row.pancakeRetailPrice);
        return {
          id: row.pancakeVariationId, productId: "p", displayId: null, barcode: "b", fields: [], imageUrls: [], isHidden: false, isLocked: false,
          retailPrice: price, retailPriceAfterDiscount: price, product: { id: "p", name: "P" }, warehouseStocks: [], sellableStock: override.sellableStock ?? stock,
        };
      });
    },
    async resolveTwoLevelAddressNames() {
      return { provinceName: "Hà Nội", communeName: "Phường Test" };
    },
    async createOrder(request: PancakeCreateOrderRequest) {
      calls.create.push(request);
      return behaviour.create ? behaviour.create(request) : { id: 800_000 + calls.create.length };
    },
    async readOrder(_shopId: number, orderId: string): Promise<PancakeOrderReadBack> {
      calls.readBack += 1;
      const request = calls.create.at(-1);
      if (behaviour.readBack) return identified(await behaviour.readBack(request), orderId);
      return identified({
        lines: (request?.items ?? []).map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
        totalPriceVnd: (request?.items ?? []).reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
      }, orderId);
    },
  };
  if (behaviour.readBack === null) delete (gateway as { readOrder?: unknown }).readOrder;
  return { gateway, calls };
}

function submission(pancake: ReturnType<typeof fakePancake>, proof: unknown, options: Readonly<{ verifiedShops?: readonly number[]; acknowledgement?: unknown; at?: Date }> = {}) {
  const { verifiedShops = [SHOP], acknowledgement, at = NOW } = options;
  const events: string[] = [];
  const rawEvents: PancakeOrderSubmissionEvent[] = [];
  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, {
    lineLevelPricingVerifiedShopIds: verifiedShops,
    env: ON,
    now: () => at,
    onEvent: (event) => { events.push(event.name); rawEvents.push(event); },
    onConfirmed: async () => undefined,
  });
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof, acknowledgement, at }),
    orderSubmission: pos,
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => at,
  });
  return { service, events, rawEvents };
}

const items = (request: PancakeCreateOrderRequest) => request.items.map((item) => [item.variation_id, item.quantity, item.variation_info.retail_price]);
const lastOrder = () => prisma.orderMirror.findFirstOrThrow({ where: { sourceCartId: cartId }, orderBy: { createdAt: "desc" } });

test("GQ20 EX-17: a tier order goes out as the exact paid segments of one variation, 290.003đ, and is confirmed", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake();
  const { service } = submission(pancake, proof);

  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: (await lastOrder()).publicCode });
  assert.equal(pancake.calls.create.length, 1);
  const request = pancake.calls.create[0]!;
  assert.deepEqual(items(request), [[paid.variationId, 2, 100_001], [paid.variationId, 1, 90_001]]);
  assert.equal(request.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0), 290_003);
  const order = await lastOrder();
  assert.equal(order.state, "CONFIRMED");
  assert.equal(order.totalVnd, BigInt(290_003) + order.shippingFeeVnd!);
  assert.deepEqual((await holds()).map((hold) => hold.state), ["COMMITTED"]);
});

test("GQ20 D-08: gifts go out at 1.000đ each and the same amount is taken from the dearest paid units; the vendor total is the website total", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const pancake = fakePancake();
  const { service } = submission(pancake, proof);

  assert.equal((await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  const request = pancake.calls.create[0]!;
  // 2 gifts = 2.000đ taken from the first 100.001đ unit; the other segments are exactly as proven.
  assert.deepEqual(items(request).sort(), [
    [giftItem.variationId, 2, 1000],
    [paid.variationId, 1, 100_001],
    [paid.variationId, 1, 98_001],
    [paid.variationId, 1, 90_001],
  ].sort());
  assert.equal(request.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0), facts.paidSubtotalVnd);
  // The website record is untouched: gifts are 0đ and the paid segments are the proven ones.
  const stored = (await readOrderQuoteSnapshot(prisma, (await lastOrder()).id))!;
  assert.deepEqual(stored.lines.filter((line) => line.role === "GIFT").map((line) => line.unitPriceVnd), [0]);
  assert.deepEqual(stored.lines.filter((line) => line.role === "PAID").map((line) => line.unitPriceVnd).sort((a, b) => a - b), [90_001, 100_001]);
  assert.equal(stored.vendorProjection!.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0), facts.paidSubtotalVnd);
});

test("GQ20: a shop without line-level acceptance never receives a benefit order, and nothing is read from Pancake", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake();
  const { service, events } = submission(pancake, proof, { verifiedShops: [] });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(pancake.calls.fetch, 0);
  assert.deepEqual(pancake.calls.create, []);
  assert.equal((await lastOrder()).state, "REJECTED");
  assert.ok(events.includes("pancake_order.benefit_submission_withheld"));
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED"]);
});

test("GQ20: a moved Pancake base makes the order re-quote instead of writing a wrong one; the mirror learns the fresh base", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake({ [paid.variationId]: { retailPrice: 110_001 } });
  const { service, events } = submission(pancake, proof);

  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: false, status: "RETRYABLE", reason: "CART_CHANGED", orderCode: (await lastOrder()).publicCode });
  assert.deepEqual(pancake.calls.create, [], "nothing is written to Pancake");
  assert.equal((await lastOrder()).state, "REJECTED");
  assert.ok(events.includes("pancake_order.benefit_requote_required"));
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED"], "nothing was written, so the units go back at once");
  assert.equal((await prisma.variantMirror.findUniqueOrThrow({ where: { id: paid.variantId } })).pancakeRetailPrice, 110_001);

  // The buyer's next view re-quotes from the fresh base; the new proof creates a new order and goes through.
  const fresh = await renderedFacts();
  assert.equal(fresh.lines[0]!.unitPriceVnd, 110_001);
  const retry = submission(fakePancake(), issueBenefitQuoteProof({ quote: fresh, cartId, secret })!);
  assert.equal((await retry.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
});

test("GQ20: a tier or gift campaign that ended or was edited after the quote makes the order re-quote", async () => {
  for (const change of ["tier ended", "gift edited"] as const) {
    await cleanup();
    await seed();
    await chooseGift(2);
    const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
    const pancake = fakePancake();
    const { service } = submission(pancake, proof);
    // The draft exists and holds; the world moves before the POS step. Drive the two halves apart.
    const drafted = await createGuestCheckoutSnapshotLike(proof);
    assert.ok(drafted.ok, change);
    if (change === "tier ended") await prisma.giftQuantityCampaign.update({ where: { id: `${P}-tier` }, data: { isEnabled: false } });
    else await prisma.giftQuantityCampaign.update({ where: { id: `${P}-gift` }, data: { revision: { increment: 1 } } });
    const order = await lastOrder();
    const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, { lineLevelPricingVerifiedShopIds: [SHOP], env: ON, now: () => NOW, onConfirmed: async () => undefined });
    const result = await pos.submit({ publicCode: order.publicCode, shopId: SHOP });
    assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "BENEFIT_REQUOTE_REQUIRED" }, change);
    assert.deepEqual(pancake.calls.create, [], change);
    void service;
  }
});

/** The DRAFT step alone (no reservation, no POS), for tests that move the world between the two. */
async function createGuestCheckoutSnapshotLike(proof: unknown) {
  return create(snapshotService({ proof }));
}

test("GQ20: gift stock is judged as READY stock only, whatever the variant's own selling policy allows", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  // Pancake reports the gift variant at 1 while the order needs 2; an OVERSELL policy would have allowed it.
  await prisma.productSellingPolicy.upsert({
    where: { productId: giftItem.productId },
    create: { productId: giftItem.productId, sellingMode: "OVERSELL", negativeStockLimit: -10 },
    update: { sellingMode: "OVERSELL", negativeStockLimit: -10 },
  });
  const pancake = fakePancake({ [giftItem.variationId]: { sellableStock: 1 } });
  const { service } = submission(pancake, proof);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, []);
  assert.equal((await lastOrder()).state, "REJECTED");
  assert.equal((await lastOrder()).syncErrorCode, "STOCK_UNAVAILABLE");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED", "RELEASED"]);
});

/** Turns the gift into a set of two units of one component, so its stock is the component's (ADR 0016 D-04). */
async function makeGiftASet(componentStock: number) {
  const component = await product("giftpart", 25_000, componentStock, null);
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: giftItem.variantId, componentVariantId: component.variantId, quantity: 2, syncedAt: PAST } });
  return component;
}

test("GQ20 D-04: a set chosen as a gift goes out at 1.000đ per set, its components held and judged as READY stock", async () => {
  await seed();
  const component = await makeGiftASet(10);
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const pancake = fakePancake();
  const { service } = submission(pancake, proof);

  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: (await lastOrder()).publicCode });
  assert.deepEqual(items(pancake.calls.create[0]!).filter(([variationId]) => variationId === giftItem.variationId), [[giftItem.variationId, 2, 1000]]);
  const order = await lastOrder();
  const componentHolds = await prisma.capacityReservationResource.findMany({ where: { reservation: { orderId: order.id }, variantId: component.variantId }, select: { quantity: true } });
  assert.deepEqual(componentHolds.map((hold) => hold.quantity), [4], "two sets hold four component units");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["COMMITTED", "COMMITTED"]);
});

test("GQ20 D-04: a set gift whose components Pancake can no longer cover as READY stock is refused, with nothing sent", async () => {
  await seed();
  const component = await makeGiftASet(10);
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  // Two sets need four component units; Pancake reports three, and an OVERSELL policy on the set must not stretch that.
  await prisma.productSellingPolicy.upsert({
    where: { productId: giftItem.productId },
    create: { productId: giftItem.productId, sellingMode: "OVERSELL", negativeStockLimit: -10 },
    update: { sellingMode: "OVERSELL", negativeStockLimit: -10 },
  });
  const pancake = fakePancake({ [component.variationId]: { sellableStock: 3 } });
  const { service } = submission(pancake, proof);

  assert.equal((await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, false);
  assert.deepEqual(pancake.calls.create, []);
  assert.equal((await lastOrder()).state, "REJECTED");
  assert.equal((await lastOrder()).syncErrorCode, "STOCK_UNAVAILABLE");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED", "RELEASED"]);
});

test("GQ20: a tampered or stale frozen projection is never sent", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  assert.ok((await createGuestCheckoutSnapshotLike(proof)).ok);
  const order = await lastOrder();
  await prisma.orderQuoteSnapshot.update({ where: { orderId: order.id }, data: { vendorProjectionHash: "e".repeat(64) } });
  const pancake = fakePancake();
  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, { lineLevelPricingVerifiedShopIds: [SHOP], env: ON, now: () => NOW, onConfirmed: async () => undefined });
  const result = await pos.submit({ publicCode: order.publicCode, shopId: SHOP });
  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "LOCAL_ORDER_INVALID" });
  assert.deepEqual(pancake.calls.create, []);
});

test("GQ20: an ambiguous create leaves SYNC_UNKNOWN, and asking again sends nothing and holds nothing more", async () => {
  await seed();
  await chooseGift(1);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const acknowledgement = issueNonclaimAcknowledgement({ quote: facts, cartId, secret, now: NOW })!;
  const pancake = fakePancake({}, { create: async () => { throw new Error("socket hang up"); } });
  const { service } = submission(pancake, proof, { acknowledgement });
  const first = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(first, { ok: false, status: "SYNC_UNKNOWN", orderCode: (await lastOrder()).publicCode });
  assert.equal(pancake.calls.create.length, 1);
  const holdsAfter = await holds();
  assert.deepEqual(holdsAfter.map((hold) => hold.state), ["UNKNOWN", "UNKNOWN"]);

  const again = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(again.ok, false);
  assert.equal(pancake.calls.create.length, 1, "no second order and no second gift");
  assert.deepEqual(await holds(), holdsAfter);
  assert.equal(await orderCount(), 1);
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 1);
});

test("GQ20: a definite POS refusal rejects the order and releases the holds; the quote rows stay as history", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake({}, { create: async () => { throw new PancakeHttpError(422, "unprocessable"); } });
  const { service } = submission(pancake, proof);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  const order = await lastOrder();
  assert.equal(order.state, "REJECTED");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["RELEASED"]);
  assert.equal(await prisma.orderQuoteLine.count({ where: { snapshot: { orderId: order.id } } }), 2);
});

// -- GQ21: read-back, reconciliation and recovery of a benefit order ---------------------------------------------

type ReconcilerGateway = Parameters<typeof createPancakeOrderReconciliationService>[0]["gateway"];
const reconciler = (
  loose: Omit<ReconcilerGateway, "readOrder"> & { readOrder?: (shopId: number, orderId: string) => Promise<LooseReadBack> },
  confirmed: string[] = [],
) =>
  createPancakeOrderReconciliationService({
    client: prisma,
    gateway: {
      ...loose,
      readOrder: loose.readOrder ? async (shopId: number, orderId: string) => identified(await loose.readOrder!(shopId, orderId), orderId, shopId) : undefined,
    } as ReconcilerGateway,
    clock: () => NOW,
    absenceConfirmationAttempts: 1,
    absenceConfirmationDelayMs: 0,
    sleep: async () => undefined,
    onConfirmed: async (publicCode) => { confirmed.push(publicCode); },
  });

test("GQ21: a created order is confirmed only after the POS read back exactly the lines that were sent", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake();
  const { service } = submission(pancake, proof);
  assert.equal((await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.equal(pancake.calls.readBack, 1);
  assert.equal((await lastOrder()).state, "CONFIRMED");
  assert.deepEqual((await holds()).map((hold) => hold.state).sort(), ["COMMITTED", "COMMITTED"]);
});

test("GQ21: a POS that merged or re-priced the lines never gets the order CONFIRMED; it stays unknown with its id and its holds", async () => {
  for (const [label, readBack] of [
    ["merged to one price", async () => ({ lines: [{ pancakeVariationId: paid.variationId, quantity: 3, unitPriceVnd: 96_667 }], totalPriceVnd: 290_003 })],
    ["a unit off by 1đ", async (request: PancakeCreateOrderRequest | undefined) => ({ lines: request!.items.map((item, index) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price - (index === 1 ? 1 : 0) })), totalPriceVnd: null })],
    ["total disagrees", async (request: PancakeCreateOrderRequest | undefined) => ({ lines: request!.items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })), totalPriceVnd: 1 })],
  ] as const) {
    await cleanup();
    await seed({ gift: false });
    const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
    const pancake = fakePancake({}, { readBack });
    const { service, events } = submission(pancake, proof);
    const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
    const order = await lastOrder();
    assert.deepEqual(result, { ok: false, status: "SYNC_UNKNOWN", orderCode: order.publicCode }, label);
    assert.equal(order.state, "SYNC_UNKNOWN", label);
    assert.equal(order.syncErrorCode, "RECONCILE_DRIFT", label);
    assert.equal(order.pancakeOrderId, "800001", `${label}: the operator can find the order`);
    assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], label);
    assert.ok(events.includes("pancake_order.benefit_readback_unconfirmed"), label);

    const again = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
    assert.equal(again.ok, false, label);
    assert.equal(pancake.calls.create.length, 1, `${label}: never a second order`);
  }
});

test("GQ21: a read-back that fails or does not exist cannot confirm a benefit order either", async () => {
  for (const [label, readBack] of [["read fails", async () => { throw new Error("timeout"); }], ["unreadable payload", async () => { throw new Error("Order read-back has no readable items array"); }], ["no capability", null]] as const) {
    await cleanup();
    await seed({ gift: false });
    const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
    const pancake = fakePancake({}, { readBack });
    const { service } = submission(pancake, proof);
    assert.equal((await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, false, label);
    const order = await lastOrder();
    assert.deepEqual([order.state, order.syncErrorCode], ["SYNC_UNKNOWN", "READBACK_UNAVAILABLE"], label);
    assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], label);
  }
});

test("GQ21: reconciliation settles a drifted order only once the POS matches; until then nothing is confirmed, released or reported", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake({}, { readBack: async () => ({ lines: [{ pancakeVariationId: paid.variationId, quantity: 3, unitPriceVnd: 96_667 }], totalPriceVnd: 290_001 }) });
  const { service } = submission(pancake, proof);
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await lastOrder();
  assert.equal(order.state, "SYNC_UNKNOWN");

  const confirmed: string[] = [];
  let stored: LooseReadBack = { lines: [{ pancakeVariationId: paid.variationId, quantity: 3, unitPriceVnd: 96_667 }], totalPriceVnd: 290_001 };
  const gateway = {
    searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800001" }),
    readOrder: async () => stored,
  };
  const first = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
  assert.equal(first.ok, false);
  assert.ok(!first.ok && first.reason === "DRIFT");
  assert.equal((await lastOrder()).state, "SYNC_UNKNOWN");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);
  assert.deepEqual(confirmed, []);

  // The operator corrects the order in the POS; the next pass reads back exactly what was sent.
  stored = { lines: pancake.calls.create[0]!.items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })), totalPriceVnd: 290_003 };
  const second = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
  assert.deepEqual(second, { ok: true, state: "CONFIRMED", pancakeOrderId: "800001", reservationsCommitted: 1 });
  const settled = await lastOrder();
  assert.deepEqual([settled.state, settled.syncErrorCode], ["CONFIRMED", null]);
  assert.deepEqual((await holds()).map((hold) => hold.state), ["COMMITTED"]);
  assert.deepEqual(confirmed, [order.publicCode]);
  // The confirmation wrote the immutable preorder snapshot from the SUMMED demand of the segments.
  const preorder = await prisma.orderPreorderSnapshot.findUniqueOrThrow({ where: { orderId: order.id }, include: { lines: true } });
  assert.deepEqual(preorder.lines.map((line) => [line.variantId, line.quantity]), [[paid.variantId, 3]]);
});

test("GQ21: a benefit order whose lines cannot be read back is not settled by the marker alone", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const { service } = submission(fakePancake({}, { create: async () => { throw new Error("socket hang up") } }), proof);
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await lastOrder();
  assert.equal(order.state, "SYNC_UNKNOWN");
  const confirmed: string[] = [];
  for (const gateway of [
    { searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800009" }) },
    { searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800009" }), readOrder: async () => { throw new Error("boom"); } },
  ]) {
    const result = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
    assert.ok(!result.ok && result.reason === "DRIFT");
    assert.equal((await lastOrder()).state, "SYNC_UNKNOWN");
  }
  assert.deepEqual(confirmed, []);
});

test("GQ21: a timeout that never reached the POS is rejected on reconciliation, the holds go back, and the retry orders and reserves once", async () => {
  await seed();
  await chooseGift(2);
  const facts = await renderedFacts();
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const first = fakePancake({}, { create: async () => { throw new Error("ETIMEDOUT"); } });
  const attempt = submission(first, proof);
  assert.equal((await attempt.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, false);
  const unknown = await lastOrder();
  assert.equal(unknown.state, "SYNC_UNKNOWN");
  assert.deepEqual((await holds()).map((hold) => hold.state).sort(), ["UNKNOWN", "UNKNOWN"]);

  // Reconciliation proves the order never existed: rejected, stock released, nothing confirmed.
  const result = await reconciler({ searchOrderByMarker: async () => ({ kind: "ABSENT" as const }) }).reconcileOrder(unknown.publicCode);
  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "ORDER_REJECTED", reservationsReleased: 2 });
  assert.deepEqual((await holds()).map((hold) => hold.state).sort(), ["RELEASED", "RELEASED"]);

  // The buyer asks again. One new order, one new set of holds, one gift: the old order's gift and
  // holds are history, not a second copy.
  const second = fakePancake();
  const retry = submission(second, proof);
  assert.equal((await retry.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.equal(second.calls.create.length, 1);
  const rows = await prisma.variantCapacityReservation.findMany({ where: { order: { sourceCartId: cartId } }, select: { variantId: true, quantity: true, state: true, orderId: true } });
  assert.deepEqual(rows.filter((row) => row.state === "COMMITTED").map((row) => [row.variantId === giftItem.variantId ? "gift" : "paid", row.quantity]).sort(), [["gift", 2], ["paid", 3]]);
  assert.equal(rows.filter((row) => row.orderId === unknown.id && row.state !== "RELEASED").length, 0);
  const giftUnits = await prisma.orderQuoteLine.aggregate({ _sum: { quantity: true }, where: { role: "GIFT", snapshot: { order: { sourceCartId: cartId, state: "CONFIRMED" } } } });
  assert.equal(giftUnits._sum.quantity, 2);
  // Stock accounting: a different cart can still reserve what the rejected order released.
  const other = await createCapacityReservationRepository(prisma).reserveOrderCapacity({ orderId: (await prisma.orderMirror.create({ data: { publicCode: `${P}-other-${process.pid}` } })).id, lines: [{ variantId: giftItem.variantId, quantity: 3 }] });
  assert.equal(other.ok, true);
});

// -- GQ24: telemetry, kill switch and audit traceability --------------------------------------------------------

test("GQ24: the POS events of a benefit order are tagged so confirmed, unknown and rejected can be counted apart", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const ok = submission(fakePancake(), proof);
  assert.equal((await ok.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.deepEqual(ok.rawEvents.filter((event) => event.name !== "pancake_order.validation_started").map((event) => [event.name, "benefit" in event ? event.benefit : undefined]), [
    ["pancake_order.create_started", true],
    ["pancake_order.confirmed", true],
  ]);

  await cleanup();
  await seed({ gift: false });
  const unknown = submission(fakePancake({}, { create: async () => { throw new Error("socket hang up"); } }), issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!);
  await unknown.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.ok(unknown.rawEvents.some((event) => event.name === "pancake_order.create_unknown" && "benefit" in event && event.benefit === true));

  await cleanup();
  await seed({ gift: false });
  const rejected = submission(fakePancake({}, { create: async () => { throw new PancakeHttpError(422, "no"); } }), issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!);
  await rejected.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.ok(rejected.rawEvents.some((event) => event.name === "pancake_order.create_rejected" && "benefit" in event && event.benefit === true));
});

test("GQ24: the quote summary counts entitled, selected and unclaimed slots and carries nothing identifying", async () => {
  await seed();
  await chooseGift(1);
  const facts = await renderedFacts();
  const summaries: BenefitQuoteSummary[] = [];
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const acknowledgement = issueNonclaimAcknowledgement({ quote: facts, cartId, secret, now: NOW })!;
  const drafted = await create(snapshotService({ proof, acknowledgement, onBenefitQuote: (summary) => summaries.push(summary) }));
  assert.ok(drafted.ok);
  assert.equal(summaries.length, 1);
  const summary = summaries[0]!;
  assert.equal(summary.giftLines, 1);
  assert.equal(summary.selectedSlots, 1);
  assert.equal(summary.entitledSlots, 2); // one slot per unit, capped at 2 by the campaign
  assert.equal(summary.unclaimedSlots, 1);
  assert.deepEqual(Object.keys(summary).sort(), [
    "entitledSlots", "giftLines", "paidLines", "selectedSlots", "stackConflicts", "stockShortSlots", "tierConfigInvalid", "tierPriceInvalid", "unclaimedSlots",
  ]);
  assert.ok(Object.values(summary).every((value) => Number.isSafeInteger(value) && value >= 0));
});

test("GQ24: a telemetry observer that throws never changes the checkout", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const drafted = await create(snapshotService({ proof, onBenefitQuote: () => { throw new Error("log sink down"); } }));
  assert.ok(drafted.ok);
});

test("GQ24 kill switch: turning the gate OFF stops new quotes using the new rules, closes an in-flight draft for a re-quote, and leaves a confirmed order and its audit trail untouched", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;

  // An older order, confirmed while the rules were live.
  const live = submission(fakePancake(), proof);
  assert.equal((await live.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  const confirmed = await lastOrder();
  assert.equal(confirmed.state, "CONFIRMED");
  const before = await readOrderQuoteSnapshot(prisma, confirmed.id);
  assert.ok(before);

  // A draft taken while live, then the gate goes OFF before the POS step.
  await cleanup();
  await seed();
  await chooseGift(2);
  const proof2 = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  assert.ok((await create(snapshotService({ proof: proof2 }))).ok);
  const draft = await lastOrder();
  const pancake = fakePancake();
  const off = createPancakeOrderSubmissionService(prisma, pancake.gateway, { lineLevelPricingVerifiedShopIds: [SHOP], env: {}, now: () => NOW, onConfirmed: async () => undefined });
  assert.deepEqual(await off.submit({ publicCode: draft.publicCode, shopId: SHOP }), { ok: false, state: "REJECTED", reason: "BENEFIT_REQUOTE_REQUIRED" });
  assert.deepEqual(pancake.calls.create, []);
  assert.equal((await lastOrder()).state, "REJECTED");
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: draft.id } }), 1, "the quote stays as history");

  // A new quote with the gate OFF is the legacy one: no gift, no tier price, no quote rows.
  const legacyFacts = await resolveBenefitCheckoutQuote({
    tx: prisma as never, cartId, shopId: SHOP, now: NOW, env: {}, lines: [],
  });
  assert.deepEqual(legacyFacts, { kind: "LEGACY", shippingQuote: { baseFeeVnd: 30000, feeVnd: 30000, campaign: null } });
});

test("GQ24 audit: a stored order names the campaign and revision of every gift and tier step it was priced with, after the campaign moves on", async () => {
  await seed();
  await chooseGift(2);
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const live = submission(fakePancake(), proof);
  assert.equal((await live.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  const order = await lastOrder();
  const campaignRevisionBefore = (await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: `${P}-gift` } })).revision;

  // The campaign is edited and disabled afterwards; the order keeps what it was priced with.
  await prisma.giftQuantityCampaign.update({ where: { id: `${P}-gift` }, data: { revision: { increment: 1 }, isEnabled: false } });
  const stored = await readOrderQuoteSnapshot(prisma, order.id);
  assert.ok(stored);
  const giftLine = stored.lines.find((line) => line.role === "GIFT");
  assert.deepEqual(giftLine?.campaign, { id: `${P}-gift`, revision: campaignRevisionBefore });
  const tierStep = stored.lines.flatMap((line) => line.discountSteps).find((step) => step.source === "QUANTITY_TIER");
  assert.equal(tierStep?.campaignId, `${P}-tier`);
  assert.match(stored.quoteDigest, /^[0-9a-f]{64}$/);
});

// -- Review round on PR #165 --------------------------------------------------------------------------------------

/** The full submit path (DRAFT, hold, POS) with a hook that lets the world move between the hold and the POS step. */
function submissionWithDrift(pancake: ReturnType<typeof fakePancake>, proof: unknown, drift: () => Promise<void>, options: Readonly<{ env?: Record<string, string | undefined>; acknowledgement?: unknown }> = {}) {
  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, {
    lineLevelPricingVerifiedShopIds: [SHOP],
    env: options.env ?? ON,
    now: () => NOW,
    onConfirmed: async () => undefined,
  });
  return createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof, acknowledgement: options.acknowledgement }),
    orderSubmission: { submit: async (input) => { await drift(); return pos.submit(input); } },
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
}

test("review P1: a recorded remote id is never released by an empty marker search; it is verified by that id", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake({}, { readBack: () => { throw new Error("read-back timed out"); } });
  const { service } = submission(pancake, proof);
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await lastOrder();
  assert.deepEqual([order.state, order.pancakeOrderId, order.syncErrorCode], ["SYNC_UNKNOWN", "800001", "READBACK_UNAVAILABLE"]);
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);

  // The marker is not indexed yet and the read-back still fails: a created order is known to exist.
  const confirmed: string[] = [];
  for (const readOrder of [async () => { throw new Error("still down"); }, undefined]) {
    const gateway = { searchOrderByMarker: async () => ({ kind: "ABSENT" as const }), ...(readOrder ? { readOrder } : {}) };
    const result = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
    assert.equal(result.ok, false);
    assert.equal((await lastOrder()).state, "SYNC_UNKNOWN");
    assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], "the stock stays held while an order is known to exist");
  }
  // A different cart cannot take that stock meanwhile.
  assert.deepEqual(confirmed, []);

  // Read back by the recorded id and matching exactly, the order is settled although the marker never appears.
  const sent = pancake.calls.create[0]!;
  const gateway = {
    searchOrderByMarker: async () => ({ kind: "ABSENT" as const }),
    readOrder: async () => ({
      lines: sent.items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
      totalPriceVnd: sent.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
    }),
  };
  const settled = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
  assert.deepEqual(settled, { ok: true, state: "CONFIRMED", pancakeOrderId: "800001", reservationsCommitted: 1 });
  assert.deepEqual((await holds()).map((hold) => hold.state), ["COMMITTED"]);
});

test("review P1: scope, entitlement or gift option that changed after the DRAFT stops the order before the POS, and the holds go back", async () => {
  for (const change of ["category scope removed", "gift option withdrawn", "tier scope removed"] as const) {
    await cleanup();
    await seed();
    await chooseGift(2);
    const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
    const pancake = fakePancake();
    const service = submissionWithDrift(pancake, proof, async () => {
      // Direct row changes with the campaign revision untouched: what a catalog sync does to membership.
      if (change === "category scope removed") await prisma.giftQuantityCampaign.update({ where: { id: `${P}-gift` }, data: { categoryKeys: ["other"] } });
      else if (change === "gift option withdrawn") await prisma.giftOption.deleteMany({ where: { campaignId: `${P}-gift` } });
      else await prisma.giftQuantityCampaign.update({ where: { id: `${P}-tier` }, data: { categoryKeys: ["other"] } });
    });
    const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
    assert.equal(result.ok, false, change);
    assert.deepEqual(pancake.calls.create, [], `${change}: nothing is sent`);
    const order = await lastOrder();
    assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "BENEFIT_REQUOTE_REQUIRED"], change);
    assert.ok((await holds()).every((hold) => hold.state === "RELEASED"), `${change}: holds go back`);
    assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: order.id } }), 1, `${change}: the quote is kept as audit`);
  }
});

test("review P1: the kill switch also stops a draft that only records a dropped tier (EX-21); nothing is sent and the holds go back", async () => {
  await seed({ gift: false, quantity: 3, fixedTier: true });
  const shown = await renderedFacts();
  const shownProof = issueBenefitQuoteProof({ quote: shown, cartId, secret })!;
  const later = new Date(NOW.getTime() + 120_000);
  await prisma.promotionCampaign.create({
    data: { id: `${P}-flash`, kind: "FLASH_SALE", name: "GQ17 flash", discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(40_000), startsAt: new Date(NOW.getTime() + 60_000), endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: paid.productId }] } },
  });
  await setLegacyPromotionStackConsent({ campaignId: `${P}-flash`, stackPriority: 1, now: later, session: { user: { id: "admin", role: "ADMIN" }, session: { id: "s" } }, client: prisma, env: ON });
  // The buyer reconfirms the recomputed quote; it now holds only a LEGACY step and a dropped-tier note.
  const refused = await create(snapshotService({ proof: shownProof, at: later }), later);
  assert.ok(!refused.ok && refused.reason === "BENEFIT_QUOTE_UNPROVEN");
  if (refused.ok || refused.reason !== "BENEFIT_QUOTE_UNPROVEN") return;
  const freshProof = issueBenefitQuoteProof({ quote: refused.refreshedBenefitQuote, cartId, secret })!;

  const pancake = fakePancake();
  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, { lineLevelPricingVerifiedShopIds: [SHOP], env: {}, now: () => later, onConfirmed: async () => undefined });
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof: freshProof, at: later }),
    orderSubmission: pos, // the gate is OFF here
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => later,
  });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: later });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, []);
  const order = await lastOrder();
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "BENEFIT_REQUOTE_REQUIRED"]);
  assert.ok((await holds()).every((hold) => hold.state === "RELEASED"));
  const stored = (await readOrderQuoteSnapshot(prisma, order.id))!;
  assert.equal(stored.lines.some((line) => line.role === "GIFT" || line.discountSteps.some((step) => step.source === "QUANTITY_TIER")), false, "the case under test: no live gift or tier step is left");
  assert.equal(stored.droppedBenefits.length, 1);
});

test("review P2: a tier before a legacy sale is a valid stack and is not re-quoted for ever; flash first works too", async () => {
  for (const order of ["tier first", "flash first"] as const) {
    await cleanup();
    await seed({ gift: false, quantity: 1, fixedTier: true });
    await prisma.promotionCampaign.create({
      data: { id: `${P}-flash`, kind: "FLASH_SALE", name: "GQ17 flash", discountType: "PERCENTAGE", percentageValue: 10, startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: paid.productId }] } },
    });
    // The tier stacks at priority 2 in the seed; the flash sale's consent decides which one goes first.
    await setLegacyPromotionStackConsent({ campaignId: `${P}-flash`, stackPriority: order === "tier first" ? 3 : 1, now: NOW, session: { user: { id: "admin", role: "ADMIN" }, session: { id: "s" } }, client: prisma, env: ON });
    const facts = await renderedFacts();
    const line = facts.lines[0]!;
    assert.deepEqual(line.discountSteps.map((step) => step.source), order === "tier first" ? ["QUANTITY_TIER", "LEGACY"] : ["LEGACY", "QUANTITY_TIER"], order);
    const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
    const pancake = fakePancake();
    const { service } = submission(pancake, proof);
    const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
    assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: (await lastOrder()).publicCode }, order);
    assert.equal(pancake.calls.create.length, 1, order);
    assert.equal(pancake.calls.create[0]!.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0), facts.paidSubtotalVnd, order);
  }
});

// -- Second review round on PR #165 -------------------------------------------------------------------------------

test("review2 P1: a READY promise that became PREORDER after the proof stops the order before the POS, and the holds go back", async () => {
  await seed({ gift: false });
  // A PREORDER-policy product: it sells with ready stock, and still sells (as a waiting order) with none.
  await prisma.productSellingPolicy.create({ data: { productId: paid.productId, sellingMode: "PREORDER", negativeStockLimit: -20 } });
  const facts = await renderedFacts();
  assert.ok(facts.lines.every((line) => line.fulfillmentState === "READY"), "the buyer is quoted READY");
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  const pancake = fakePancake();
  const service = submissionWithDrift(pancake, proof, async () => {
    // A stock sync empties the ready stock; selling stays permitted, so a stock-only check would pass.
    await prisma.warehouseStock.updateMany({ where: { variantId: paid.variantId }, data: { quantity: 0 } });
  });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, [], "nothing is sent");
  const order = await lastOrder();
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "BENEFIT_REQUOTE_REQUIRED"]);
  assert.ok((await holds()).every((hold) => hold.state === "RELEASED"));
  const stored = (await readOrderQuoteSnapshot(prisma, order.id))!;
  assert.ok(stored.lines.every((line) => line.fulfillmentState === "READY"), "the original promise is kept as audit");
  // The next view quotes PREORDER honestly.
  assert.ok((await renderedFacts()).lines.every((line) => line.fulfillmentState === "PREORDER"));
});

test("review2 P1: an order total the POS did not report never confirms a benefit order, at create or at reconciliation", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const noTotal = (request: PancakeCreateOrderRequest | undefined) =>
    Promise.resolve<LooseReadBack>({
      lines: (request?.items ?? []).map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
      totalPriceVnd: null,
    });
  const pancake = fakePancake({}, { readBack: noTotal });
  const { service } = submission(pancake, proof);
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await lastOrder();
  assert.deepEqual([order.state, order.pancakeOrderId, order.syncErrorCode], ["SYNC_UNKNOWN", "800001", "READBACK_UNAVAILABLE"]);
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);

  const confirmed: string[] = [];
  const gateway = {
    searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800001" }),
    readOrder: () => noTotal(pancake.calls.create[0]),
  };
  const result = await reconciler(gateway, confirmed).reconcileOrder(order.publicCode);
  assert.ok(!result.ok && result.reason === "DRIFT");
  assert.equal((await lastOrder()).state, "SYNC_UNKNOWN");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);
  assert.deepEqual(confirmed, []);
});

test("review2 P2: a marker search that finds another order id never replaces the recorded one, confirms, or releases", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const pancake = fakePancake({}, { readBack: () => { throw new Error("read-back timed out"); } });
  const { service } = submission(pancake, proof);
  await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  const order = await lastOrder();
  assert.equal(order.pancakeOrderId, "800001");

  const sent = pancake.calls.create[0]!;
  const echo = async () => ({
    lines: sent.items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
    totalPriceVnd: sent.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
  });
  const confirmed: string[] = [];
  // Another order under the same marker whose lines and totals match exactly.
  const result = await reconciler({ searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800002" }), readOrder: echo }, confirmed).reconcileOrder(order.publicCode);
  assert.ok(!result.ok && result.state === "SYNC_UNKNOWN" && result.reason === "AMBIGUOUS");
  const after = await lastOrder();
  assert.deepEqual([after.state, after.pancakeOrderId], ["SYNC_UNKNOWN", "800001"], "the recorded id is untouched");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);
  assert.deepEqual(confirmed, []);

  // The same id from the marker search is the ordinary case and settles on the read-back.
  const settled = await reconciler({ searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800001" }), readOrder: echo }, confirmed).reconcileOrder(order.publicCode);
  assert.deepEqual(settled, { ok: true, state: "CONFIRMED", pancakeOrderId: "800001", reservationsCommitted: 1 });
});

// -- Third review round on PR #165 --------------------------------------------------------------------------------

test("review3 P1: a READY promise is judged against the fresh Pancake stock, not only the mirror", async () => {
  await seed({ gift: false });
  await prisma.productSellingPolicy.create({ data: { productId: paid.productId, sellingMode: "PREORDER", negativeStockLimit: -20 } });
  const facts = await renderedFacts();
  assert.ok(facts.lines.every((line) => line.fulfillmentState === "READY"), "mirrored stock 30: quoted READY");
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;

  // Pancake already reports no ready stock; the mirror has not synced and still says 30. The PREORDER floor
  // (-20) would let the old check pass: 0 - 3 >= -20.
  const stale = fakePancake({ [paid.variationId]: { sellableStock: 0 } });
  const first = submission(stale, proof);
  const result = await first.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(stale.calls.create, [], "nothing is sent");
  const order = await lastOrder();
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "BENEFIT_REQUOTE_REQUIRED"]);
  assert.ok((await holds()).every((hold) => hold.state === "RELEASED"));
  assert.ok((await readOrderQuoteSnapshot(prisma, order.id))!.lines.every((line) => line.fulfillmentState === "READY"), "the signed promise is kept as audit");

  // The same cart with fresh stock that really covers the units is not re-quoted: the order's own hold and
  // the preorder floor do not make a true READY promise look false.
  const healthy = fakePancake();
  const again = submission(healthy, issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!);
  assert.equal((await again.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.equal(healthy.calls.create.length, 1);
});

test("review3 P1: a canceled order, or one that is not the requested order and shop, is never CONFIRMED on a money match", async () => {
  const cases: ReadonlyArray<readonly [string, Partial<Pick<PancakeOrderReadBack, "orderId" | "shopId" | "status">>]> = [
    ["canceled (status 7)", { status: 7 }],
    ["another order id", { orderId: "999" }],
    ["another shop", { shopId: SHOP + 1 }],
    ["no status", { status: null }],
  ];
  for (const [name, wrong] of cases) {
    await cleanup();
    await seed({ gift: false });
    const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
    const exact = (request: PancakeCreateOrderRequest | undefined) =>
      Promise.resolve<LooseReadBack>({
        lines: (request?.items ?? []).map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
        totalPriceVnd: (request?.items ?? []).reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
        ...wrong,
      });
    const pancake = fakePancake({}, { readBack: exact });
    const { service } = submission(pancake, proof);
    await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
    const order = await lastOrder();
    assert.equal(order.state, "SYNC_UNKNOWN", `create read-back: ${name}`);
    assert.equal(order.pancakeOrderId, "800001", name);
    assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], name);

    // The same payload at reconciliation settles nothing either.
    const confirmed: string[] = [];
    const result = await reconciler({ searchOrderByMarker: async () => ({ kind: "FOUND" as const, orderId: "800001" }), readOrder: () => exact(pancake.calls.create[0]) }, confirmed).reconcileOrder(order.publicCode);
    assert.equal(result.ok, false, `reconciliation: ${name}`);
    assert.equal((await lastOrder()).state, "SYNC_UNKNOWN", name);
    assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], name);
    assert.deepEqual(confirmed, [], name);
  }
});

// -- Fourth review round on PR #165 -------------------------------------------------------------------------------

test("review4 P1: a failed local confirmation keeps the remote order id, so an empty marker search cannot release the stock", async () => {
  await seed({ gift: false });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const armed = { value: false };
  // The create succeeds and the read-back matches; the transaction that confirms the order locally then fails.
  const flaky = new Proxy(prisma, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (...args: unknown[]) => {
          if (armed.value) {
            armed.value = false;
            return Promise.reject(new Error("injected: confirmation transaction failed"));
          }
          return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pancake = fakePancake({}, { readBack: async (request) => {
    armed.value = true; // the read-back is the last thing before the confirmation transaction
    return {
      lines: (request?.items ?? []).map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
      totalPriceVnd: (request?.items ?? []).reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
    };
  } });
  const pos = createPancakeOrderSubmissionService(flaky as typeof prisma, pancake.gateway, { lineLevelPricingVerifiedShopIds: [SHOP], env: ON, now: () => NOW, onConfirmed: async () => undefined });
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotService({ proof }),
    orderSubmission: pos,
    generatePublicCode: code,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => NOW,
  });
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(pancake.calls.create.length, 1);
  const order = await lastOrder();
  assert.deepEqual([order.state, order.pancakeOrderId, order.syncErrorCode], ["SYNC_UNKNOWN", "800001", "LOCAL_CONFIRMATION_FAILED"], "the id the POS gave is kept and the code says what failed");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"]);

  // The marker is not indexed yet. Without the id this would reject the order and release stock that is sold.
  const confirmed: string[] = [];
  const absent = await reconciler({ searchOrderByMarker: async () => ({ kind: "ABSENT" as const }), readOrder: async () => { throw new Error("still down"); } }, confirmed).reconcileOrder(order.publicCode);
  assert.equal(absent.ok, false);
  assert.equal((await lastOrder()).state, "SYNC_UNKNOWN");
  assert.deepEqual((await holds()).map((hold) => hold.state), ["UNKNOWN"], "the stock stays held");

  // The recorded id is verified by read-back and the order settles without the marker ever appearing.
  const sent = pancake.calls.create[0]!;
  const settled = await reconciler({
    searchOrderByMarker: async () => ({ kind: "ABSENT" as const }),
    readOrder: async () => ({
      lines: sent.items.map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
      totalPriceVnd: sent.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
    }),
  }, confirmed).reconcileOrder(order.publicCode);
  assert.deepEqual(settled, { ok: true, state: "CONFIRMED", pancakeOrderId: "800001", reservationsCommitted: 1 });
  assert.deepEqual((await holds()).map((hold) => hold.state), ["COMMITTED"]);
});

// -- Fifth review round on PR #165 --------------------------------------------------------------------------------

async function otherOrderHolding(variantId: string, quantity: number, state: "RESERVED" | "COMMITTED") {
  const other = await prisma.orderMirror.create({ data: { publicCode: `${P}-other-${process.pid}-${(publicCodeCounter += 1)}` } });
  const reserved = await createCapacityReservationRepository(prisma).reserveOrderCapacity({ orderId: other.id, lines: [{ variantId, quantity }] });
  assert.equal(reserved.ok, true);
  if (state === "COMMITTED") {
    await prisma.variantCapacityReservation.updateMany({ where: { orderId: other.id }, data: { state: "SUBMITTING" } });
    // Committed well before any stock reading below: Pancake's figure already has it.
    await prisma.variantCapacityReservation.updateMany({ where: { orderId: other.id }, data: { state: "COMMITTED", committedAt: new Date(NOW.getTime() - 10 * 60_000) } });
  }
  return other;
}

test("review5 P1: another order's pending hold counts against the fresh Pancake stock, so two orders that fit alone cannot both be sent", async () => {
  await seed({ gift: false });
  // The mirror says 30. Another order has 27 pending (not in Pancake yet); this order's 3 are held on top.
  await otherOrderHolding(paid.variantId, 27, "RESERVED");
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  // An outside sale takes one unit; the mirror has not synced. 29 - 3 >= 0 passes alone, 29 - 27 - 3 does not.
  const pancake = fakePancake({ [paid.variationId]: { sellableStock: 29 } });
  const service = submissionWithDrift(pancake, proof, async () => undefined);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, [], "nothing is sent");
  const order = await lastOrder();
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "STOCK_UNAVAILABLE"]);
  assert.ok((await holds()).every((hold) => hold.state === "RELEASED"), "this order's units go back");

  // With the stock really there the same order goes through: the check refuses the oversell, not the order.
  const fine = fakePancake({ [paid.variationId]: { sellableStock: 30 } });
  const again = submission(fine, issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!);
  assert.equal((await again.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
});

test("review5 P2: a committed order is already out of Pancake's live stock and is not subtracted from it a second time", async () => {
  await seed({ gift: false });
  await prisma.productSellingPolicy.create({ data: { productId: paid.productId, sellingMode: "PREORDER", negativeStockLimit: -20 } });
  // Mirror 30; another order committed 27 whose handoff to the mirror has not happened. Advisory READY: 30 - 27 = 3.
  await otherOrderHolding(paid.variantId, 27, "COMMITTED");
  const facts = await renderedFacts();
  assert.ok(facts.lines.every((line) => line.fulfillmentState === "READY"), "quoted READY: 3 units are left");
  const proof = issueBenefitQuoteProof({ quote: facts, cartId, secret })!;
  // Pancake already took those 27: live 3. Subtracting the committed 27 again would call this PREORDER (3 - 27 - 3 < 0).
  const pancake = fakePancake({ [paid.variationId]: { sellableStock: 3 } });
  const { service } = submission(pancake, proof);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: (await lastOrder()).publicCode });
  assert.equal(pancake.calls.create.length, 1);

  // And a live stock that really no longer covers the units is still refused as a changed promise.
  await cleanup();
  await seed({ gift: false });
  await prisma.productSellingPolicy.create({ data: { productId: paid.productId, sellingMode: "PREORDER", negativeStockLimit: -20 } });
  await otherOrderHolding(paid.variantId, 27, "COMMITTED");
  const proof2 = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;
  const short = fakePancake({ [paid.variationId]: { sellableStock: 2 } });
  const second = submission(short, proof2);
  assert.equal((await second.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, false);
  assert.deepEqual(short.calls.create, []);
  assert.equal((await lastOrder()).syncErrorCode, "BENEFIT_REQUOTE_REQUIRED");
});

test("review6 P1: a hold that settles between the Pancake reading and the pending-hold read is not lost from both figures", async () => {
  await seed({ gift: false });
  // Another order has 27 SUBMITTING (its write may be in flight); this order's 3 are held on top.
  const other = await otherOrderHolding(paid.variantId, 27, "RESERVED");
  await prisma.variantCapacityReservation.updateMany({ where: { orderId: other.id }, data: { state: "SUBMITTING" } });
  const proof = issueBenefitQuoteProof({ quote: await renderedFacts(), cartId, secret })!;

  // The reading says 28 (an outside sale; the mirror still says 30). Right after it, the other order's create
  // lands and its hold turns COMMITTED -- after the reading began, so the reading does not include it. Real
  // stock is 28 - 27 = 1; sending this order's 3 would oversell.
  const pancake = fakePancake({ [paid.variationId]: { sellableStock: 28 } });
  const read = pancake.gateway.fetchVariations;
  pancake.gateway.fetchVariations = async (shopId: number, ids: readonly string[]) => {
    const rows = await read(shopId, ids);
    await prisma.variantCapacityReservation.updateMany({ where: { orderId: other.id }, data: { state: "COMMITTED", committedAt: NOW } });
    return rows;
  };
  const { service } = submission(pancake, proof);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, [], "nothing is sent: 28 - 27 - 3 < 0 once the settled hold is counted");
  const order = await lastOrder();
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "STOCK_UNAVAILABLE"]);
  assert.ok((await holds()).every((hold) => hold.state === "RELEASED"));
});

// -- Seventh review round on PR #165 ------------------------------------------------------------------------------

test("review7 P1: a legacy order on the same inventory sees the pending holds of benefit orders, so the two flows cannot both be sent", async () => {
  // A plain cart (no tier, no gift): the checkout is the legacy one and the order has no quote.
  await seed({ tier: false, gift: false });
  // Another order -- a benefit order, in the reviewer's scenario -- holds 27 that Pancake does not know about yet.
  await otherOrderHolding(paid.variantId, 27, "RESERVED");
  // An outside sale takes one unit; the mirror has not synced. Without the holds: 29 - 3 >= 0, sent.
  const pancake = fakePancake({ [paid.variationId]: { sellableStock: 29 } });
  const { service } = submission(pancake, undefined);
  const result = await service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(pancake.calls.create, [], "nothing is sent: 29 - 27 - 3 < 0");
  const order = await lastOrder();
  assert.equal(await prisma.orderQuoteSnapshot.count({ where: { orderId: order.id } }), 0, "this really was a legacy order");
  assert.deepEqual([order.state, order.syncErrorCode], ["REJECTED", "STOCK_UNAVAILABLE"]);

  // With the stock really there the legacy order is sent as before.
  const fine = fakePancake({ [paid.variationId]: { sellableStock: 30 } });
  const again = submission(fine, undefined);
  assert.equal((await again.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.equal(fine.calls.create.length, 1);
});

// -- GQ19: the checkout page renders what the submit will prove --------------------------------------------------

const VERIFIED = { ...ON, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) } as const;

async function checkoutRender(env: Record<string, string | undefined> = VERIFIED, at: Date = NOW) {
  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: at });
  return readBenefitCheckoutRender({ client: prisma, cartId, lines, shopId: SHOP, now: at, secret, env });
}

test("GQ19: the proof the checkout page issues is exactly the one the DRAFT step verifies, and the tick is then required", async () => {
  await seed();
  await chooseGift(1); // 2 slots earned at Q=3 (max 2), 1 taken, 1 left unclaimed
  const rendered = await checkoutRender();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") throw new Error("unreachable");
  assert.equal(rendered.needsAcknowledgement, true);
  assert.equal(rendered.digest, benefitQuoteDigest(rendered.facts));
  assert.deepEqual([...rendered.giftLabels.values()], ["GQ17 giftitem — Black / M"]);
  assert.equal(rendered.tierDropped, false);

  // Read-only: rendering writes no order, no quote and no hold.
  assert.equal(await orderCount(), 0);
  assert.deepEqual(await holds(), []);

  // Without the tick the server asks for it -- and says it asks, with the quote it just computed.
  const unticked = await create(snapshotService({ proof: rendered.proof }));
  assert.equal(unticked.ok, false);
  assert.ok(!unticked.ok && unticked.reason === "NONCLAIM_UNACKNOWLEDGED");
  assert.equal(await orderCount(), 0, "no order exists until the buyer has said yes");

  // The tick, minted for the recomputed quote exactly as the runtime does, completes the DRAFT.
  const acknowledgement = issueNonclaimAcknowledgement({ quote: rendered.facts, cartId, secret, now: NOW })!;
  const ticked = await create(snapshotService({ proof: rendered.proof, acknowledgement }));
  assert.equal(ticked.ok, true);
  assert.ok(ticked.ok);
  const stored = (await readOrderQuoteSnapshot(prisma, ticked.order.id))!;
  assert.equal(stored.nonclaimAcknowledged, true);
  assert.equal(stored.quoteDigest, rendered.digest, "the order stores the digest of the quote the page showed");
});

test("GQ19: a quote that moves after the page rendered is not redeemable with the old proof, whatever the tick", async () => {
  await seed();
  await chooseGift(1);
  const rendered = await checkoutRender();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") throw new Error("unreachable");
  // The buyer swaps a gift unit for nothing in another tab: the total is unchanged, the quote is not.
  await chooseGift(2);
  const stale = await create(snapshotService({ proof: rendered.proof, acknowledgement: issueNonclaimAcknowledgement({ quote: rendered.facts, cartId, secret, now: NOW })! }));
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.reason === "BENEFIT_QUOTE_UNPROVEN");
  const refreshed = await checkoutRender();
  assert.ok(refreshed.kind === "BENEFIT" && refreshed.digest !== rendered.digest, "the refreshed page carries a new digest, so its box starts unticked");
});

test("GQ19: gate OFF, or a cart with no benefit, renders ordinary merchandise while independently checking shipping campaigns", async () => {
  await seed();
  await chooseGift(1);
  assert.deepEqual(await checkoutRender({ LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) }), { kind: "LEGACY", shippingQuote: { baseFeeVnd: 30000, feeVnd: 30000, campaign: null } });
  await cleanup();
  await seed({ tier: false, gift: false });
  assert.deepEqual(await checkoutRender(), { kind: "LEGACY", shippingQuote: { baseFeeVnd: 30000, feeVnd: 30000, campaign: null } });
});

test("GQ19: a shop without line-level pricing evidence is not offered a benefit checkout the POS would close", async () => {
  await seed();
  await chooseGift(1);
  assert.deepEqual(await checkoutRender(ON), { kind: "UNAVAILABLE", reason: "POS_NOT_ACCEPTED" });
  assert.deepEqual(await checkoutRender({ ...ON, LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "1,2,3" }), { kind: "UNAVAILABLE", reason: "POS_NOT_ACCEPTED" });
});

test("GQ19: a stored gift choice that no longer holds sends the buyer back; nothing is swapped", async () => {
  await seed();
  await chooseGift(2);
  await prisma.warehouseStock.updateMany({ where: { variantId: giftItem.variantId }, data: { quantity: 0 } });
  const repair = await checkoutRender();
  assert.equal(repair.kind, "UNAVAILABLE");
  assert.equal(repair.kind === "UNAVAILABLE" && repair.reason, "GIFT_SELECTION_INVALID");
  assert.equal(repair.giftPicker?.invalid, true);
  assert.equal(repair.giftPicker?.selections.length, 1);
  assert.equal((await prisma.cartGiftSelection.findFirstOrThrow({ where: { cartId } })).quantity, 2, "the choice is left exactly as the buyer made it");
});

test("GQ19 review: cart and checkout classify a tier-then-ceiling stack alike, even though its total equals the legacy price", async () => {
  // 1 unit at 1.000.000đ. A 10% tier runs first (-> 900.000đ), then a legacy 900.000đ ceiling changes nothing, so the
  // benefit total equals what the legacy resolver charges. The money cannot tell this cart from an ordinary one.
  await seed({ tier: false, gift: false, quantity: 1 });
  await prisma.variantMirror.update({ where: { id: paid.variantId }, data: { pancakeRetailPrice: 1_000_000, pancakeRetailPriceAfterDiscount: 1_000_000 } });
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-tier`, kind: "QUANTITY_TIER", name: "GQ17 10% tier", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      stackPriority: 1, stackingEnabled: true, tiers: { create: [{ minQuantity: 1, discountValue: 10 }] },
      stackPeers: { create: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] },
    },
  });
  await prisma.promotionCampaign.create({
    data: { id: `${P}-ceiling`, kind: "FLASH_SALE", name: "GQ17 ceiling", discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(900_000), startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: paid.productId }] } },
  });
  await setLegacyPromotionStackConsent({ campaignId: `${P}-ceiling`, stackPriority: 2, now: NOW, session: { user: { id: "admin", role: "ADMIN" }, session: { id: "s" } }, client: prisma, env: ON });

  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: NOW });
  const legacyTotal = lines.reduce((sum, line) => sum + (line.price ?? 0) * line.quantity, 0);

  // Checkout's authority: a benefit cart, because a QUANTITY_TIER step was applied.
  const resolution = await render();
  assert.equal(resolution.kind, "BENEFIT");
  if (resolution.kind !== "BENEFIT") return;
  // The ceiling that changes nothing leaves no step; the tier that did the work is on the ledger.
  assert.deepEqual(resolution.facts.lines[0]!.discountSteps.map((step) => step.source), ["QUANTITY_TIER"]);
  assert.equal(resolution.facts.paidSubtotalVnd, legacyTotal, "the same-total stack: money alone cannot distinguish it");

  // The cart's authority must reach the same verdict: no link for a shop the POS has no evidence for.
  const state = await prisma.$transaction((tx) => readCartGiftState(tx, cartId, SHOP, NOW, ON));
  const closed = buildCartViewModel({ lines: state.quote.lines, commerceTrackingEnabled: false, giftState: state });
  assert.equal(closed.canCheckout, false, "the cart must not offer a link the checkout would dead-end");
  const open = buildCartViewModel({ lines: state.quote.lines, commerceTrackingEnabled: false, giftState: state, benefitCheckoutOpen: true });
  assert.equal(open.canCheckout, true);

  // And the two ends agree on that dead end.
  assert.deepEqual(await checkoutRender(ON), { kind: "UNAVAILABLE", reason: "POS_NOT_ACCEPTED" });
  assert.equal((await checkoutRender()).kind, "BENEFIT");
});


test("shipping campaigns stack with a proven tier and selected gifts without counting free units", async () => {
  await seed();
  await chooseGift(2);
  const campaign = await prisma.shippingPromotionCampaign.create({ data: {
    pancakeShopId: SHOP, name: "Scoped shipping", minimumQuantity: 4, priority: 0,
    stackingEnabled: true, categoryKeys: ["vayDam"], isEnabled: true, enabledAt: PAST,
  } });
  // Three paid pieces plus two gifts still fail a four-paid-piece shipping minimum.
  assert.equal((await renderedFacts()).shippingFeeVnd, 30000);
  await prisma.shippingPromotionCampaign.update({ where: { id: campaign.id }, data: { minimumQuantity: 2, revision: { increment: 1 } } });
  const facts = await renderedFacts();
  assert.equal(facts.shippingFeeVnd, 0);
  const pancake = fakePancake();
  const live = submission(pancake, issueBenefitQuoteProof({ quote: facts, cartId, secret })!);
  assert.equal((await live.service.submit({ cartId, shopId: SHOP, checkoutInput, now: NOW })).ok, true);
  assert.equal(pancake.calls.create[0]?.shipping_fee, 0);
  const order = await lastOrder();
  assert.equal(order.shippingPromotionCampaignId, campaign.id);
  assert.equal(order.shippingPromotionRevision, 2);
  assert.equal((await readOrderQuoteSnapshot(prisma, order.id))?.shippingFeeVnd, 0);
});
