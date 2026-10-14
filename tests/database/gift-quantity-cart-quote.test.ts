import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS, type GiftQuantityCandidateReadClient } from "../../src/commerce/gift-quantity-candidate-repository.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }), log: [{ emit: "event", level: "query" }] });
let queryCount = 0;
(prisma as unknown as { $on: (event: string, handler: () => void) => void }).$on("query", () => {
  queryCount += 1;
});
const repository = createStorefrontCartRepository(prisma);

const SHOP = 910_070;
const P = "gq08";
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const LEGACY_ON_ONLY = { LA_PROMOTION_ACTIVATION_ENABLED: "true" } as const;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const PAST = new Date("2026-10-01T00:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const syncedAt = new Date("2026-10-01T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

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

type TierOptions = {
  id: string;
  unit?: "PERCENTAGE" | "FIXED_AMOUNT_PER_UNIT_VND";
  discountedUnits?: "ALL_ELIGIBLE_UNITS" | "FROM_REACHED_THRESHOLD";
  selectionPriority?: "CHEAPEST_FIRST" | "MOST_EXPENSIVE_FIRST" | null;
  tiers: Array<[number, number]>;
  categoryKeys?: string[];
  startsAt?: Date | null;
  endsAt?: Date | null;
  isEnabled?: boolean;
  stackPriority?: number | null;
  stackingEnabled?: boolean;
  peers?: Array<{ peerKind: "PROMOTION" | "FLASH_SALE" | "CLEARANCE" | "QUANTITY_TIER"; peerCampaignId: string }>;
};

async function tierCampaign(o: TierOptions) {
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-${o.id}`, kind: "QUANTITY_TIER", name: `Tier ${o.id}`,
      startsAt: o.startsAt === undefined ? PAST : o.startsAt, endsAt: o.endsAt === undefined ? FUTURE : o.endsAt,
      isEnabled: o.isEnabled ?? true, enabledAt: PAST, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: o.categoryKeys ?? ["vayDam"],
      tierUnit: o.unit ?? "PERCENTAGE", tierDiscountedUnits: o.discountedUnits ?? "ALL_ELIGIBLE_UNITS",
      tierSelectionPriority: o.selectionPriority === undefined ? null : o.selectionPriority,
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

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

const items = (seed: Seed, quantities: number[]) => seed.variantIds.map((variantId, index) => ({ variantId, quantity: quantities[index] ?? 1 }));

test("gate OFF: benefits are disabled and lines equal getLines, even with an active tier and legacy activation ON", async () => {
  const seed = await seedProduct("off", [500_000, 500_000, 500_000]);
  await tierCampaign({ id: "off-tier", tiers: [[2, 10]] });
  const cart = items(seed, [1, 1, 1]);
  const legacyLines = await repository.getLines({ shopId: SHOP, items: cart, now: NOW });
  for (const env of [{}, LEGACY_ON_ONLY, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "TRUE" }]) {
    const quote = await repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env });
    assert.deepEqual(quote.benefits, { enabled: false });
    assert.deepEqual(quote.lines, legacyLines);
  }
});

test("gate OFF reads no gift/quantity tables at all", async () => {
  const seed = await seedProduct("off-reads", [500_000]);
  await tierCampaign({ id: "off-reads-tier", tiers: [[1, 10]] });
  const spy = new Proxy({}, { get: () => { throw new Error("gift/quantity tables must not be read while OFF"); } });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: {}, giftClient: spy as never });
  assert.deepEqual(quote.benefits, { enabled: false });
});

test("gate ON: EX-17 tier FROM threshold splits one variant into two paid price segments, total 290.003", async () => {
  const seed = await seedProduct("ex17", [100_001]);
  await tierCampaign({ id: "ex17-tier", unit: "PERCENTAGE", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", tiers: [[3, 10]] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [3]), now: NOW, env: ON });
  assert.equal(quote.benefits.enabled && quote.benefits.ok, true);
  if (!quote.benefits.enabled || !quote.benefits.ok) return;
  assert.deepEqual(quote.benefits.groups.map((group) => [group.quantity, group.unitPriceVnd, group.pancakeVariationId]), [
    [1, 90_001, `${P}-ex17-v0`], [2, 100_001, `${P}-ex17-v0`],
  ]);
  assert.equal(quote.benefits.subtotalVnd, 290_003);
  assert.equal(quote.benefits.campaignRevisions.get(`${P}-ex17-tier`), 1);
  assert.deepEqual(quote.benefits.dropped, []);
  // the legacy per-variant line price is untouched: no tier price is ever put on a variant
  assert.equal(quote.lines[0]!.price, 100_001);
});

test("changing the quantity re-derives the tier from authoritative facts (below, at and above the threshold)", async () => {
  const seed = await seedProduct("qty", [500_000, 500_000]);
  await tierCampaign({ id: "qty-tier", tiers: [[3, 10]] });
  const subtotal = async (quantities: number[]) => {
    const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, quantities), now: NOW, env: ON });
    assert.ok(quote.benefits.enabled && quote.benefits.ok);
    return quote.benefits.enabled && quote.benefits.ok ? quote.benefits.subtotalVnd : -1;
  };
  assert.equal(await subtotal([1, 1]), 1_000_000, "Q=2 < 3");
  assert.equal(await subtotal([2, 1]), 3 * 450_000, "Q=3 across two variants of one product");
  assert.equal(await subtotal([3, 2]), 5 * 450_000, "Q=5, ALL units");
});

test("only ACTIVE campaigns apply: Scheduled, Disabled, Ended and out-of-scope categories do not", async () => {
  const seed = await seedProduct("states", [500_000, 500_000]);
  await tierCampaign({ id: "scheduled", tiers: [[1, 50]], startsAt: FUTURE, endsAt: null });
  await tierCampaign({ id: "disabled", tiers: [[1, 50]], isEnabled: false });
  await tierCampaign({ id: "ended", tiers: [[1, 50]], startsAt: PAST, endsAt: new Date("2026-10-02T00:00:00Z") });
  await tierCampaign({ id: "other-category", tiers: [[1, 50]], categoryKeys: ["phuKien"] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1, 1]), now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  assert.equal(quote.benefits.enabled && quote.benefits.ok && quote.benefits.subtotalVnd, 1_000_000);
});

test("EX-09 through the repository: Flash 10% then a consenting tier 5% = 855.000; without consent the tier steps aside", async () => {
  const seed = await seedProduct("stack", [1_000_000]);
  await flash("stack-flash", seed.productId, 10);
  await tierCampaign({
    id: "stack-tier", tiers: [[1, 5]], stackPriority: 2, stackingEnabled: true,
    peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }],
  });
  const withConsent = await repository.getQuote({
    shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON,
    readLegacyConsents: async () => new Map([[`${P}-stack-flash`, { priority: 1 }]]),
  });
  assert.ok(withConsent.benefits.enabled && withConsent.benefits.ok);
  assert.equal(withConsent.benefits.enabled && withConsent.benefits.ok && withConsent.benefits.subtotalVnd, 855_000);

  const without = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON });
  assert.ok(without.benefits.enabled && without.benefits.ok);
  if (without.benefits.enabled && without.benefits.ok) {
    assert.equal(without.benefits.subtotalVnd, 900_000, "legacy Flash price is untouched");
    assert.deepEqual(without.benefits.dropped, [{ campaignId: `${P}-stack-tier`, reason: "STACK_NOT_PERMITTED", otherCampaignId: `${P}-stack-flash` }]);
  }
  assert.equal(without.lines[0]!.price, 900_000);
});

test("EX-21 runtime: a VND tier that sync/flash left no room for is dropped whole and reported, never clamped", async () => {
  const seed = await seedProduct("ex21", [44_444]);
  await flash("ex21-flash", seed.productId, 10);
  await tierCampaign({
    id: "ex21-tier", unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [[1, 50_000]], stackPriority: 2, stackingEnabled: true,
    peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }],
  });
  const quote = await repository.getQuote({
    shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON,
    readLegacyConsents: async () => new Map([[`${P}-ex21-flash`, { priority: 1 }]]),
  });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  if (quote.benefits.enabled && quote.benefits.ok) {
    assert.equal(quote.benefits.subtotalVnd, 40_000);
    assert.deepEqual(quote.benefits.dropped, [{ campaignId: `${P}-ex21-tier`, reason: "TIER_PRICE_INVALID", otherCampaignId: null }]);
  }
});

test("lines that cannot be bought take no part in the paid quote", async () => {
  const seed = await seedProduct("unavail", [500_000, 500_000]);
  await prisma.variantMirror.update({ where: { id: seed.variantIds[1]! }, data: { isActive: false } });
  await tierCampaign({ id: "unavail-tier", tiers: [[2, 10]] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1, 1]), now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  if (quote.benefits.enabled && quote.benefits.ok) {
    assert.equal(quote.benefits.groups.length, 1);
    assert.equal(quote.benefits.subtotalVnd, 500_000, "Q=1: the unavailable second unit does not reach the threshold");
  }
});

test("too many active campaigns fails closed instead of silently dropping some", async () => {
  const seed = await seedProduct("bound", [500_000]);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","isEnabled","enabledAt","scopeMode","categoryKeys","tierUnit","tierDiscountedUnits","updatedAt")
     SELECT $1 || i, 'QUANTITY_TIER', 'bulk', TRUE, NOW() - interval '1 day', 'DYNAMIC_CATEGORY', ARRAY['vayDam']::text[], 'PERCENTAGE', 'ALL_ELIGIBLE_UNITS', NOW()
     FROM generate_series(1, $2::int) AS i`,
    `${P}-bulk-`, MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS + 1,
  );
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON });
  assert.deepEqual(quote.benefits, { enabled: true, ok: false, reason: "LOOKUP_FAILED" });
});

