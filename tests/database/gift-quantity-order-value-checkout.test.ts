import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { readBenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { issueBenefitQuoteProof, verifyBenefitQuoteProof, verifyNonclaimAcknowledgement } from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { readOrderQuoteSnapshot } from "../../src/commerce/order-quote-snapshot.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { buildBenefitCheckoutViewModel } from "../../src/routes/checkout-model.ts";

/**
 * An order-value ladder through the real checkout: render -> signed quote -> DRAFT order with its frozen
 * quote snapshot. A fixed total is split over units, so one variation is bought at two prices; the
 * render, the proof and the stored order must all say the same thing.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SHOP = 910_251;
const P = "ov26";
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) } as const;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const secret = "ov26-server-secret-at-least-32-characters-long";
const checkoutInput = {
  name: "Nguyễn Văn A", phone: "0901234567", provinceRef: "province-01", districtRef: "district-001", communeRef: "commune-0001", detail: "12 Đường A", note: null,
};

let cartId = "";
let counter = 0;
const variants: Array<{ variantId: string; variationId: string }> = [];

async function cleanup() {
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
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function seed(lines: Array<[price: number, quantity: number]>, ladder: { unit: "PERCENTAGE" | "FIXED_AMOUNT_TOTAL_VND"; tiers: Array<[number, number]> }) {
  variants.length = 0;
  const items: Array<{ variantId: string; quantity: number }> = [];
  for (const [index, [price, quantity]] of lines.entries()) {
    const product = await prisma.productMirror.create({
      data: {
        pancakeShopId: SHOP, pancakeProductId: `${P}-p${index}`, slug: `${P}-p${index}`, name: `OV26 ${index}`, isActive: true, isPresent: true, syncedAt: PAST,
        variants: { create: { pancakeVariationId: `${P}-p${index}-var`, color: "Black", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
          warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh-${index}`, quantity: 50, syncedAt: PAST } } } },
      },
      include: { variants: true },
    });
    variants.push({ variantId: product.variants[0]!.id, variationId: product.variants[0]!.pancakeVariationId });
    items.push({ variantId: product.variants[0]!.id, quantity });
  }
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: items } } })).id;
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-order`, kind: "QUANTITY_TIER", name: "Đơn từ 500.000 giảm 100.000", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], tierBasis: "ORDER_SUBTOTAL", tierUnit: ladder.unit, tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      tiers: { create: ladder.tiers.map(([minQuantity, discountValue]) => ({ minQuantity, discountValue })) },
    },
  });
}

async function render() {
  const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items, now: NOW });
  const result = await readBenefitCheckoutRender({ client: prisma, cartId, lines, shopId: SHOP, now: NOW, secret, env: ON });
  return { lines, result };
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("a fixed total is rendered, proven and stored as one consistent quote", async () => {
  await seed([[100_000, 3], [250_000, 1]], { unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [[500_000, 100_000]] });
  const { lines, result } = await render();
  assert.equal(result.kind, "BENEFIT", JSON.stringify(result, (_k, v) => (v instanceof Map ? [...v] : typeof v === "bigint" ? String(v) : v)));
  if (result.kind !== "BENEFIT") return;

  // Render: 550.000 of goods, 100.000 off, once. The campaign's own name rides along for the saving line.
  assert.equal(result.facts.paidSubtotalVnd, 450_000);
  assert.equal(result.needsAcknowledgement, false, "no gift slots are left unclaimed by an order discount");
  assert.equal(result.tierDropped, false);
  assert.deepEqual([...(result.campaignNames ?? [])], [[`${P}-order`, "Đơn từ 500.000 giảm 100.000"]]);
  const model = buildBenefitCheckoutViewModel({ lines, render: result });
  assert.deepEqual(model.promotions?.savings.map((row) => [row.label, row.amountVnd]), [["Đơn từ 500.000 giảm 100.000", 100_000]]);
  assert.equal(model.totals?.subtotalText.replace(/\D/g, ""), "450000");

  // Proof: what the buyer saw is what the server will recompute.
  const proof = issueBenefitQuoteProof({ quote: result.facts, cartId, secret });
  assert.ok(proof);
  assert.equal(verifyBenefitQuoteProof({ proof, cartId, currentQuote: result.facts, secret }).ok, true);

  // DRAFT: the order stores the same lines and the same ledger.
  const service = createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    env: ON,
    verifyRenderedQuote: () => ({ ok: true }),
    benefits: {
      verifyBenefitQuote: (currentQuote) => verifyBenefitQuoteProof({ proof, cartId, currentQuote, secret }),
      verifyNonclaimAcknowledgement: (currentQuote) => verifyNonclaimAcknowledgement({ token: undefined, cartId, currentQuote, secret, now: NOW }),
    },
  });
  const created = await service.create({ cartId, shopId: SHOP, publicCode: `${P}-order-${process.pid}-${(counter += 1)}`, checkoutInput, now: NOW });
  assert.equal(created.ok, true, JSON.stringify(created, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.ok(created.ok);
  assert.equal(created.order.merchandiseSubtotalVnd, BigInt(450_000));
  assert.equal(created.order.state, "DRAFT");

  const order = await prisma.orderMirror.findUniqueOrThrow({ where: { id: created.order.id }, include: { lines: true } });
  const unitCount = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const lineSum = order.lines.reduce((sum, line) => sum + BigInt(line.quantity) * line.unitPriceVnd, BigInt(0));
  assert.equal(unitCount, 4, "no unit appears or disappears");
  assert.equal(lineSum, BigInt(450_000), "the order's lines add up to exactly the discounted goods");
  for (const line of order.lines) assert.ok(line.unitPriceVnd >= BigInt(1));

  const stored = (await readOrderQuoteSnapshot(prisma, order.id))!;
  assert.equal(stored.paidSubtotalVnd, 450_000);
  const saved = stored.lines.flatMap((line) => line.discountSteps.map((step) => (step.inputPriceVnd - step.outputPriceVnd) * line.quantity)).reduce((a, b) => a + b, 0);
  assert.equal(saved, 100_000, "the frozen ledger records the whole discount");
  assert.ok(stored.lines.every((line) => line.discountSteps.every((step) => step.campaignId === `${P}-order` && step.source === "QUANTITY_TIER")));
});

test("a percentage rung is the same story at checkout, and below the rung there is no benefit checkout at all", async () => {
  await seed([[400_000, 3]], { unit: "PERCENTAGE", tiers: [[1_000_000, 5], [2_000_000, 10]] });
  const above = await render();
  assert.equal(above.result.kind, "BENEFIT");
  if (above.result.kind === "BENEFIT") assert.equal(above.result.facts.paidSubtotalVnd, 3 * 380_000, "1.200.000 reaches the 5 % rung");

  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 2 } }); // 800.000: under the first rung
  const below = await render();
  assert.equal(below.result.kind, "LEGACY", "nothing applies, so checkout is the ordinary one, untouched");
});

test("the rendered proof refuses a cart whose order value moved across the rung", async () => {
  await seed([[400_000, 3]], { unit: "PERCENTAGE", tiers: [[1_000_000, 5]] });
  const first = await render();
  assert.equal(first.result.kind, "BENEFIT");
  if (first.result.kind !== "BENEFIT") return;
  const proof = issueBenefitQuoteProof({ quote: first.result.facts, cartId, secret })!;

  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 2 } });
  const after = await render();
  assert.equal(after.result.kind, "LEGACY");
  // And on the other side of the same rung, a different quote is not covered by the old proof.
  await prisma.cartItem.updateMany({ where: { cartId }, data: { quantity: 4 } });
  const bigger = await render();
  assert.equal(bigger.result.kind, "BENEFIT");
  if (bigger.result.kind === "BENEFIT") assert.equal(verifyBenefitQuoteProof({ proof, cartId, currentQuote: bigger.result.facts, secret }).ok, false);
});
