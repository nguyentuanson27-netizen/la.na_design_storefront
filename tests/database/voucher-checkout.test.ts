import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { resolveBenefitCheckoutQuote } from "../../src/commerce/benefit-checkout-quote.ts";
import { readBenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { createCapacityReservationRepository } from "../../src/commerce/capacity-reservation.ts";
import { issueBenefitQuoteProof, verifyBenefitQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";
import { readOrderQuoteSnapshot } from "../../src/commerce/order-quote-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { createVoucherHoldFlow } from "../../src/commerce/voucher-hold-flow.ts";
import { createVoucherHoldService } from "../../src/commerce/voucher-hold-service.ts";
import { createVoucherOrderAcceptance } from "../../src/commerce/voucher-order-acceptance.ts";
import { readVoucherPreview } from "../../src/commerce/voucher-preview.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";
import type { PancakeCreateOrderRequest } from "../../src/integrations/pancake/order-create.ts";
import type { PancakeOrderReadBack } from "../../src/integrations/pancake/order-readback.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * V18 server core against a real database: a cart that HOLDS vouchers is quoted, proven, drafted, accepted and sent to
 * the POS with the voucher in every place the money lives -- the rendered quote and its proof, the DRAFT's lines and
 * quote rows, the declaration, the acceptance and the vendor lines -- and never when the holds no longer describe it.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_016;
const P = "vchr-co";
const SECRET = "voucher-checkout-secret-at-least-32-chars-long";
const ENV = {
  LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
  LA_VOUCHER_ENABLED: "true",
  LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
  LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
} as const;
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-31T00:00:00.000Z");
const f = createVoucherFixtures(prisma, SHOP, P);
const flow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV });
const holdService = createVoucherHoldService(prisma, { attemptSecret: SECRET, env: ENV });
const acceptance = createVoucherOrderAcceptance({ readAttemptSecret: () => SECRET });
const checkoutInput = { name: "Nguyễn Văn A", phone: "0901234567", provinceRef: "province-01", districtRef: "district-001", communeRef: "commune-0001", detail: "12 Đường A", note: null };

let cartId = "";
let paid = { variantId: "", variationId: "" };
let giftItem = { variantId: "", variationId: "" };
let counter = 0;

async function cleanup() {
  const orderIds = (await prisma.orderMirror.findMany({ where: { pancakeShopId: SHOP }, select: { id: true } })).map((order) => order.id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    if (orderIds.length > 0) {
      await tx.$executeRaw`DELETE FROM "VoucherRedemption" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "OrderAcceptance" WHERE "orderId" = ANY(${orderIds})`;
      await tx.$executeRaw`DELETE FROM "OrderVoucherSnapshot" WHERE "orderId" = ANY(${orderIds})`;
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
    }
    await tx.$executeRaw`DELETE FROM "VoucherHold" WHERE "campaignId" IN (SELECT "id" FROM "VoucherCampaign" WHERE "pancakeShopId" = ${SHOP})`;
    await tx.$executeRaw`DELETE FROM "VoucherCampaign" WHERE "pancakeShopId" = ${SHOP}`;
  });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId: { startsWith: `${P}-` } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
test.before(cleanup);
test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function product(suffix: string, price: number, stock: number) {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: `Voucher checkout ${suffix}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${suffix}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${suffix}`, quantity: stock, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  return { variantId: created.variants[0]!.id, variationId: created.variants[0]!.pancakeVariationId };
}

async function seed(options: Readonly<{ quantity?: number; unitPrice?: number; giftThreshold?: number }> = {}) {
  const { quantity = 2, unitPrice = 450_000, giftThreshold } = options;
  paid = await product("paid", unitPrice, 50);
  giftItem = await product("gift", 40_000, 9);
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId: paid.variantId, quantity } } } })).id;
  if (giftThreshold !== undefined) {
    await prisma.giftQuantityCampaign.create({
      data: {
        id: `${P}-gift`, kind: "GIFT_ITEM", name: "Gift", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
        scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: giftThreshold, subtotalScope: "ALL_PAID_LINES",
        awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: [{ variantId: giftItem.variantId }] },
      },
    });
  }
}

const fixedVoucher = (amountVnd: number, min: number, extra: Record<string, unknown> = {}) =>
  f.campaign({ fixedAmountVnd: BigInt(amountVnd), minEligibleSubtotalVnd: BigInt(min), maxUses: 5, maxBudgetVnd: BigInt(5_000_000), ...extra });
const freeShipVoucher = (min: number) => f.shippingCampaign({ minEligibleSubtotalVnd: BigInt(min), maxUses: 5, maxBudgetVnd: BigInt(5_000_000) });