test("the number of statements does not grow with the number of products or lines (no N+1)", async () => {
  await tierCampaign({ id: "n1-tier", tiers: [[2, 10]] });
  const small = await seedProduct("n1-a", [500_000]);
  queryCount = 0;
  await repository.getQuote({ shopId: SHOP, items: items(small, [2]), now: NOW, env: ON });
  const oneProduct = queryCount;
  assert.ok(oneProduct > 0, "the statement counter is wired");

  const many = await Promise.all(["b", "c", "d", "e"].map((suffix) => seedProduct(`n1-${suffix}`, [400_000, 410_000, 420_000])));
  const cart = [small, ...many].flatMap((seed) => items(seed, [1, 1, 1]));
  queryCount = 0;
  await repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env: ON });
  assert.equal(queryCount, oneProduct, `statements for 5 products/13 lines (${queryCount}) must equal 1 product/1 line (${oneProduct})`);
});

test("an empty cart yields no lines; benefits follow the gate (OFF disabled, ON an empty valid quote)", async () => {
  const off = await repository.getQuote({ shopId: SHOP, items: [], now: NOW, env: {} });
  assert.deepEqual(off, { lines: [], benefits: { enabled: false } });
  const on = await repository.getQuote({ shopId: SHOP, items: [], now: NOW, env: ON });
  assert.deepEqual(on.lines, []);
  assert.ok(on.benefits.enabled && on.benefits.ok);
  assert.equal(on.benefits.enabled && on.benefits.ok && on.benefits.subtotalVnd, 0);
});

