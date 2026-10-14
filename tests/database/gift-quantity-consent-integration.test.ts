import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCartGiftSelectionService } from "../../src/commerce/cart-gift-selection.ts";
import { clearLegacyPromotionStackConsent, setLegacyPromotionStackConsent } from "../../src/commerce/gift-quantity-legacy-consent.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * GQ12 x GQ09a integration gate (docs/integrations/gift-selection-feature-on-gate.md).
 *
 * Everything here goes through `createCartGiftSelectionService(...).get()` and `.set()` against a
 * real database. There is no way to inject a consent reader into that service, so the persisted
 * `LegacyPromotionStackConsent` rows written by the admin contract are the only source of truth:
 * Flash 10% on 1.000.000đ, then a tier 5% that stacks only when consent is persisted two ways.
 * A gift threshold of 880.000đ separates the two outcomes (855.000đ earns nothing, 900.000đ earns one).
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }), log: [{ emit: "event", level: "query" }] });
const queries: string[] = [];
(prisma as unknown as { $on: (event: string, handler: (event: { query: string }) => void) => void }).$on("query", (event) => {
  queries.push(event.query);
});

const SHOP = 910_130;
const P = "gq12c";
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const admin = { user: { id: "admin", role: "ADMIN" }, session: { id: "admin-session" } };

