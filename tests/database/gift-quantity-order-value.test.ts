import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  editScheduledGiftQuantityCampaign,
  publishGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-activation-service.ts";
import type { GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-admin-service.ts";
import { createGiftQuantityAdminRepository } from "../../src/commerce/gift-quantity-admin-repository.ts";
import type { TierRuleInput } from "../../src/commerce/gift-quantity-tier-rule.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * Order-value ladders against a real database: the schema's own refusals, the admin write path, and the
 * quote the cart repository produces from stored campaigns.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createStorefrontCartRepository(prisma);
const P = "ov25";
const SHOP = 910_250;
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const START = new Date("2026-10-20T00:00:00.000Z");
const END = new Date("2026-10-30T00:00:00.000Z");
const syncedAt = new Date("2026-10-01T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" LIKE ${`${P}-%`} OR "name" LIKE ${`${P}%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

type Seed = { productId: string; variantIds: string[] };
async function seedProduct(suffix: string, prices: number[], categoryKey: string | null = "vayDam"): Promise<Seed> {
  const product = await prisma.productMirror.create({
    data: { pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: `Product ${suffix}`, isPresent: true, isActive: true, syncedAt },
  });
  if (categoryKey !== null) await prisma.productCategoryMembership.create({ data: { productId: product.id, categoryKey } });
  const variantIds: string[] = [];
  for (const [index, price] of prices.entries()) {
    const variant = await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${P}-${suffix}-v${index}`, productId: product.id, color: "Black", size: `S${index}`,
        isPresent: true, isActive: true, pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt,
      },
    });
    await prisma.warehouseStock.create({ data: { variantId: variant.id, pancakeWarehouseId: `${P}-wh`, quantity: 50, syncedAt } });
    variantIds.push(variant.id);
  }
  return { productId: product.id, variantIds };
}
const items = (seed: Seed, quantities: number[]) => seed.variantIds.map((variantId, index) => ({ variantId, quantity: quantities[index] ?? 1 }));