test("OFF parity: the quote's lines are byte-for-byte getLines and cost exactly the same statements, with active tier and legacy campaigns present", async () => {
  const seed = await seedProduct("parity", [1_000_000, 250_000, 99_999]);
  await flash("parity-flash", seed.productId, 10);
  await tierCampaign({ id: "parity-tier", tiers: [[2, 10]], stackPriority: 2, stackingEnabled: true, peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] });
  await prisma.variantMirror.update({ where: { id: seed.variantIds[2]! }, data: { isActive: false } });
  const cart = [...items(seed, [2, 3, 1]), { variantId: "does-not-exist", quantity: 1 }];

  queryCount = 0;
  const legacy = await repository.getLines({ shopId: SHOP, items: cart, now: NOW });
  const legacyStatements = queryCount;
  for (const env of [{}, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "false" }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }, LEGACY_ON_ONLY]) {
    queryCount = 0;
    const quote = await repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env });
    assert.equal(queryCount, legacyStatements, "OFF issues exactly the legacy statements");
    assert.equal(JSON.stringify(quote.lines), JSON.stringify(legacy));
    assert.deepEqual(quote.benefits, { enabled: false });
  }
  // and ON leaves the very same legacy lines in place: the tier is a separate result, never a line price
  const on = await repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env: ON });
  assert.equal(JSON.stringify(on.lines), JSON.stringify(legacy));
  assert.ok(on.benefits.enabled && on.benefits.ok);
});