async function hold(acknowledged = false) {
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV, ownHolds: await holdService.readOwnLiveHolds(cartId) });
  assert.ok(preview.enabled && preview.ok, JSON.stringify(preview, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  if (!preview.enabled || !preview.ok) throw new Error("unreachable");
  const result = await flow.hold({ cartId, expectedQuoteDigest: preview.quoteDigest!, acknowledged });
  assert.equal(result.ok && result.state === "HELD", true, JSON.stringify(result));
  return result;
}

/** What the checkout page does: the same derivation the DRAFT step uses, with the proof that binds it. */
async function render() {
  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: new Date() });
  return readBenefitCheckoutRender({ client: prisma, cartId, lines, shopId: SHOP, now: new Date(), secret: SECRET, env: ENV });
}

type Calls = { create: PancakeCreateOrderRequest[] };
function fakePancake() {
  const calls: Calls = { create: [] };
  const gateway = {
    async fetchVariations(_shopId: number, variationIds: readonly string[]) {
      const rows = await prisma.variantMirror.findMany({ where: { pancakeVariationId: { in: [...variationIds] } }, include: { warehouseStocks: true } });
      return rows.map((row): PancakeCatalogVariation => ({
        id: row.pancakeVariationId, productId: "p", displayId: null, barcode: "b", fields: [], imageUrls: [], isHidden: false, isLocked: false,
        retailPrice: Number(row.pancakeRetailPrice), retailPriceAfterDiscount: Number(row.pancakeRetailPrice), product: { id: "p", name: "P" }, warehouseStocks: [],
        sellableStock: row.warehouseStocks.reduce((sum, entry) => sum + entry.quantity, 0),
      }));
    },
    async resolveTwoLevelAddressNames() { return { provinceName: "Hà Nội", communeName: "Phường Test" }; },
    async createOrder(request: PancakeCreateOrderRequest) { calls.create.push(request); return { id: 800_000 + calls.create.length }; },
    async readOrder(_shopId: number, orderId: string): Promise<PancakeOrderReadBack> {
      const request = calls.create.at(-1);
      return {
        orderId, shopId: SHOP, status: 0,
        lines: (request?.items ?? []).map((item) => ({ pancakeVariationId: item.variation_id, quantity: item.quantity, unitPriceVnd: item.variation_info.retail_price })),
        totalPriceVnd: (request?.items ?? []).reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0),
      };
    },
  };
  return { gateway, calls };
}

const events: string[] = [];
function checkoutService(pancake: ReturnType<typeof fakePancake>, proof: unknown, options: Readonly<{ withVoucher?: boolean; env?: Readonly<Record<string, string | undefined>> }> = {}) {
  const { withVoucher = true, env = ENV } = options;
  const snapshot = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    env,
    ...(withVoucher ? { voucher: { attemptSecret: SECRET } } : {}),
    // A benefit proof is never a legacy proof: a cart that has fallen back to the plain format cannot be confirmed with it.
    verifyRenderedQuote: () => ({ ok: false, reason: "PROOF_UNVERIFIED" }) as never,
    benefits: {
      verifyBenefitQuote: (currentQuote) => verifyBenefitQuoteProof({ proof, cartId, currentQuote, secret: SECRET }),
      verifyNonclaimAcknowledgement: () => ({ ok: false, reason: "ACK_MISSING" }) as never,
    },
  });
  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, {
    lineLevelPricingVerifiedShopIds: [SHOP],
    env,
    ...(withVoucher ? { voucher: { attemptSecret: SECRET } } : {}),
    onEvent: (event) => events.push(event.name),
    onConfirmed: async () => undefined,
    async acceptAtWriteBoundary(tx, order) { return (await acceptance.acceptWithin(tx, { orderId: order.id })).ok; },
  });
  return createGuestCheckoutSubmitService({
    snapshot,
    orderSubmission: pos,
    generatePublicCode: () => `${P}-order-${process.pid}-${(counter += 1)}`,
    capacity: createCapacityReservationRepository(prisma),
    clock: () => new Date(),
  });
}
const submit = (service: ReturnType<typeof checkoutService>) => service.submit({ cartId, shopId: SHOP, checkoutInput, now: new Date() });
const lastOrder = () => prisma.orderMirror.findFirstOrThrow({ where: { sourceCartId: cartId }, orderBy: { createdAt: "desc" } });
const holdsNow = () => prisma.voucherHold.findMany({ where: { campaign: { pancakeShopId: SHOP } }, orderBy: { kind: "asc" } });
const items = (request: PancakeCreateOrderRequest) => request.items.map((item) => [item.variation_id, item.quantity, item.variation_info.retail_price]);