type OrderCampaign = {
  id: string;
  unit?: "PERCENTAGE" | "FIXED_AMOUNT_TOTAL_VND";
  tiers: Array<[number, number]>;
  stackingEnabled?: boolean;
  stackPriority?: number | null;
  peers?: Array<{ peerKind: "PROMOTION" | "FLASH_SALE" | "CLEARANCE" | "QUANTITY_TIER"; peerCampaignId: string }>;
  name?: string;
};
async function orderCampaign(o: OrderCampaign) {
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-${o.id}`, kind: "QUANTITY_TIER", name: o.name ?? `${P} order ${o.id}`,
      startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [],
      tierBasis: "ORDER_SUBTOTAL", tierUnit: o.unit ?? "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null,
      stackPriority: o.stackPriority ?? null, stackingEnabled: o.stackingEnabled ?? false,
      tiers: { create: o.tiers.map(([minQuantity, discountValue]) => ({ minQuantity, discountValue })) },
      stackPeers: { create: o.peers ?? [] },
    },
  });
}
async function flash(id: string, productId: string, percent: number) {
  await prisma.promotionCampaign.create({
    data: {
      id: `${P}-${id}`, kind: "FLASH_SALE", name: `Flash ${id}`, discountType: "PERCENTAGE", percentageValue: percent,
      startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST, targets: { create: [{ productId }] },
    },
  });
}
async function benefits(seed: Seed, quantities: number[], extra: Parameters<typeof repository.getQuote>[0] extends infer T ? Partial<T> : never = {}) {
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, quantities), now: NOW, env: ON, ...extra });
  assert.ok(quote.benefits.enabled && quote.benefits.ok, show(quote.benefits));
  return quote.benefits as Extract<typeof quote.benefits, { enabled: true; ok: true }>;
}

/* ---------------------------------------------------------------- the schema's own refusals */

type Data = Parameters<typeof prisma.giftQuantityCampaign.create>[0]["data"];
const base = (id: string, overrides: Record<string, unknown>): Data => ({
  id: `${P}-${id}`, kind: "QUANTITY_TIER", name: `${P} ${id}`, startsAt: PAST, endsAt: FUTURE,
  scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], tierBasis: "ORDER_SUBTOTAL", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
  ...overrides,
}) as Data;

test("schema: the valid shapes are accepted, including a total off the order and the old null-basis ladder", async () => {
  await prisma.giftQuantityCampaign.create({ data: base("pct", { tiers: { create: [{ minQuantity: 1_000_000, discountValue: 5 }, { minQuantity: 2_000_000_000, discountValue: 99 }] } }) });
  await prisma.giftQuantityCampaign.create({ data: base("total", { tierUnit: "FIXED_AMOUNT_TOTAL_VND", tiers: { create: [{ minQuantity: 3_000_000, discountValue: 200_000 }] } }) });
  // A ladder written before the basis existed: no basis, a real scope, a per-unit amount.
  await prisma.giftQuantityCampaign.create({
    data: base("legacy", { tierBasis: null, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: { create: [{ minQuantity: 3, discountValue: 20_000 }] } }),
  });
  assert.equal(await prisma.quantityTier.count({ where: { campaignId: { startsWith: `${P}-` } } }), 4);
});

test("schema: an order-value ladder is global and a global scope belongs to nothing else of tier kind", async () => {
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("dyn", { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"] }) }), /constraint|violat/i);
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("qty-global", { tierBasis: null }) }), /constraint|violat/i, "a quantity ladder cannot be global");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("qty-global2", { tierBasis: "QUANTITY" }) }), /constraint|violat/i);
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("glob-cats", { categoryKeys: ["vayDam"] }) }), /constraint|violat/i, "global carries no categories");
});

test("schema: the basis belongs to a tier campaign and fixes which units and slices it may hold", async () => {
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("gift-basis", { kind: "GIFT_ITEM", giftTrigger: "QUANTITY", minimumQuantity: 2, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: null, tierDiscountedUnits: null }) }), /constraint|violat/i, "a gift row cannot carry a basis");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("per-unit", { tierUnit: "FIXED_AMOUNT_PER_UNIT_VND" }) }), /constraint|violat/i, "a per-unit amount is a quantity idea");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("total-on-qty", { tierBasis: "QUANTITY", scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "FIXED_AMOUNT_TOTAL_VND" }) }), /constraint|violat/i, "a total is an order-value idea");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("total-on-null", { tierBasis: null, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierUnit: "FIXED_AMOUNT_TOTAL_VND" }) }), /constraint|violat/i, "an unset basis is a quantity ladder");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("from", { tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "CHEAPEST_FIRST" }) }), /constraint|violat/i, "no slice of an order value");
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("selection", { tierSelectionPriority: "CHEAPEST_FIRST" }) }), /constraint|violat/i);
});

test("schema: a total off the order stays below the order value that earns it, and thresholds stop at two billion", async () => {
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("total-eq", { tierUnit: "FIXED_AMOUNT_TOTAL_VND", tiers: { create: [{ minQuantity: 500_000, discountValue: 500_000 }] } }) }), /constraint|violat/i);
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("total-gt", { tierUnit: "FIXED_AMOUNT_TOTAL_VND", tiers: { create: [{ minQuantity: 500_000, discountValue: 600_000 }] } }) }), /constraint|violat/i);
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("too-high", { tiers: { create: [{ minQuantity: 2_000_000_001, discountValue: 5 }] } }) }), /constraint|violat/i);
  await assert.rejects(prisma.giftQuantityCampaign.create({ data: base("pct-100", { tiers: { create: [{ minQuantity: 1_000_000, discountValue: 100 }] } }) }), /constraint|violat/i);
});

/* ---------------------------------------------------------------- admin write path */

const orderRule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  basis: "ORDER_SUBTOTAL", unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 1_000_000, discountValue: 5 }, { minQuantity: 2_000_000, discountValue: 10 }],
  stackingEnabled: false, stackPriority: null, peers: [], ...overrides,
});
const quantityRule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 3, discountValue: 10 }], stackingEnabled: false, stackPriority: null, peers: [], ...overrides,
});
const orderValues = (name: string, tierRule: TierRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}): GiftQuantityDraftValues => ({
  kind: "QUANTITY_TIER", name: `${P} ${name}`, startsAt: START, endsAt: END, scopeMode: "GLOBAL_ALL_PAID_LINES",
  categoryKeys: [], includeProductIds: [], excludeProductIds: [], giftTrigger: null, subtotalScope: null, tierRule, ...overrides,
});
const quantityValues = (name: string, overrides: Partial<GiftQuantityDraftValues> = {}) =>
  orderValues(name, quantityRule(), { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], ...overrides });
const stored = (id: string) => prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id }, include: { tiers: { orderBy: { minQuantity: "asc" } } } });
const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item instanceof Map ? [...item] : item));
const reasonOf = (outcome: unknown) => ((outcome as { ok: boolean }).ok ? null : show((outcome as { failure: unknown }).failure));

async function createDraft(values: GiftQuantityDraftValues) {
  const outcome = await createDraftGiftQuantityCampaign({ values, session: ADMIN });
  assert.equal(outcome.ok, true, show(outcome));
  return (outcome as Extract<typeof outcome, { ok: true }>).campaignId;
}

test("admin: an order-value Draft persists its basis, unit, whole-order scope and ladder", async () => {
  const id = await createDraft(orderValues("create", orderRule({ unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [{ minQuantity: 3_000_000, discountValue: 200_000 }] })));
  const row = await stored(id);
  assert.deepEqual([row.tierBasis, row.tierUnit, row.tierDiscountedUnits, row.scopeMode, row.categoryKeys], ["ORDER_SUBTOTAL", "FIXED_AMOUNT_TOTAL_VND", "ALL_ELIGIBLE_UNITS", "GLOBAL_ALL_PAID_LINES", []]);
  assert.deepEqual(row.tiers.map((tier) => [tier.minQuantity, tier.discountValue]), [[3_000_000, 200_000]]);
});

test("admin: a quantity Draft states its basis too, and a bare Draft with no rule leaves it unset", async () => {
  const quantity = await createDraft(quantityValues("qty"));
  assert.equal((await stored(quantity)).tierBasis, "QUANTITY");
  const bare = await createDraft(quantityValues("bare", { tierRule: null }));
  assert.equal((await stored(bare)).tierBasis, null, "unset reads as QUANTITY");
});

test("admin: the scope must match the basis, on create", async () => {
  const wrongScope = await createDraftGiftQuantityCampaign({ values: orderValues("bad-scope", orderRule(), { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"] }), session: ADMIN });
  assert.match(reasonOf(wrongScope)!, /ORDER_BASIS_NEEDS_GLOBAL_SCOPE/);
  const globalQuantity = await createDraftGiftQuantityCampaign({ values: orderValues("bad-global", quantityRule()), session: ADMIN });
  assert.match(reasonOf(globalQuantity)!, /GLOBAL_SCOPE_NOT_ALLOWED/);
  const noRule = await createDraftGiftQuantityCampaign({ values: orderValues("bad-bare", null), session: ADMIN });
  assert.match(reasonOf(noRule)!, /GLOBAL_SCOPE_NOT_ALLOWED/, "no rule means no basis to rest a global scope on");
  assert.equal(await prisma.giftQuantityCampaign.count({ where: { name: { startsWith: `${P} bad-` } } }), 0, "nothing was written");
});

test("admin: editing a Draft can move between bases, and the scope moves with it in one write", async () => {
  const id = await createDraft(quantityValues("switch"));
  const toOrder = await editDraftGiftQuantityCampaign({ campaignId: id, values: orderValues("switch", orderRule()), now: NOW, session: ADMIN });
  assert.equal(toOrder.ok, true, show(toOrder));
  let row = await stored(id);
  assert.deepEqual([row.tierBasis, row.scopeMode, row.categoryKeys, row.tiers.length], ["ORDER_SUBTOTAL", "GLOBAL_ALL_PAID_LINES", [], 2]);

  const back = await editDraftGiftQuantityCampaign({ campaignId: id, values: quantityValues("switch"), now: NOW, session: ADMIN });
  assert.equal(back.ok, true, show(back));
  row = await stored(id);
  assert.deepEqual([row.tierBasis, row.scopeMode, row.categoryKeys, row.tiers.map((tier) => tier.minQuantity)], ["QUANTITY", "DYNAMIC_CATEGORY", ["vayDam"], [3]]);
});

test("admin: a form with no tier fields cannot pull an order-value Draft out of its whole-order scope", async () => {
  const id = await createDraft(orderValues("keep", orderRule()));
  const refused = await editDraftGiftQuantityCampaign({ campaignId: id, values: quantityValues("keep", { tierRule: null }), now: NOW, session: ADMIN });
  assert.match(reasonOf(refused)!, /ORDER_BASIS_NEEDS_GLOBAL_SCOPE/);
  const row = await stored(id);
  assert.deepEqual([row.tierBasis, row.scopeMode], ["ORDER_SUBTOTAL", "GLOBAL_ALL_PAID_LINES"], "the stored campaign is untouched");
  const renamed = await editDraftGiftQuantityCampaign({ campaignId: id, values: orderValues("keep renamed", null), now: NOW, session: ADMIN });
  assert.equal(renamed.ok, true, show(renamed));
  assert.equal((await stored(id)).tiers.length, 2, "the stored ladder survives a form without tier fields");

  // ... and the other way round: a quantity Draft cannot be given the global scope by a form without tier fields.
  const quantity = await createDraft(quantityValues("keep-qty"));
  const stolen = await editDraftGiftQuantityCampaign({ campaignId: quantity, values: orderValues("keep-qty", null), now: NOW, session: ADMIN });
  assert.match(reasonOf(stolen)!, /GLOBAL_SCOPE_NOT_ALLOWED/);
  assert.equal((await stored(quantity)).scopeMode, "DYNAMIC_CATEGORY");
});

test("admin: copying keeps the basis, the unit and the ladder", async () => {
  const id = await createDraft(orderValues("original", orderRule({ unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [{ minQuantity: 3_000_000, discountValue: 200_000 }] })));
  const copy = await copyGiftQuantityCampaign({ campaignId: id, session: ADMIN });
  assert.equal(copy.ok, true, show(copy));
  const row = await stored((copy as Extract<typeof copy, { ok: true }>).campaignId);
  assert.deepEqual([row.tierBasis, row.tierUnit, row.scopeMode, row.tiers.map((tier) => tier.discountValue)], ["ORDER_SUBTOTAL", "FIXED_AMOUNT_TOTAL_VND", "GLOBAL_ALL_PAID_LINES", [200_000]]);
});

test("admin: an order-value Draft publishes, and the editor reads the basis back", async () => {
  const id = await createDraft(orderValues("publish", orderRule()));
  const published = await publishGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON });
  assert.equal(published.ok, true, show(published));
  assert.equal((await stored(id)).isEnabled, true);

  const admin = createGiftQuantityAdminRepository(prisma);
  const detail = await admin.getCampaignForEdit(id, NOW);
  assert.equal(detail?.tierRule?.basis, "ORDER_SUBTOTAL");
  const list = (await admin.listCampaigns({ now: NOW })).find((row) => row.id === id);
  assert.equal(list?.tierBasis, "ORDER_SUBTOTAL");
});

test("admin: an incomplete or contradictory order-value ladder does not publish", async () => {
  const noUnit = await createDraft(orderValues("no-unit", orderRule({ unit: null, tiers: [] })));
  assert.match(reasonOf(await publishGiftQuantityCampaign({ campaignId: noUnit, now: NOW, session: ADMIN, env: ON }))!, /TIER_CONFIG_INCOMPLETE/);
  assert.equal((await stored(noUnit)).isEnabled, false);
});

test("admin: once Scheduled, the ladder's values can change but what it counts and where it applies cannot", async () => {
  const id = await createDraft(orderValues("sched", orderRule()));
  assert.equal((await publishGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON })).ok, true);
  const before = await stored(id);

  const switched = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { tierRule: quantityRule() } });
  assert.match(reasonOf(switched)!, /TIER_BASIS_NOT_EDITABLE_WHEN_SCHEDULED/);

  const moved = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { scope: { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [] } },
  });
  assert.match(reasonOf(moved)!, /ORDER_BASIS_NEEDS_GLOBAL_SCOPE/);
  assert.deepEqual([(await stored(id)).tierBasis, (await stored(id)).scopeMode, (await stored(id)).revision], ["ORDER_SUBTOTAL", "GLOBAL_ALL_PAID_LINES", before.revision], "refused edits change nothing");

  const reladdered = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { tierRule: orderRule({ tiers: [{ minQuantity: 1_500_000, discountValue: 7 }] }) },
  });
  assert.equal(reladdered.ok, true, show(reladdered));
  const after = await stored(id);
  assert.deepEqual(after.tiers.map((tier) => [tier.minQuantity, tier.discountValue]), [[1_500_000, 7]]);
  assert.equal(after.revision, before.revision + 1, "a real change to what a buyer pays is a new revision");
  assert.equal(after.tierBasis, "ORDER_SUBTOTAL");
});

/* ---------------------------------------------------------------- the quote */

test("quote: a percentage rung applies once the paid order value reaches it, and the campaign is named", async () => {
  const seed = await seedProduct("pct", [520_000, 500_000]);
  await orderCampaign({ id: "pct", tiers: [[1_000_000, 5], [2_000_000, 10]], name: "Đơn từ 1 triệu giảm 5%" });

  const below = await benefits(seed, [1, 1]); // 1.020.000 reaches the first rung
  assert.equal(below.subtotalVnd, 520_000 * 0.95 + 500_000 * 0.95);
  assert.deepEqual([...below.campaignNames], [[`${P}-pct`, "Đơn từ 1 triệu giảm 5%"]]);
  assert.ok(below.groups.every((group) => group.steps.some((step) => step.source === "QUANTITY_TIER" && step.campaignId === `${P}-pct`)));

  const second = await benefits(seed, [2, 2]); // 2.040.000 reaches the 10 % rung
  assert.equal(second.subtotalVnd, 2 * 468_000 + 2 * 450_000);

  const under = await benefits(await seedProduct("pct-under", [400_000]), [2]); // 800.000: no rung
  assert.equal(under.subtotalVnd, 800_000);
  assert.deepEqual(under.groups.flatMap((group) => group.steps), []);
});

test("quote: a fixed total comes off the order exactly once and splits by price", async () => {
  const seed = await seedProduct("total", [100_000, 250_000]);
  await orderCampaign({ id: "total", unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [[500_000, 100_000]] });
  const quote = await benefits(seed, [3, 1]); // 550.000
  assert.equal(quote.subtotalVnd, 450_000);
  const saved = quote.groups.flatMap((group) => group.steps).filter((step) => step.source === "QUANTITY_TIER").reduce((sum, step) => sum + (step.inputPriceVnd - step.outputPriceVnd) * step.appliedQuantity, 0);
  assert.equal(saved, 100_000);
  const keys = quote.groups.map((group) => group.groupKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(quote.groups.every((group) => group.lineKey === seed.variantIds[0] || group.lineKey === seed.variantIds[1]), "every segment keeps its cart line key");
});

test("quote: the threshold is judged after a Flash Sale, and only when the two agreed to stack", async () => {
  const seed = await seedProduct("flash", [520_000]);
  await flash("flash", seed.productId, 10); // 468.000 each
  await orderCampaign({ id: "flash-order", tiers: [[900_000, 10]], stackingEnabled: true, stackPriority: 2, peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] });
  const consents = { readLegacyConsents: async () => new Map([[`${P}-flash`, { priority: 1 }]]) };

  // 2 × 468.000 = 936.000 >= 900.000: reached after the sale, so 10 % more comes off.
  const stacked = await benefits(seed, [2], consents);
  assert.equal(stacked.subtotalVnd, 2 * 421_200);
  // 1 × 468.000 < 900.000 although 520.000 x ... the list price would not reach it either; use 2 units list price 1.040.000 vs sale 936.000
  const alone = await benefits(seed, [1], consents);
  assert.equal(alone.subtotalVnd, 468_000);

  // Same cart, no consent: the new campaign steps aside and the running Flash Sale is untouched.
  const refused = await benefits(seed, [2]);
  assert.equal(refused.subtotalVnd, 2 * 468_000);
  assert.deepEqual(refused.dropped.map((entry) => [entry.campaignId, entry.reason]), [[`${P}-flash-order`, "STACK_NOT_PERMITTED"]]);
});

test("quote: the sale price decides the rung, so a cart that is over the line only at list price does not earn it", async () => {
  const seed = await seedProduct("rung", [520_000]);
  await flash("rung", seed.productId, 10);
  await orderCampaign({ id: "rung-order", tiers: [[1_000_000, 10]], stackingEnabled: true, stackPriority: 2, peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] });
  // 2 × 520.000 = 1.040.000 at list price, but 2 × 468.000 = 936.000 after the sale: under 1.000.000.
  const quote = await benefits(seed, [2], { readLegacyConsents: async () => new Map([[`${P}-rung`, { priority: 1 }]]) });
  assert.equal(quote.subtotalVnd, 936_000);
  assert.ok(quote.groups.every((group) => group.steps.every((step) => step.source === "LEGACY")));
  assert.deepEqual(quote.dropped, []);
});

test("quote: a total that would take a unit under 1 ₫ is dropped whole and reported, never clamped", async () => {
  const seed = await seedProduct("tiny", [1, 999_999]);
  await orderCampaign({ id: "tiny", unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [[1_000_000, 999_999]] });
  const quote = await benefits(seed, [1, 1]);
  assert.equal(quote.subtotalVnd, 1_000_000);
  assert.deepEqual(quote.dropped.map((entry) => [entry.campaignId, entry.reason]), [[`${P}-tiny`, "TIER_PRICE_INVALID"]]);
});

test("quote: a quantity ladder and an order-value ladder that agreed to stack both apply, the order value last", async () => {
  const seed = await seedProduct("both", [400_000]);
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-qty`, kind: "QUANTITY_TIER", name: `${P} qty`, startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["vayDam"], tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      stackingEnabled: true, stackPriority: 1, tiers: { create: [{ minQuantity: 3, discountValue: 10 }] },
      stackPeers: { create: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "*" }] },
    },
  });
  await orderCampaign({ id: "both-order", tiers: [[1_000_000, 10]], stackingEnabled: true, stackPriority: 2, peers: [{ peerKind: "QUANTITY_TIER", peerCampaignId: "*" }] });
  // 3 × 400.000 = 1.200.000 -> quantity 10 % = 360.000 each (1.080.000) -> still >= 1.000.000 -> order 10 % = 324.000 each.
  const quote = await benefits(seed, [3]);
  assert.equal(quote.subtotalVnd, 3 * 324_000);
  const steps = quote.groups.flatMap((group) => group.steps.map((step) => step.campaignId));
  assert.deepEqual([...new Set(steps)], [`${P}-qty`, `${P}-both-order`], "the order-value ladder is applied last");
});