const flashId = `${P}-flash`;
const tierId = `${P}-tier`;
const giftCampaignId = `${P}-gift`;
let cartId = "";
let paidVariantId = "";
let giftVariantId = "";

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaignId: { startsWith: `${P}-` } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.promotionCampaign.deleteMany({ where: { id: { startsWith: `${P}-` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function product(suffix: string, price: number, stock: number, categoryKey: string | null) {
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: `GQ12c ${suffix}`,
      isActive: true, isPresent: true, syncedAt: PAST,
      variants: {
        create: {
          pancakeVariationId: `${P}-${suffix}-var`, color: "Black", size: "M", isActive: true, isPresent: true,
          pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: PAST,
          warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh`, quantity: stock, syncedAt: PAST } },
        },
      },
    },
    include: { variants: true },
  });
  if (categoryKey !== null) await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey } });
  return { productId: created.id, variantId: created.variants[0]!.id };
}

async function seed(options: Readonly<{ tierPeers?: boolean }> = {}) {
  const paid = await product("paid", 1_000_000, 50, "vayDam");
  const gift = await product("giftitem", 100_000, 3, null);
  paidVariantId = paid.variantId;
  giftVariantId = gift.variantId;
  cartId = (await prisma.cart.create({
    data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: { variantId: paid.variantId, quantity: 1 } } },
  })).id;

  await prisma.promotionCampaign.create({
    data: {
      id: flashId, kind: "FLASH_SALE", name: "Flash 10", discountType: "PERCENTAGE", percentageValue: 10,
      startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId: paid.productId }] },
    },
  });
  await prisma.giftQuantityCampaign.create({
    data: {
      id: tierId, kind: "QUANTITY_TIER", name: "Tier 5", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      stackPriority: 2, stackingEnabled: true,
      tiers: { create: [{ minQuantity: 1, discountValue: 5 }] },
      stackPeers: { create: options.tierPeers === false ? [] : [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] },
    },
  });
  // 880.000đ sits between the stacked total (855.000đ) and the unstacked one (900.000đ).
  await prisma.giftQuantityCampaign.create({
    data: {
      id: giftCampaignId, kind: "GIFT_ITEM", name: "Gift 880k", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 880_000, subtotalScope: "ALL_PAID_LINES",
      awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: 1, allowDuplicateGifts: true,
      giftOptions: { create: [{ variantId: gift.variantId }] },
    },
  });
}

const service = (client: PrismaClient = prisma, env: Readonly<Record<string, string | undefined>> = ON) =>
  createCartGiftSelectionService(client, { get: () => ({ value: cartId }) }, { shopId: SHOP, env });
const choice = (quantity = 1) => ({ campaignId: giftCampaignId, variantId: giftVariantId, quantity, campaignRevision: 1 });
const setConsent = () => setLegacyPromotionStackConsent({ campaignId: flashId, stackPriority: 1, now: NOW, session: admin, client: prisma, env: ON });
const clearConsent = () => clearLegacyPromotionStackConsent({ campaignId: flashId, session: admin, client: prisma });
const selectionRows = () => prisma.cartGiftSelection.count({ where: { cartId } });

async function readGiftState() {
  const result = await service().get(NOW);
  assert.ok("state" in result, "expected a gift state from get()");
  const quote = result.state.quote.benefits;
  assert.ok(quote.enabled && quote.ok, "the shared transactional quote must be available");
  const entitlement = result.state.entitlements.find((entry) => entry.campaignId === giftCampaignId);
  assert.ok(entitlement !== undefined);
  return { state: result.state, subtotalVnd: quote.subtotalVnd, entitlement };
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("persisted two-way consent: get() prices Flash 10% + tier 5% at 855.000đ, so the 880.000đ gift is not earned and set() refuses", async () => {
  await seed();
  assert.equal((await setConsent()).ok, true);

  const { subtotalVnd, entitlement } = await readGiftState();
  assert.equal(subtotalVnd, 855_000);
  assert.equal(entitlement.eligibleSubtotalVnd, 855_000);
  assert.equal(entitlement.entitled, 0);
  assert.equal(entitlement.grantable, 0);

  assert.deepEqual(await service().set(choice(), NOW), { ok: false, reason: "SELECTION_INVALID" });
  assert.equal(await selectionRows(), 0, "a refused choice writes nothing");
});

test("clearing the persisted consent: get() prices 900.000đ, the gift is earned and set() stores the choice", async () => {
  await seed();
  assert.equal((await setConsent()).ok, true);
  assert.equal((await readGiftState()).subtotalVnd, 855_000);

  assert.equal((await clearConsent()).ok, true);
  const { subtotalVnd, entitlement, state } = await readGiftState();
  assert.equal(subtotalVnd, 900_000);
  assert.equal(entitlement.entitled, 1);
  assert.equal(entitlement.grantable, 1);
  assert.equal(state.quote.lines[0]?.available, true);

  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  assert.equal(await selectionRows(), 1);
  const after = await readGiftState();
  assert.equal(after.state.selections.length, 1);
  assert.equal(after.state.validation.ok, true);
});

test("setting the consent again after a choice: the entitlement is lost, the row stays visible and invalid, removal still works", async () => {
  await seed();
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });
  assert.equal(await selectionRows(), 1);

  assert.equal((await setConsent()).ok, true);
  const { subtotalVnd, entitlement, state } = await readGiftState();
  assert.equal(subtotalVnd, 855_000);
  assert.equal(entitlement.entitled, 0);
  assert.equal(state.selections.length, 1, "nothing is deleted or replaced behind the buyer");
  assert.equal(state.validation.ok, false);
  assert.equal((await service().set(choice(), NOW)).ok, false, "re-saving the same choice is refused while it is not earned");

  assert.deepEqual(await service().set(choice(0), NOW), { ok: true });
  assert.equal(await selectionRows(), 0);
});

test("one-way consent never stacks: a tier that does not name the Flash Sale keeps 900.000đ even with a persisted consent row", async () => {
  await seed({ tierPeers: false });
  assert.equal((await setConsent()).ok, true);
  const { subtotalVnd, entitlement } = await readGiftState();
  assert.equal(subtotalVnd, 900_000);
  assert.equal(entitlement.entitled, 1);
});

test("a tier that names the Flash Sale but has no persisted consent row leaves the legacy 900.000đ", async () => {
  await seed();
  // One-way the other direction: the tier lists FLASH_SALE:* but the legacy campaign never agreed.
  const { subtotalVnd } = await readGiftState();
  assert.equal(subtotalVnd, 900_000);
});

test("a consent read failure returns LOOKUP_FAILED from get() and set() with no cause exposed, and removal still works", async () => {
  await seed();
  assert.deepEqual(await service().set(choice(), NOW), { ok: true });

  let reads = 0;
  const broken = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction") {
        return (work: (tx: object) => Promise<unknown>, options?: object) =>
          (target.$transaction as unknown as (fn: (tx: object) => Promise<unknown>, o?: object) => Promise<unknown>)(
            (tx) => work(new Proxy(tx, {
              get(inner, innerKey) {
                if (innerKey === "legacyPromotionStackConsent") {
                  return { findMany: async () => { reads += 1; throw new Error("private connection detail"); } };
                }
                const value = Reflect.get(inner, innerKey);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            })),
            options,
          );
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;

  const read = await service(broken).get(NOW);
  assert.deepEqual(read, { ok: false, reason: "LOOKUP_FAILED" });
  assert.equal(JSON.stringify(read).includes("private"), false);
  assert.deepEqual(await service(broken).set(choice(2), NOW), { ok: false, reason: "LOOKUP_FAILED" });
  assert.ok(reads >= 2, "the failing stored-consent reader was the one consulted");
  assert.equal(await selectionRows(), 1, "a failed lookup writes nothing and deletes nothing");
  // Removal never needs the quote, so a buyer can always take a choice back.
  assert.deepEqual(await service(broken).set(choice(0), NOW), { ok: true });
  assert.equal(await selectionRows(), 0);
});

test("gate OFF: get() and set() touch no gift, selection or consent table, and the legacy cart output is unchanged", async () => {
  await seed();
  assert.equal((await setConsent()).ok, true);
  const legacy = await createStorefrontCartRepository(prisma).getLines({
    shopId: SHOP, items: [{ variantId: paidVariantId, quantity: 1 }], now: NOW,
  });

  for (const env of [{}, { LA_PROMOTION_ACTIVATION_ENABLED: "true" }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }] as const) {
    queries.length = 0;
    assert.deepEqual(await service(prisma, env).get(NOW), { enabled: false });
    assert.deepEqual(await service(prisma, env).set(choice(), NOW), { ok: false, reason: "FEATURE_DISABLED" });
    assert.deepEqual(queries, [], "OFF reads and writes nothing, so it cannot read a consent row either");
  }
  assert.equal(await selectionRows(), 0);

  queries.length = 0;
  const quote = await createStorefrontCartRepository(prisma).getQuote({
    shopId: SHOP, items: [{ variantId: paidVariantId, quantity: 1 }], now: NOW, env: {},
  });
  assert.equal(JSON.stringify(quote.lines), JSON.stringify(legacy), "OFF lines are byte-identical to the legacy projection");
  assert.deepEqual(quote.benefits, { enabled: false });
  assert.equal(queries.some((statement) => statement.includes('"LegacyPromotionStackConsent"')), false);
  assert.equal(queries.some((statement) => statement.includes('"GiftQuantityCampaign"')), false);
});
