import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { readCartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { buildCartPromotionView } from "../../src/routes/cart-promotion-model.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "quantity-progress";
const SHOP = 910_277;
const NOW = new Date("2026-10-17T00:00:00Z");
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" };
let cartId: string, paidId: string;

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

test.beforeEach(async () => {
  await cleanup();
  const variants: string[] = [];
  for (const suffix of ["paid", "gift"]) {
    const product = await prisma.productMirror.create({ data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: suffix, syncedAt: NOW, isActive: true, isPresent: true,
      categoryMemberships: { create: { categoryKey: "vayDam" } },
      variants: { create: { pancakeVariationId: `${P}-${suffix}`, color: "Trắng", size: "M", pancakeRetailPrice: 100_000, pancakeRetailPriceAfterDiscount: 100_000, syncedAt: NOW, isActive: true, isPresent: true,
        warehouseStocks: { create: { pancakeWarehouseId: P, quantity: 50, syncedAt: NOW } } } },
    }, include: { variants: true } });
    variants.push(product.variants[0]!.id);
  }
  paidId = variants[0]!;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  await prisma.giftQuantityCampaign.create({ data: {
    id: `${P}-gift`, name: "Mua 3 tặng 1", kind: "GIFT_ITEM", isEnabled: true, enabledAt: NOW,
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], giftTrigger: "QUANTITY", minimumQuantity: 3,
    maxGiftsPerOrder: 3, allowDuplicateGifts: true,
    giftOptions: { create: { variantId: variants[1]! } },
  } });
  await prisma.giftQuantityCampaign.create({ data: {
    id: `${P}-tier`, name: "Mua 5 giảm 10%", kind: "QUANTITY_TIER", isEnabled: true, enabledAt: NOW,
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
    tiers: { create: { minQuantity: 5, discountValue: 10 } },
  } });
});
test.afterEach(cleanup);
test.after(() => prisma.$disconnect());

async function read(quantity: number) {
  await prisma.cartItem.update({ where: { cartId_variantId: { cartId, variantId: paidId } }, data: { quantity } });
  return prisma.$transaction((tx) => readCartGiftState(tx, cartId, SHOP, NOW, ON));
}

test("real campaign → quote → banner: quantities 2 → 3 → 4 → 5 and back keep gifts and next discount consistent", async () => {
  for (const quantity of [2, 3, 4, 5, 4, 2]) {
    const state = await read(quantity);
    const benefits = state.quote.benefits;
    assert.ok(benefits.enabled && benefits.ok);
    assert.equal(benefits.subtotalVnd, quantity === 5 ? 450_000 : quantity * 100_000);
    assert.equal(state.entitlements[0]!.entitled, quantity < 3 ? 0 : 1);
    const view = buildCartPromotionView(state)!;
    assert.equal(view.savingsVnd, quantity === 5 ? 50_000 : 0);
    assert.equal(view.items.some((item) => item.kind === "GIFT" && item.state === "achieved"), quantity >= 3);
    const next = view.items.find((item) => item.state === "progress")!;
    if (quantity === 3 || quantity === 4) {
      assert.equal(next.kind, "TIER");
      assert.equal(next.title, `Mua thêm ${5 - quantity} sản phẩm áp dụng để được giảm 10%`);
      assert.equal(next.progress!.percent, quantity * 20);
    } else {
      assert.equal(next.kind, "GIFT");
      assert.equal(view.items.some((item) => item.kind === "TIER" && item.state === "achieved"), quantity === 5);
    }
  }
});

test("a non-stackable paid campaign keeps its discount and earned gift without advertising the incompatible tier", async () => {
  await prisma.giftQuantityCampaign.create({ data: {
    id: `${P}-existing`, name: "Mua 2 giảm 5%", kind: "QUANTITY_TIER", isEnabled: true, enabledAt: NOW,
    scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
    tiers: { create: { minQuantity: 2, discountValue: 5 } },
  } });
  const state = await read(4);
  assert.ok(state.quote.benefits.enabled && state.quote.benefits.ok);
  assert.equal(state.quote.benefits.subtotalVnd, 380_000);
  assert.deepEqual(state.quote.benefits.quantityProgress, []);
  const view = buildCartPromotionView(state)!;
  assert.deepEqual(view.items.filter((item) => item.state === "achieved").map((item) => item.kind), ["TIER", "GIFT"]);
  assert.equal(view.items.some((item) => item.kind === "TIER" && item.state === "progress"), false);
});