test("quote: gate OFF changes nothing for an order-value campaign (no read, legacy lines)", async () => {
  const seed = await seedProduct("off", [600_000]);
  await orderCampaign({ id: "off", tiers: [[500_000, 50]] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: {} });
  assert.deepEqual(quote.benefits, { enabled: false });
  assert.equal(quote.lines[0]!.price, 600_000);
});

/* ---------------------------------------------------------------- progress to the next rung */

test("progress: under the first rung the quote says how much is missing, and what the rung would take off", async () => {
  const seed = await seedProduct("prog", [400_000]);
  await orderCampaign({ id: "prog", tiers: [[1_000_000, 5], [2_000_000, 10]] });
  const quote = await benefits(seed, [2]); // 800.000
  assert.deepEqual(quote.orderValueProgress.map((p) => [p.campaignId, p.currentVnd, p.reachedThresholdVnd, p.next.thresholdVnd, p.next.unit, p.next.value, p.next.shortfallVnd]), [
    [`${P}-prog`, 800_000, null, 1_000_000, "PERCENTAGE", 5, 200_000],
  ]);
});

test("progress: once a rung applies the next one is offered, measured from the value the ladder was judged on", async () => {
  const seed = await seedProduct("prog2", [520_000, 500_000]);
  await orderCampaign({ id: "prog2", tiers: [[1_000_000, 5], [2_000_000, 10]] });
  const quote = await benefits(seed, [1, 1]); // 1.020.000 reaches the first rung (5 % applied)
  assert.equal(quote.subtotalVnd, 969_000);
  const [progress] = quote.orderValueProgress;
  assert.deepEqual([progress!.currentVnd, progress!.reachedThresholdVnd, progress!.next.thresholdVnd, progress!.next.shortfallVnd], [1_020_000, 1_000_000, 2_000_000, 980_000],
    "the shortfall is on the value BEFORE this ladder's own discount, which is what the next rung is judged on");
});

