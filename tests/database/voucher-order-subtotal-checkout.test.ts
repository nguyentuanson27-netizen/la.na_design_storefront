import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { readVoucherPreview } from "../../src/commerce/voucher-preview.ts";
import { createVoucherSelectionService } from "../../src/commerce/voucher-selection-service.ts";
import { createVoucherFixtures } from "../support/voucher-fixtures.ts";

/**
 * Voucher v1 preview against a real database and the real cart, tier, gift and shipping engines (V08, TG-11 A,
 * TG-10 B): the numbers the picker will show are produced from the same authorities the cart uses.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 940_006;
const P = "vchr-prev";
const f = createVoucherFixtures(prisma, SHOP, P);
const NOW = new Date("2026-10-25T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const ON = { LA_VOUCHER_ENABLED: "true" } as const;
const ON_GQ = { LA_VOUCHER_ENABLED: "true", LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;

async function cleanup() {
  await f.cleanup();
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

let sequence = 0;
async function product(price: number, categoryKey: string | null, stock = 50) {
  sequence += 1;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${sequence}`, slug: `${P}-${sequence}`, name: `Voucher preview ${sequence}`, isActive: true, isPresent: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${sequence}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
        warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${sequence}`, quantity: stock, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  if (categoryKey !== null) await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey } });
  return { productId: created.id, variantId: created.variants[0]!.id };
}
async function cart(items: ReadonlyArray<{ variantId: string; quantity: number }>) {
  return prisma.cart.create({ data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) } } });
}
const preview = (cartId: string, env: Readonly<Record<string, string>> = ON) => readVoucherPreview({ client: prisma, cartId, shopId: SHOP, now: NOW, env });
async function ok(cartId: string, env: Readonly<Record<string, string>> = ON) {
  const result = await preview(cartId, env);
  assert.equal(result.enabled && result.ok, true, JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return result as Extract<Awaited<ReturnType<typeof preview>>, { ok: true }>;
}
const fixed = (amountVnd: number, min: number, extra: Record<string, unknown> = {}) =>
  f.campaign({ fixedAmountVnd: BigInt(amountVnd), minEligibleSubtotalVnd: BigInt(min), ...extra });
const freeship = (min: number | null, extra: Record<string, unknown> = {}) => f.shippingCampaign({ minEligibleSubtotalVnd: min === null ? null : BigInt(min), ...extra });

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
test.beforeEach(cleanup);

test("AC-24: with the flag OFF the preview reads nothing and reports disabled", async () => {
  const p = await product(450_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 2 }]);
  await fixed(50_000, 100_000);
  assert.deepEqual(await preview(c.id, {}), { enabled: false });
});

test("a cart that does not exist or is empty is CART_UNAVAILABLE, never an empty voucher list", async () => {
  assert.deepEqual(await preview("00000000-0000-4000-8000-000000000001"), { enabled: true, ok: false, reason: "CART_UNAVAILABLE" });
});

test("AC-02 / EX-01 on a real cart: 2 x 450.000 with a 50K voucher and a 600K freeship pays 850.000 and ships free", async () => {
  const p = await product(450_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 2 }]);
  const m = await fixed(50_000, 600_000);
  const s = await freeship(600_000);
  const result = await ok(c.id);
  assert.deepEqual(result.quote.selection, { merchandiseId: m.id, shippingId: s.id });
  assert.equal(result.quote.paidBeforeVnd, 900_000);
  assert.equal(result.quote.paidAfterVnd, 850_000);
  assert.equal(result.quote.shippingFeeVnd, 0);
  assert.equal(result.quote.totalPayableVnd, 850_000);
  assert.equal(result.quote.held, false);
  assert.equal(result.paidRevision > BigInt(0), true);
});

test("AC-11: a card under its minimum shows the exact shortfall; AC-06: only in-scope lines count", async () => {
  const dress = await product(400_000, "vayDam");
  const bag = await product(300_000, "phuKien");
  const c = await cart([{ variantId: dress.variantId, quantity: 1 }, { variantId: bag.variantId, quantity: 1 }]);
  const dressOnly = await f.campaign({ fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(500_000), scopeMode: "TARGETED", categoryKeys: ["vayDam"] });
  const result = await ok(c.id);
  const entry = result.entries.find((e) => e.card.id === dressOnly.id)!;
  assert.equal(entry.state.reason, "BELOW_MINIMUM");
  assert.equal(entry.state.shortfallVnd, 100_000);
  assert.deepEqual(result.quote.selection.merchandiseId, null);
});

test("AC-26 / AC-04: the saved selection is what the preview honours; manual NONE stays NONE", async () => {
  const p = await product(450_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 2 }]);
  const small = await fixed(10_000, 100_000, { name: "small" });
  await fixed(80_000, 100_000, { name: "big" });
  const selection = createVoucherSelectionService(prisma, { shopId: SHOP, env: ON });
  assert.equal((await ok(c.id)).quote.merchandiseDiscountVnd, 80_000);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: small.id });
  assert.equal((await ok(c.id)).quote.merchandiseDiscountVnd, 10_000);
  await selection.setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: null });
  const none = await ok(c.id);
  assert.equal(none.quote.merchandiseDiscountVnd, 0);
  assert.equal(none.quote.voucherCount, 0);
});

test("a private code the shopper entered is considered; without it the same voucher is invisible", async () => {
  const p = await product(450_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 2 }]);
  const priv = await fixed(70_000, 100_000, { issuance: "CODE", visibility: "PRIVATE", code: "KOL70" });
  assert.equal((await ok(c.id)).entries.some((e) => e.card.id === priv.id), false);
  const applied = await createVoucherSelectionService(prisma, { shopId: SHOP, env: ON }).applyCode({ cartId: c.id, rawCode: "kol70" });
  assert.equal(applied.ok, true);
  const after = await ok(c.id);
  assert.equal(after.quote.selection.merchandiseId, priv.id);
  assert.equal(after.entries.find((e) => e.card.id === priv.id)!.card.publicCode, null);
});

test("EX-06 / AC-29 on the real shipping engine: a non-stacking free-ship campaign falls under a voucher, so AUTO keeps NONE", async () => {
  const p = await product(100_000, "vayDam");
  const c = await cart([{ variantId: p.variantId, quantity: 1 }]);
  await prisma.shippingPromotionCampaign.create({ data: {
    pancakeShopId: SHOP, name: "Freeship vay", isEnabled: true, enabledAt: PAST, minimumQuantity: 1, priority: 1, stackingEnabled: false, categoryKeys: ["vayDam"],
  } });
  const m = await fixed(10_000, 50_000);
  const auto = await ok(c.id);
  assert.deepEqual(auto.quote.selection, { merchandiseId: null, shippingId: null });
  assert.equal(auto.quote.totalPayableVnd, 100_000);
  assert.equal(auto.quote.shippingFeeVnd, 0, "the campaign still ships it free");
  await createVoucherSelectionService(prisma, { shopId: SHOP, env: ON }).setGroup({ cartId: c.id, group: "MERCHANDISE", mode: "MANUAL", voucherId: m.id });
  const manual = await ok(c.id);
  assert.equal(manual.quote.shippingFeeVnd, 30_000);
  assert.equal(manual.quote.totalPayableVnd, 120_000);
  assert.deepEqual(manual.quote.confirmation, { totalIncreaseVnd: 20_000, shippingFeeIncreaseVnd: 30_000 });
  // With stacking allowed the campaign survives the voucher and the voucher is simply cheaper.
  await prisma.shippingPromotionCampaign.updateMany({ where: { pancakeShopId: SHOP }, data: { stackingEnabled: true } });
  const stacked = await ok(c.id);
  assert.equal(stacked.quote.totalPayableVnd, 90_000);
});

test("TG-11 A / EX-10 / AC-46 end to end: 650K - ladder 30K - voucher 80K = 540K, the ladder is never re-run", async () => {
  const p = await product(650_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 1 }]);
  await prisma.giftQuantityCampaign.create({ data: {
    id: `${P}-ladder`, kind: "QUANTITY_TIER", name: "Đơn từ 600.000 giảm 30.000", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
    scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], tierBasis: "ORDER_SUBTOTAL", tierUnit: "FIXED_AMOUNT_TOTAL_VND", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null,
    tiers: { create: [{ minQuantity: 600_000, discountValue: 30_000 }] },
  } });
  // No voucher at all: the base price is the post-ladder 620K.
  const plain = await ok(c.id, ON_GQ);
  assert.equal(plain.quote.paidBeforeVnd, 620_000);
  assert.equal(plain.quote.totalPayableVnd, 650_000); // + 30K shipping
  await fixed(80_000, 600_000);
  const withVoucher = await ok(c.id, ON_GQ);
  assert.equal(withVoucher.quote.paidBeforeVnd, 620_000, "the threshold and the discount are measured on 620K");
  assert.equal(withVoucher.quote.paidAfterVnd, 540_000, "not 570K");
  assert.equal(withVoucher.quote.totalPayableVnd, 570_000);
});

test("AC-28: the totals reconcile to the VND on a mixed cart with both vouchers", async () => {
  const a = await product(333_333, "vayDam");
  const b = await product(12_345, "phuKien");
  const c = await cart([{ variantId: a.variantId, quantity: 2 }, { variantId: b.variantId, quantity: 3 }]);
  await fixed(77_777, 100_000);
  await freeship(null);
  const { quote } = await ok(c.id);
  assert.equal(quote.paidBeforeVnd, 2 * 333_333 + 3 * 12_345);
  assert.equal(quote.paidBeforeVnd - quote.merchandiseDiscountVnd, quote.paidAfterVnd);
  assert.equal(quote.paidAfterVnd + quote.shippingFeeVnd, quote.totalPayableVnd);
  assert.equal(quote.allocation!.lines.reduce((sum, l) => sum + l.deductionVnd, 0), quote.merchandiseDiscountVnd);
});

test("AC-42: the preview is read-only: counters, holds, selection and the cart are unchanged, however often it runs", async () => {
  const p = await product(450_000, null);
  const c = await cart([{ variantId: p.variantId, quantity: 2 }]);
  await fixed(50_000, 100_000, { maxUses: 3 });
  await freeship(null);
  const snapshot = async () =>
    JSON.stringify(
      { v: await prisma.voucherCampaign.findMany({ where: { pancakeShopId: SHOP }, orderBy: { id: "asc" } }), h: await prisma.voucherHold.count(), s: await prisma.cartVoucherSelection.count({ where: { cartId: c.id } }), c: await prisma.cart.findUnique({ where: { id: c.id } }) },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
  const before = await snapshot();
  for (let i = 0; i < 4; i += 1) await ok(c.id);
  assert.equal(await snapshot(), before);
});