test("no cart-tier price leaks into the PDP or listing projections, with the gate ON and an active tier", async () => {
  const seed = await seedProduct("leak", [500_000, 500_000]);
  const detail = createStorefrontProductDetailRepository(prisma);
  const catalog = createStorefrontCatalogRepository(prisma);
  const read = async () => JSON.stringify({
    detail: await detail.getProductBySlug({ shopId: SHOP, slug: `${P}-leak`, now: NOW }),
    listing: await catalog.getProductBySlug({ shopId: SHOP, slug: `${P}-leak` }),
  });
  const before = await read();
  await tierCampaign({ id: "leak-tier", tiers: [[1, 50]] });
  const original = process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED;
  process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED = "true";
  try {
    assert.equal(await read(), before, "PDP/listing money is independent of any quantity tier");
  } finally {
    if (original === undefined) delete process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED;
    else process.env.LA_GIFT_QUANTITY_PROMOTIONS_ENABLED = original;
  }
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1, 1]), now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  assert.equal(quote.benefits.enabled && quote.benefits.ok && quote.benefits.subtotalVnd, 500_000, "the tier applies only in the cart quote");
});

const INPUT_INVALID = { enabled: true, ok: false, reason: "INPUT_INVALID" } as const;

test("invalid raw items refuse the whole quote even when availability would hide the defect", async () => {
  const seed = await seedProduct("dup", [500_000, 500_000]);
  await tierCampaign({ id: "dup-tier", tiers: [[1, 10]] });
  const [v, w] = seed.variantIds as [string, string];
  // stock V = 1: the second duplicate row resolves as INSUFFICIENT_STOCK and used to just drop out
  await prisma.warehouseStock.updateMany({ where: { variantId: v }, data: { quantity: 1 } });
  const quote = (cart: Array<{ variantId: string; quantity: number }>) => repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env: ON });

  for (const cart of [
    [{ variantId: v, quantity: 1 }, { variantId: v, quantity: 2 }],      // second row unavailable
    [{ variantId: w, quantity: 1 }, { variantId: w, quantity: 1 }],      // both rows would be available
    [{ variantId: w, quantity: 0 }],
    [{ variantId: w, quantity: -1 }],
    [{ variantId: w, quantity: 1.5 }],
    [{ variantId: w, quantity: 1 }, { variantId: v, quantity: 0 }],
    [{ variantId: "bad|key", quantity: 1 }],
    Array.from({ length: 51 }, (_, i) => ({ variantId: `x${i}`, quantity: 1 })),
  ]) {
    const result = await quote(cart);
    assert.deepEqual(result.benefits, INPUT_INVALID);
    assert.deepEqual(result.lines, [], "nothing is resolved for refused input");
  }

  // a single unavailable line WITHOUT a duplicate keeps the existing contract: it is simply not priced
  const single = await quote([{ variantId: w, quantity: 1 }, { variantId: v, quantity: 2 }]);
  assert.ok(single.benefits.enabled && single.benefits.ok);
  if (single.benefits.enabled && single.benefits.ok) {
    assert.equal(single.benefits.groups.length, 1);
    assert.equal(single.benefits.subtotalVnd, 450_000);
  }
  // and gate OFF is still exactly getLines for the same raw (even duplicate) items
  const raw = [{ variantId: v, quantity: 1 }, { variantId: v, quantity: 2 }];
  const off = await repository.getQuote({ shopId: SHOP, items: raw, now: NOW, env: {} });
  assert.equal(JSON.stringify(off.lines), JSON.stringify(await repository.getLines({ shopId: SHOP, items: raw, now: NOW })));
  assert.deepEqual(off.benefits, { enabled: false });
});

test("read failures through the repository resolve to LOOKUP_FAILED, never a throw or a legacy-priced paid quote", async () => {
  const seed = await seedProduct("fail", [1_000_000]);
  await flash("fail-flash", seed.productId, 10);
  await tierCampaign({ id: "fail-tier", tiers: [[1, 5]], stackPriority: 2, stackingEnabled: true, peers: [{ peerKind: "FLASH_SALE", peerCampaignId: "*" }] });
  const boom = () => Promise.reject(new Error("connection reset"));
  const real = prisma as unknown as GiftQuantityCandidateReadClient;
  const clients: GiftQuantityCandidateReadClient[] = [
    { ...real, giftQuantityCampaign: { findMany: boom } },
    { ...real, productCategoryMembership: { findMany: boom } },
  ];
  const LOOKUP_FAILED = { enabled: true, ok: false, reason: "LOOKUP_FAILED" };
  for (const giftClient of clients) {
    const result = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON, giftClient });
    assert.deepEqual(result.benefits, LOOKUP_FAILED);
  }
  const consentDown = await repository.getQuote({
    shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON,
    readLegacyConsents: async () => { throw new Error("consent store down"); },
  });
  assert.deepEqual(consentDown.benefits, LOOKUP_FAILED);

  // gate OFF never touches the reader or the gift client
  let calls = 0;
  const off = await repository.getQuote({
    shopId: SHOP, items: items(seed, [1]), now: NOW, env: {},
    giftClient: new Proxy({}, { get: () => { throw new Error("must not read"); } }) as never,
    readLegacyConsents: async () => { calls += 1; return new Map(); },
  });
  assert.deepEqual(off.benefits, { enabled: false });
  assert.equal(calls, 0);
});