test("progress: nothing is offered on the top rung", async () => {
  const seed = await seedProduct("prog3", [3_000_000]);
  await orderCampaign({ id: "prog3", tiers: [[1_000_000, 5], [2_000_000, 10]] });
  assert.deepEqual((await benefits(seed, [1])).orderValueProgress, []);
});

test("progress: a ladder that would be set aside by a running Flash Sale is never advertised", async () => {
  const seed = await seedProduct("prog4", [400_000]);
  await flash("prog4-flash", seed.productId, 10);
  await orderCampaign({ id: "prog4", tiers: [[1_000_000, 5]], stackingEnabled: true, stackPriority: 2, peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] });
  // No consent from the Flash Sale: when the cart reached 1.000.000 the ladder would be dropped.
  const refused = await benefits(seed, [2]);
  assert.deepEqual(refused.orderValueProgress, [], "promising it would be a promise the checkout breaks");
  assert.deepEqual(refused.dropped, [], "and it was not dropped, because it never took part while idle");
  // With the consent it will apply, so the nudge is honest.
  const agreed = await benefits(seed, [2], { readLegacyConsents: async () => new Map([[`${P}-prog4-flash`, { priority: 1 }]]) });
  assert.deepEqual(agreed.orderValueProgress.map((p) => p.next.shortfallVnd), [1_000_000 - 2 * 360_000]);
});

