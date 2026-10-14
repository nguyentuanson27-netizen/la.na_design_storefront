import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { disableGiftQuantityCampaign, publishGiftQuantityCampaign } from "../../src/commerce/gift-quantity-activation-service.ts";
import { createMerchantOfferRepository } from "../../src/commerce/merchant-offer-repository.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import type { StorefrontDiscoveryQuery } from "../../src/commerce/storefront-discovery.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * GQ23 -- a price that exists only once a cart reaches a quantity (a tier), or a gift that exists only
 * with an order, must never appear as the unconditional price of one unit on PDP, listings, /shop
 * price sorting and filtering, structured data or the Merchant feed. Persistence is isolated by
 * construction (D-09: separate tables the legacy readers never select); this proves it against real
 * data with the gate ON, next to a legacy Flash Sale that does appear.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq23";
const SHOP = 910_230;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin", role: "ADMIN" }, session: { id: "s" } } as const;
const catalog = createStorefrontCatalogRepository(prisma);
const merchant = createMerchantOfferRepository(prisma);

function query(overrides: Partial<StorefrontDiscoveryQuery> = {}): StorefrontDiscoveryQuery {
  return { query: null, collection: null, color: null, size: null, inStockOnly: false, minPriceVnd: null, maxPriceVnd: null, page: 1, sort: "name-asc", ...overrides } as StorefrontDiscoveryQuery;
}

async function cleanup() {
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.promotionCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function product(key: string, price: number) {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${key}`, slug: `${P}-${key}`, name: `GQ23 ${key}`, isPresent: true, isActive: true, syncedAt: PAST,
      variants: { create: { pancakeVariationId: `${P}-${key}-var`, color: "Đen", size: "M", isPresent: true, isActive: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST, warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh`, quantity: 9, syncedAt: PAST } } } },
    },
    include: { variants: true },
  });
  await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: "vayDam" } });
  return { productId: created.id, variantId: created.variants[0]!.id };
}

/** Every public price surface, serialised, for one fixed clock. */
async function surfaces() {
  const [list, discovery, detail, flashBand, tierBand, baseBand, candidates] = await Promise.all([
    catalog.listProducts({ shopId: SHOP, limit: 24 }),
    catalog.listDiscoveryPage({ shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ sort: "price-asc" }) }),
    catalog.getProductBySlug({ shopId: SHOP, slug: `${P}-plain` }),
    catalog.listDiscoveryPage({ shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ minPriceVnd: 75_000, maxPriceVnd: 85_000 }) }),
    catalog.listDiscoveryPage({ shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ minPriceVnd: 85_000, maxPriceVnd: 95_000 }) }),
    catalog.listDiscoveryPage({ shopId: SHOP, pageSize: 24, now: NOW, discovery: query({ minPriceVnd: 95_000, maxPriceVnd: 110_000 }) }),
    merchant.readCandidateProducts({ shopId: SHOP, now: NOW }),
  ]);
  const slugs = (page: { products: readonly { slug: string }[] }) => page.products.map((p) => p.slug);
  return { list, discovery, detail, flashBand: slugs(flashBand), tierBand: slugs(tierBand), baseBand: slugs(baseBand), candidates };
}
const json = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

test.beforeEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function tierAndGift(plain: { productId: string; variantId: string }, gift: { variantId: string }) {
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-tier`, kind: "QUANTITY_TIER", name: "GQ23 tier", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, scopeMode: "DYNAMIC_CATEGORY",
      categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tiers: { create: [{ minQuantity: 2, discountValue: 10 }] },
    },
  });
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-gift`, kind: "GIFT_ITEM", name: "GQ23 gift", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, scopeMode: "DYNAMIC_CATEGORY",
      categoryKeys: ["vayDam"], giftTrigger: "QUANTITY", minimumQuantity: 1, maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: [{ variantId: gift.variantId }] },
    },
  });
  void plain;
}

test("GQ23: active tier and gift campaigns change no public price surface by a single byte, with the gate ON", async () => {
  process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED = "true";
  try {
    const plain = await product("plain", 100_000);
    const gift = await product("giftitem", 50_000);
    const before = await surfaces();
    await tierAndGift(plain, gift);
    const after = await surfaces();
    assert.equal(json(after), json(before));
    // The tier price (90.000đ) is not a price anyone can find or sort by; the unit price is.
    assert.deepEqual(after.tierBand, []);
    assert.ok(after.baseBand.includes(`${P}-plain`));
    assert.equal(json(after.candidates).includes("90000"), false);
  } finally {
    delete process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED;
  }
});

test("GQ23: a legacy Flash Sale keeps showing truthfully, with or without the gift/tier gate, and a tier never rides on it", async () => {
  const plain = await product("plain", 100_000);
  const gift = await product("giftitem", 50_000);
  await prisma.promotionCampaign.create({
    data: { id: `${P}-flash`, kind: "FLASH_SALE", name: "GQ23 flash", discountType: "PERCENTAGE", percentageValue: 20, startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: plain.productId }] } },
  });
  const flashOnly = await surfaces();
  assert.ok(flashOnly.flashBand.includes(`${P}-plain`), "the legacy sale is found at its effective 80.000đ");
  assert.equal(flashOnly.baseBand.includes(`${P}-plain`), false, "...and no longer at its undiscounted price");
  assert.equal(json(flashOnly.candidates).includes("80000"), true, "the Merchant offer carries the legacy sale");

  await tierAndGift(plain, gift);
  for (const gate of [undefined, "true"]) {
    if (gate === undefined) delete process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED;
    else process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED = gate;
    try {
      assert.equal(json(await surfaces()), json(flashOnly), `gate ${String(gate)}`);
    } finally {
      delete process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED;
    }
  }
});

test("GQ23: publishing or disabling a tier moves the shared pricing revision (the Merchant cache key) and never the offers", async () => {
  const plain = await product("plain", 100_000);
  await product("giftitem", 50_000);
  void plain;
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-draft`, kind: "QUANTITY_TIER", name: "GQ23 draft tier", startsAt: PAST, endsAt: FUTURE, isEnabled: false, scopeMode: "DYNAMIC_CATEGORY",
      categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tiers: { create: [{ minQuantity: 2, discountValue: 10 }] },
    },
  });
  const revision = async () => (await prisma.promotionPricingRevision.findFirstOrThrow({ select: { revision: true } })).revision;
  const offersBefore = json((await surfaces()).candidates);
  const r0 = await revision();

  const published = await publishGiftQuantityCampaign({ campaignId: `${P}-draft`, now: NOW, session: ADMIN, env: ON });
  assert.equal(published.ok, true, json(published));
  const r1 = await revision();
  assert.ok(r1 > r0, "an effective mutation advances the one global revision, so no cache can keep a stale answer");
  assert.equal(json((await surfaces()).candidates), offersBefore, "...while the offers themselves are unchanged");

  const disabled = await disableGiftQuantityCampaign({ campaignId: `${P}-draft`, now: NOW, session: ADMIN });
  assert.equal(disabled.ok, true, json(disabled));
  assert.ok((await revision()) > r1);
  assert.equal(json((await surfaces()).candidates), offersBefore);
});