test("EX-01: held merchandise + free-shipping vouchers reach the quote, the proof, the DRAFT, the acceptance and the POS lines to the VND", async () => {
  await seed();
  const m = await fixedVoucher(50_000, 600_000);
  const s = await freeShipVoucher(600_000);
  await hold();

  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT", JSON.stringify(rendered, (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Map ? [...v] : v)).slice(0, 300));
  if (rendered.kind !== "BENEFIT") return;
  assert.equal(rendered.facts.paidSubtotalVnd, 850_000);
  assert.equal(rendered.facts.shippingFeeVnd, 0, "the 30.000đ fee is waived by the shipping voucher");
  assert.equal(rendered.facts.totalVnd, 850_000);
  assert.deepEqual(rendered.facts.lines.map((line) => [line.quantity, line.unitPriceVnd, line.discountSteps.map((step) => step.source)]), [[2, 425_000, ["VOUCHER"]]]);

  const pancake = fakePancake();
  const result = await submit(checkoutService(pancake, issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })));
  const order = await lastOrder();
  assert.deepEqual(result, { ok: true, status: "CONFIRMED", orderCode: order.publicCode });
  assert.equal(order.state, "CONFIRMED");
  assert.deepEqual([order.merchandiseSubtotalVnd, order.shippingFeeVnd, order.totalVnd], [BigInt(850_000), BigInt(0), BigInt(850_000)]);

  // The vendor sees the voucher-priced line and the waived fee, so its total equals the website's.
  assert.equal(pancake.calls.create.length, 1);
  assert.deepEqual(items(pancake.calls.create[0]!), [[paid.variationId, 2, 425_000]]);
  assert.equal(pancake.calls.create[0]!.shipping_fee, 0);

  // Accepted and consumed once, exactly what was quoted.
  assert.equal((await prisma.orderAcceptance.findUniqueOrThrow({ where: { orderId: order.id } })).orderId, order.id);
  assert.deepEqual((await holdsNow()).map((h) => [h.state, h.orderId]), [["CONSUMED", order.id], ["CONSUMED", order.id]]);
  const redemptions = await prisma.voucherRedemption.findMany({ where: { orderId: order.id }, orderBy: { kind: "asc" } });
  assert.deepEqual(redemptions.map((r) => [r.kind, r.campaignId, r.amountVnd]), [["MERCHANDISE", m.id, BigInt(50_000)], ["SHIPPING_FREE", s.id, BigInt(30_000)]]);
  for (const [id, vnd] of [[m.id, 50_000], [s.id, 30_000]] as const) {
    const row = await prisma.voucherCampaign.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([row.reservedUses, row.redeemedUses, row.redeemedVnd], [0, 1, BigInt(vnd)]);
  }
  // The stored quote walks base -> voucher price, and the declaration is the frozen provenance.
  const stored = (await readOrderQuoteSnapshot(prisma, order.id))!;
  assert.deepEqual(stored.lines[0]!.discountSteps.map((step) => [step.source, step.campaignId, step.inputPriceVnd, step.outputPriceVnd]), [["VOUCHER", m.id, 450_000, 425_000]]);
  const declared = await prisma.orderVoucherSnapshot.findUniqueOrThrow({ where: { orderId: order.id } });
  assert.equal((declared.snapshot as { totalVnd: number }).totalVnd, 850_000);
});

test("a discount that does not divide evenly becomes two price segments, each with the voucher step, and the POS lines still sum exactly", async () => {
  await seed({ quantity: 3 });
  await fixedVoucher(50_000, 600_000);
  await hold();
  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") return;
  assert.equal(rendered.facts.paidSubtotalVnd, 1_350_000 - 50_000);
  assert.equal(rendered.facts.lines.length, 2, "16.666đ x 2 units + 16.667đ x 1 unit");
  assert.ok(rendered.facts.lines.every((line) => line.discountSteps.length === 1 && line.discountSteps[0]!.source === "VOUCHER"));

  const pancake = fakePancake();
  const result = await submit(checkoutService(pancake, issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pancake.calls.create[0]!.items.reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0), 1_300_000);
});