test("progress: gate OFF has no progress field to read", async () => {
  const seed = await seedProduct("prog5", [400_000]);
  await orderCampaign({ id: "prog5", tiers: [[1_000_000, 5]] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [2]), now: NOW, env: {} });
  assert.deepEqual(quote.benefits, { enabled: false });
});

test("progress: a ladder is measured on the price just before ITS step, even for units it allocated 0 ₫ and a later ladder then cut", async () => {
  // 40 × 1.000 + 1 × 10.000 = 50.000. Ladder A (first): 1 ₫ off from 40.000, 2 ₫ from 60.000; the single ₫ lands on
  // the 10.000 unit, so the 1.000 units get no step of A's own. Ladder B (second) then halves them.
  const seed = await seedProduct("zero", [1_000, 10_000]);
  const peers = [{ peerKind: "QUANTITY_TIER" as const, peerCampaignId: "*" }];
  await orderCampaign({ id: "zero-a", unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [[40_000, 1], [60_000, 2]], stackingEnabled: true, stackPriority: 1, peers });
  await orderCampaign({ id: "zero-b", tiers: [[40_000, 50]], stackingEnabled: true, stackPriority: 2, peers });
  const quote = await benefits(seed, [40, 1]);
  const a = quote.orderValueProgress.find((entry) => entry.campaignId === `${P}-zero-a`);
  assert.ok(a, "A is on its first rung, so the next one is offered");
  assert.deepEqual([a.currentVnd, a.reachedThresholdVnd, a.next.thresholdVnd, a.next.shortfallVnd], [50_000, 40_000, 60_000, 10_000]);
});