test("a cart of only unpurchasable lines yields an empty valid quote", async () => {
  const seed = await seedProduct("none", [500_000]);
  await prisma.variantMirror.update({ where: { id: seed.variantIds[0]! }, data: { isActive: false } });
  await tierCampaign({ id: "none-tier", tiers: [[1, 10]] });
  const quote = await repository.getQuote({ shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  if (quote.benefits.enabled && quote.benefits.ok) {
    assert.deepEqual(quote.benefits.groups, []);
    assert.equal(quote.benefits.subtotalVnd, 0);
  }
});

test("a Fixed-set tier applies only to the products frozen at publish, and a product outside the set stays at its price", async () => {
  const inSet = await seedProduct("fixed-in", [400_000]);
  const outSet = await seedProduct("fixed-out", [400_000]);
  await prisma.giftQuantityCampaign.create({
    data: {
      id: `${P}-fixed-tier`, kind: "QUANTITY_TIER", name: "Fixed", startsAt: PAST, endsAt: FUTURE, isEnabled: true, enabledAt: PAST,
      scopeMode: "FIXED_PRODUCT_SET", frozenAt: PAST, frozenCampaignRevision: 1,
      tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
      tiers: { create: [{ minQuantity: 1, discountValue: 25 }] },
      frozen: { create: [{ productId: inSet.productId }] },
    },
  });
  const quote = await repository.getQuote({ shopId: SHOP, items: [...items(inSet, [2]), ...items(outSet, [1])], now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  if (quote.benefits.enabled && quote.benefits.ok) {
    assert.equal(quote.benefits.subtotalVnd, 2 * 300_000 + 400_000);
    assert.equal(quote.benefits.groups.find((group) => group.lineKey === outSet.variantIds[0])!.unitPriceVnd, 400_000);
  }
});

test("derived group keys keep their source line key, so the cart's own line identity is never replaced", async () => {
  const seed = await seedProduct("keys", [100_001, 200_000]);
  await tierCampaign({ id: "keys-tier", discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", tiers: [[3, 10]] });
  const cart = items(seed, [2, 2]);
  const quote = await repository.getQuote({ shopId: SHOP, items: cart, now: NOW, env: ON });
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  if (!quote.benefits.enabled || !quote.benefits.ok) return;
  const lineIds = new Set(quote.lines.map((line) => line.variantId));
  for (const group of quote.benefits.groups) assert.ok(lineIds.has(group.lineKey), "every group maps back to a cart line");
  assert.ok(quote.benefits.groups.some((group) => group.groupKey.includes("|")), "the split produced derived keys");
  for (const variantId of seed.variantIds) {
    const quantity: number = quote.benefits.groups.filter((group) => group.lineKey === variantId).reduce((sum: number, group) => sum + group.quantity, 0);
    assert.equal(quantity, 2, "split segments add back to the line quantity");
  }
});

test("the legacy-consent reader is not consulted when no tier campaign is active", async () => {
  const seed = await seedProduct("noconsent", [1_000_000]);
  await flash("noconsent-flash", seed.productId, 10);
  let calls = 0;
  const quote = await repository.getQuote({
    shopId: SHOP, items: items(seed, [1]), now: NOW, env: ON,
    readLegacyConsents: async () => { calls += 1; return new Map(); },
  });
  assert.equal(calls, 0);
  assert.ok(quote.benefits.enabled && quote.benefits.ok);
  assert.equal(quote.benefits.enabled && quote.benefits.ok && quote.benefits.subtotalVnd, 900_000);
});