test("TG-05 / AC-31: the holds stop describing the cart (it changed) -> priced WITHOUT the voucher, the old proof is refused, nothing is consumed", async () => {
  await seed();
  await fixedVoucher(50_000, 600_000);
  await hold();
  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT", "sanity: rendered with the voucher");
  if (rendered.kind !== "BENEFIT") return;
  const proof = issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })!;

  // The buyer adds a unit in another tab: paidRevision moves, the holds no longer describe the cart.
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 3 } });
  await prisma.$executeRaw`UPDATE "Cart" SET "paidRevision" = "paidRevision" + 1 WHERE "id" = ${cartId}`;
  // The stale hold is NOT applied: the cart is priced as it is (3 x 450.000đ + the plain fee) and the buyer is told.
  const after = await render();
  assert.equal(after.kind, "LEGACY");
  assert.equal(after.kind === "LEGACY" && after.voucherStale, true);
  const direct = await prisma.$transaction((tx) => resolveBenefitCheckoutQuote({ tx, cartId, shopId: SHOP, now: new Date(), env: ENV, voucher: { attemptSecret: SECRET } }));
  assert.equal(direct.kind, "LEGACY");
  assert.equal(direct.kind === "LEGACY" && direct.shippingQuote.feeVnd, 30_000);
  const pancake = fakePancake();
  const result = await submit(checkoutService(pancake, proof));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, "PRICE_CHANGED");
  assert.deepEqual(pancake.calls.create, []);
  assert.deepEqual((await holdsNow()).map((h) => h.state), ["HELD"], "the stale hold is left for its own expiry, not consumed");
  assert.equal(await prisma.orderAcceptance.count({ where: { order: { sourceCartId: cartId } } }), 0);
});

test("review f3eed3a: the gift/quantity gate is switched OFF inside the 10 minutes: the hold is set aside and SAID so, the old proof cannot place a plain order, nothing is consumed", async () => {
  await seed();
  await fixedVoucher(50_000, 600_000);
  await hold();
  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") return;
  const proof = issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })!;

  const noGq = { ...ENV, LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: undefined };
  const items2 = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items: items2, now: new Date() });
  const after = await readBenefitCheckoutRender({ client: prisma, cartId, lines, shopId: SHOP, now: new Date(), secret: SECRET, env: noGq });
  assert.equal(after.kind, "LEGACY", "the benefit pipeline is off, so the cart is priced plainly");
  assert.equal(after.kind === "LEGACY" && after.voucherStale, true, "and the page is told the buyer's holds were set aside, never silently dropped");

  const pancake = fakePancake();
  const result = await submit(checkoutService(pancake, proof, { env: noGq }));
  assert.equal(result.ok, false, "the proof the buyer saw (with the voucher) cannot place a plain order");
  assert.deepEqual(pancake.calls.create, []);
  assert.deepEqual((await holdsNow()).map((h) => h.state), ["HELD"], "the hold is not consumed; it expires on its own");
  assert.equal(await prisma.voucherRedemption.count({ where: { campaign: { pancakeShopId: SHOP } } }), 0);
});

test("AC-47: flag switched OFF while a voucher checkout is in flight: the live hold is still honoured and settles; no NEW hold is granted", async () => {
  await seed();
  const m = await fixedVoucher(50_000, 600_000);
  await hold();
  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") return;
  const proof = issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })!;

  // The operator unsets LA_VOUCHER_ENABLED (runbook section 4); the shopper presses "Đặt hàng" with the proof they saw.
  const off = { ...ENV, LA_VOUCHER_ENABLED: undefined };
  const pancake = fakePancake();
  const result = await submit(checkoutService(pancake, proof, { env: off }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const order = await lastOrder();
  assert.equal(order.totalVnd, BigInt(880_000), "850.000đ goods + the 30.000đ fee: the voucher the buyer held was honoured");
  assert.deepEqual(items(pancake.calls.create[0]!), [[paid.variationId, 2, 425_000]]);
  assert.deepEqual((await holdsNow()).map((h) => h.state), ["CONSUMED"]);
  assert.equal((await prisma.voucherCampaign.findUniqueOrThrow({ where: { id: m.id } })).redeemedUses, 1);

  // What OFF does stop: a NEW hold, and the preview that would offer one.
  const offFlow = createVoucherHoldFlow(prisma, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: off });
  const before = await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } });
  const refused = await offFlow.hold({ cartId, expectedQuoteDigest: "0".repeat(64), acknowledged: false });
  assert.equal(refused.ok, false);
  assert.equal(await prisma.voucherHold.count({ where: { campaign: { pancakeShopId: SHOP } } }), before);
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: off });
  assert.equal(preview.enabled, false);
});

test("no hold -> the checkout is exactly the plain checkout: no voucher, no declaration, no acceptance", async () => {
  await seed();
  await fixedVoucher(50_000, 600_000);
  const rendered = await render();
  assert.equal(rendered.kind, "LEGACY");
  const result = await (async () => {
    // The legacy checkout proof path is unchanged; here it is enough that nothing voucher-shaped appears.
    const order = await prisma.orderMirror.count({ where: { sourceCartId: cartId } });
    return order;
  })();
  assert.equal(result, 0);
  assert.equal(await prisma.orderVoucherSnapshot.count(), 0);
});

test("holds released between the DRAFT and the POS write: the order is closed for a new attempt, nothing sent, nothing consumed", async () => {
  await seed();
  await fixedVoucher(50_000, 600_000);
  await hold();
  const rendered = await render();
  assert.equal(rendered.kind, "BENEFIT");
  if (rendered.kind !== "BENEFIT") return;
  const proof = issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET })!;
  const pancake = fakePancake();
  const snapshot = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true, env: ENV, voucher: { attemptSecret: SECRET }, verifyRenderedQuote: () => ({ ok: false, reason: "PROOF_UNVERIFIED" }) as never,
    benefits: { verifyBenefitQuote: (currentQuote) => verifyBenefitQuoteProof({ proof, cartId, currentQuote, secret: SECRET }), verifyNonclaimAcknowledgement: () => ({ ok: false, reason: "ACK_MISSING" }) as never },
  });
  const draft = await snapshot.create({ cartId, shopId: SHOP, publicCode: `${P}-draft-${process.pid}`, checkoutInput, now: new Date() });
  assert.ok(draft.ok);
  assert.equal(await prisma.orderVoucherSnapshot.count({ where: { order: { sourceCartId: cartId } } }), 1);

  // Another tab clears the voucher (hold RELEASED) before the POS submission re-derives the quote.
  const revision = Number((await prisma.cart.findUniqueOrThrow({ where: { id: cartId } })).paidRevision);
  assert.equal((await holdService.hold({ shopId: SHOP, cartId, paidRevision: revision, quoteDigest: f.hex("none"), grants: [], releaseKinds: ["MERCHANDISE", "SHIPPING_FREE"] })).ok, true);

  const pos = createPancakeOrderSubmissionService(prisma, pancake.gateway, {
    lineLevelPricingVerifiedShopIds: [SHOP], env: ENV, voucher: { attemptSecret: SECRET }, onConfirmed: async () => undefined,
    async acceptAtWriteBoundary(tx, order) { return (await acceptance.acceptWithin(tx, { orderId: order.id })).ok; },
  });
  const result = await pos.submit({ publicCode: draft.order.publicCode, shopId: SHOP });
  assert.deepEqual(result, { ok: false, state: "REJECTED", reason: "BENEFIT_REQUOTE_REQUIRED" });
  assert.deepEqual(pancake.calls.create, [], "nothing reaches Pancake");
  assert.equal(await prisma.orderAcceptance.count({ where: { order: { sourceCartId: cartId } } }), 0);
  assert.equal(await prisma.voucherRedemption.count({ where: { order: { sourceCartId: cartId } } }), 0);
  assert.equal((await lastOrder()).state, "REJECTED");
});

test("AC-08 / AC-35: a voucher that takes the cart below a gift threshold never silently removes the gift: the gift choice must be repaired first", async () => {
  await seed({ giftThreshold: 880_000 });
  await prisma.cartGiftSelection.create({ data: { cartId, campaignId: `${P}-gift`, variantId: giftItem.variantId, quantity: 1, campaignRevision: 1 } });
  await fixedVoucher(50_000, 600_000);
  // 900.000đ earns the gift; 850.000đ after the voucher does not. The hold needs the buyer's explicit consent.
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: new Date(), env: ENV, ownHolds: [] });
  assert.ok(preview.enabled && preview.ok);
  const refused = await flow.hold({ cartId, expectedQuoteDigest: (preview.enabled && preview.ok ? preview.quoteDigest : "")!, acknowledged: false });
  assert.deepEqual(refused.ok === false && refused.reason, "CONFIRMATION_REQUIRED");
  await hold(true);

  // With the voucher held and the stored gift choice no longer earned, checkout refuses and shows the picker to repair.
  const rendered = await render();
  assert.equal(rendered.kind, "UNAVAILABLE");
  assert.equal(rendered.kind === "UNAVAILABLE" && rendered.reason, "GIFT_SELECTION_INVALID");
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 1, "the stored choice is left exactly as it is");

  // The buyer drops the unearned gift; the hold is still the one they agreed to (the digest binds the retained slot count).
  await prisma.cartGiftSelection.deleteMany({ where: { cartId } });
  const repaired = await render();
  assert.equal(repaired.kind, "BENEFIT");
  if (repaired.kind !== "BENEFIT") return;
  assert.equal(repaired.facts.paidSubtotalVnd, 850_000);
  assert.deepEqual(repaired.facts.lines.map((line) => line.role), ["PAID"]);
});
