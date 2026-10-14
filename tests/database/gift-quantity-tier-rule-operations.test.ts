import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { parseGiftQuantityDraftForm } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  disableGiftQuantityCampaign,
  editScheduledGiftQuantityCampaign,
  publishGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-activation-service.ts";
import type { GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-admin-service.ts";
import {
  clearLegacyPromotionStackConsent,
  setLegacyPromotionStackConsent,
} from "../../src/commerce/gift-quantity-legacy-consent.ts";
import type { TierRuleInput } from "../../src/commerce/gift-quantity-tier-rule.ts";
import {
  PROMOTION_REVISION_ID,
} from "../../src/commerce/promotion-activation-service.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq09";
const SHOP = 920_946;
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const NOW = new Date("2026-10-13T00:00:00.000Z");
const START = new Date("2026-10-20T00:00:00.000Z");
const END = new Date("2026-10-30T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "name" LIKE ${`${P}%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductCategoryMembership" WHERE "productId" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${P}-%`}`;
}

async function product(suffix: string, priceVnd: number | null, ...categoryKeys: string[]) {
  const id = `${P}-${suffix}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'GQ09 product',NOW(),NOW(),NOW())`,
    id, SHOP, `${id}-ext`, `${id}-slug`,
  );
  for (const key of categoryKeys) {
    await prisma.$executeRawUnsafe(`INSERT INTO "ProductCategoryMembership" ("productId","categoryKey") VALUES ($1,$2)`, id, key);
  }
  if (priceVnd !== null) {
    await prisma.variantMirror.create({
      data: { id: `${id}-v`, pancakeVariationId: `${id}-var`, productId: id, pancakeRetailPrice: priceVnd, syncedAt: NOW },
    });
  }
}

async function legacy(suffix: string, overrides: { isEnabled?: boolean; endsAt?: Date | null } = {}) {
  const id = `${P}-${suffix}`;
  await prisma.promotionCampaign.create({
    data: {
      id, kind: "PROMOTION", name: `${P} legacy ${suffix}`, discountType: "PERCENTAGE", percentageValue: 10,
      isEnabled: overrides.isEnabled ?? true, enabledAt: overrides.isEnabled === false ? null : new Date("2026-10-01T00:00:00Z"),
      startsAt: null, endsAt: overrides.endsAt ?? null,
    },
  });
  return id;
}

async function revision(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  return row?.revision ?? BigInt(-1);
}

const rule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 3, discountValue: 10 }, { minQuantity: 5, discountValue: 15 }],
  stackingEnabled: false, stackPriority: null, peers: [], ...overrides,
});
const values = (name: string, tierRule: TierRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}): GiftQuantityDraftValues => ({
  kind: "QUANTITY_TIER", name: `${P} ${name}`, startsAt: START, endsAt: END, scopeMode: "DYNAMIC_CATEGORY",
  categoryKeys: ["setVay"], includeProductIds: [], excludeProductIds: [], giftTrigger: null, subtotalScope: null, tierRule, ...overrides,
});
async function createTier(name: string, tierRule: TierRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}) {
  const outcome = await createDraftGiftQuantityCampaign({ values: values(name, tierRule, overrides), session: ADMIN });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as Extract<typeof outcome, { ok: true }>).campaignId;
}
const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
const stored = (id: string) =>
  prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id }, include: { tiers: { orderBy: { minQuantity: "asc" } }, stackPeers: true } });
const publish = (campaignId: string, now = NOW) => publishGiftQuantityCampaign({ campaignId, now, session: ADMIN, env: ON });

test.beforeEach(async () => {
  await cleanup();
  await product("a", 500_000, "setVay");
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("create: a tier Draft persists unit, selection, ladder, stacking and peers and moves no revision", async () => {
  const peer = await createTier("peer", rule());
  const before = await revision();
  const id = await createTier("main", rule({
    discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "MOST_EXPENSIVE_FIRST",
    stackingEnabled: true, stackPriority: 4, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }],
  }));
  const row = await stored(id);
  assert.equal(row.tierUnit, "PERCENTAGE");
  assert.equal(row.tierDiscountedUnits, "FROM_REACHED_THRESHOLD");
  assert.equal(row.tierSelectionPriority, "MOST_EXPENSIVE_FIRST");
  assert.deepEqual(row.tiers.map((t) => [t.minQuantity, t.discountValue]), [[3, 10], [5, 15]]);
  assert.equal(row.stackingEnabled, true);
  assert.equal(row.stackPriority, 4);
  assert.deepEqual(row.stackPeers.map((p) => [p.peerKind, p.peerCampaignId]), [["QUANTITY_TIER", peer]]);
  assert.equal(row.isEnabled, false);
  assert.equal(await revision(), before, "a Draft write is not effective");
});

test("create: an unfinished rule (no ladder yet) is a valid Draft; a malformed one writes nothing", async () => {
  await createTier("empty", { ...rule(), unit: null, tiers: [] });
  const count = () => prisma.giftQuantityCampaign.count({ where: { name: { startsWith: P } } });
  const before = await count();
  for (const bad of [
    rule({ tiers: [{ minQuantity: 3, discountValue: 100 }] }),
    rule({ tiers: [{ minQuantity: 3, discountValue: 5 }, { minQuantity: 3, discountValue: 6 }] }),
    rule({ selectionPriority: "CHEAPEST_FIRST" }),
    rule({ stackPriority: 2_000_000 }),
  ]) {
    const outcome = await createDraftGiftQuantityCampaign({ values: values("bad", bad), session: ADMIN });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.failure.reason, "INVALID_INPUT");
  }
  assert.equal(await count(), before, "refused input leaves no row behind");
});

test("create: a rule on a gift campaign is refused; peers must exist, match their kind and not be the campaign itself", async () => {
  const gift = await createDraftGiftQuantityCampaign({
    values: values("gift", rule(), { kind: "GIFT_ITEM", giftTrigger: "QUANTITY" }), session: ADMIN,
  });
  assert.equal(gift.ok, false);
  const legacyId = await legacy("leg");
  const unknown = await createDraftGiftQuantityCampaign({ values: values("u", rule({ peers: [{ kind: "QUANTITY_TIER", campaignId: "nope" }] })), session: ADMIN });
  assert.deepEqual(unknown.ok === false && unknown.failure.reason === "INVALID_INPUT" ? unknown.failure.errors : null, ["STACK_PEER_UNKNOWN"]);
  const wrongKind = await createDraftGiftQuantityCampaign({ values: values("w", rule({ peers: [{ kind: "FLASH_SALE", campaignId: legacyId }] })), session: ADMIN });
  assert.equal(wrongKind.ok, false);
  const fine = await createDraftGiftQuantityCampaign({ values: values("f", rule({ peers: [{ kind: "PROMOTION", campaignId: legacyId }] })), session: ADMIN });
  assert.equal(fine.ok, true);

  const id = await createTier("self", rule());
  const self = await editDraftGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, values: values("self", rule({ peers: [{ kind: "QUANTITY_TIER", campaignId: id }] })),
  });
  assert.deepEqual(self.ok === false && self.failure.reason === "INVALID_INPUT" ? self.failure.errors : null, ["STACK_PEER_SELF"]);
});

test("edit Draft: the whole rule is replaced, and switching FROM back to ALL drops the stale selection priority", async () => {
  const id = await createTier("edit", rule({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST" }));
  const outcome = await editDraftGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN,
    values: values("edit", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 20_000 }] })),
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const row = await stored(id);
  assert.equal(row.tierUnit, "FIXED_AMOUNT_PER_UNIT_VND");
  assert.equal(row.tierSelectionPriority, null);
  assert.deepEqual(row.tiers.map((t) => [t.minQuantity, t.discountValue]), [[2, 20_000]]);
  // Leaving the rule out of an edit keeps the stored one.
  const keep = await editDraftGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, values: { ...values("edit", null), tierRule: undefined } });
  assert.equal(keep.ok, true);
  assert.equal((await stored(id)).tiers.length, 1);
});

test("publish: an incomplete or non-monotonic rule is refused with the reason and nothing changes", async () => {
  const before = await revision();
  const noUnit = await createTier("nounit", { ...rule(), unit: null, tiers: [] });
  const down = await createTier("down", rule({ tiers: [{ minQuantity: 3, discountValue: 20 }, { minQuantity: 5, discountValue: 10 }] }));
  const noPriority = await createTier("nopri", rule({ discountedUnits: "FROM_REACHED_THRESHOLD" }));
  const noPeers = await createTier("nopeers", rule({ stackingEnabled: true, stackPriority: 1 }));
  const reasons = async (id: string) => {
    const outcome = await publish(id);
    assert.equal(outcome.ok, false);
    return outcome.ok === false && outcome.failure.reason === "INVALID_RULE" ? outcome.failure.errors : null;
  };
  assert.deepEqual(await reasons(noUnit), ["TIER_CONFIG_INCOMPLETE"]);
  assert.deepEqual(await reasons(down), ["VALUE_DECREASES_WITH_THRESHOLD"]);
  assert.deepEqual(await reasons(noPriority), ["SELECTION_PRIORITY_REQUIRED"]);
  assert.deepEqual(await reasons(noPeers), ["STACK_PEERS_REQUIRED"]);
  assert.equal(await revision(), before);
  assert.equal((await stored(down)).isEnabled, false);
});

test("publish: a complete tier rule publishes with the production validator, advancing the revision once", async () => {
  const id = await createTier("ok", rule());
  const before = await revision();
  const outcome = await publish(id);
  assert.equal(outcome.ok, true, show(outcome));
  assert.equal(await revision(), before + BigInt(1));
  assert.equal((await stored(id)).isEnabled, true);
});

test("publish: gate OFF still refuses, and an unfinished gift rule is refused with the exact missing pieces", async () => {
  const id = await createTier("off", rule());
  const off = await publishGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: {} });
  assert.equal(off.ok === false && off.failure.reason, "FEATURE_DISABLED");
  const gift = await createDraftGiftQuantityCampaign({ values: values("g", null, { kind: "GIFT_ITEM", giftTrigger: "QUANTITY", tierRule: null }), session: ADMIN });
  assert.equal(gift.ok, true);
  if (!gift.ok) return;
  const refused = await publish(gift.campaignId);
  assert.deepEqual(
    refused.ok === false && refused.failure.reason === "INVALID_RULE" ? refused.failure.errors : null,
    ["GIFT_MINIMUM_QUANTITY_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"],
  );
});

test("stack priority must be unique among effective stacking campaigns; ending one frees its slot", async () => {
  const peer = await createTier("peer", rule());
  const stacking = (name: string, priority: number) =>
    createTier(name, rule({ stackingEnabled: true, stackPriority: priority, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  const first = await stacking("s1", 7);
  const second = await stacking("s2", 7);
  assert.equal((await publish(first)).ok, true);
  const clash = await publish(second);
  assert.deepEqual(clash.ok === false && clash.failure.reason === "INVALID_RULE" ? clash.failure.errors : null, ["STACK_PRIORITY_CONFLICT"]);
  assert.equal((await stored(second)).isEnabled, false);

  // A different priority is fine, and the same priority is free again once the first is disabled.
  const third = await stacking("s3", 8);
  assert.equal((await publish(third)).ok, true);
  assert.equal((await disableGiftQuantityCampaign({ campaignId: first, now: NOW, session: ADMIN })).ok, true);
  assert.equal((await publish(second)).ok, true);
});

test("stack priority also conflicts with a legacy campaign's consent", async () => {
  const legacyId = await legacy("leg");
  assert.equal((await setLegacyPromotionStackConsent({ campaignId: legacyId, stackPriority: 3, now: NOW, session: ADMIN, env: ON })).ok, true);
  const peer = await createTier("peer", rule());
  const tier = await createTier("t", rule({ stackingEnabled: true, stackPriority: 3, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  const clash = await publish(tier);
  assert.deepEqual(clash.ok === false && clash.failure.reason === "INVALID_RULE" ? clash.failure.errors : null, ["STACK_PRIORITY_CONFLICT"]);
});

test("EX-21: a fixed amount that would take a unit in scope below 1 VND is refused at publish; a safe one is not", async () => {
  await product("cheap", 40_000, "setVay");
  const tooMuch = await createTier("big", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }));
  const refused = await publish(tooMuch);
  assert.deepEqual(refused.ok === false && refused.failure.reason === "INVALID_RULE" ? refused.failure.errors : null, ["TIER_PRICE_BELOW_MINIMUM"]);
  const safe = await createTier("small", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 39_999 }] }));
  assert.equal((await publish(safe)).ok, true);
  // A scope that does not include the cheap product is judged on its own prices.
  await product("pricey", 500_000, "phuKien");
  const other = await createTier("other", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }), { categoryKeys: ["phuKien"] });
  assert.equal((await publish(other)).ok, true);
});

test("Scheduled edit: a rule patch is validated as it will be, replaces the rule and bumps the revisions; a bad patch changes nothing", async () => {
  const id = await createTier("sched", rule());
  assert.equal((await publish(id)).ok, true);
  const before = await revision();
  const base = await stored(id);

  const bad = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { tierRule: rule({ stackingEnabled: true }) },
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.failure.reason === "INVALID_RULE" ? bad.failure.errors : null, ["STACK_PRIORITY_REQUIRED", "STACK_PEERS_REQUIRED"]);
  const scalarOnly = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { stackingEnabled: true } });
  assert.equal(scalarOnly.ok, false, "a scalar patch is validated against the post-edit state, not the stored one");
  assert.equal(await revision(), before);
  assert.deepEqual((await stored(id)).tiers.map((t) => t.discountValue), base.tiers.map((t) => t.discountValue));

  const good = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { tierRule: rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 5_000 }, { minQuantity: 4, discountValue: 9_000 }] }) },
  });
  assert.equal(good.ok, true, show(good));
  const row = await stored(id);
  assert.equal(row.tierUnit, "FIXED_AMOUNT_PER_UNIT_VND");
  assert.deepEqual(row.tiers.map((t) => [t.minQuantity, t.discountValue]), [[2, 5_000], [4, 9_000]]);
  assert.equal(row.revision, base.revision + 1);
  assert.equal(await revision(), before + BigInt(1));
});

test("Scheduled edit: only a real rule change is gated; re-sending the stored rule (in any order) is not an edit", async () => {
  const id = await createTier("gate", rule());
  assert.equal((await publish(id)).ok, true);
  const before = await revision();
  const base = await stored(id);

  const changed = rule({ tiers: [{ minQuantity: 3, discountValue: 10 }, { minQuantity: 5, discountValue: 20 }] });
  const off = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: {}, patch: { tierRule: changed } });
  assert.equal(off.ok === false && off.failure.reason, "FEATURE_DISABLED");
  assert.deepEqual((await stored(id)).tiers.map((t) => t.discountValue), [10, 15], "a gated edit writes nothing");

  const resent = rule({ tiers: [{ minQuantity: 5, discountValue: 15 }, { minQuantity: 3, discountValue: 10 }] });
  const same = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: {}, patch: { tierRule: resent, name: `${P} gate renamed` } });
  assert.equal(same.ok, true, show(same));
  assert.equal(await revision(), before, "nothing effective changed");
  const row = await stored(id);
  assert.equal(row.revision, base.revision);
  assert.equal(row.name, `${P} gate renamed`);

  const withGate = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { tierRule: changed } });
  assert.equal(withGate.ok, true, show(withGate));
  assert.equal(await revision(), before + BigInt(1));
});

test("Scheduled edit: malformed rules and contradictory stacking patches are refused before anything is read or written", async () => {
  const id = await createTier("sm", rule());
  assert.equal((await publish(id)).ok, true);
  const before = await revision();
  const attempt = (patch: Parameters<typeof editScheduledGiftQuantityCampaign>[0]["patch"], env: Record<string, string | undefined> = ON) =>
    editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env, patch });
  const reasonOf = (outcome: Awaited<ReturnType<typeof attempt>>) => (outcome.ok ? "OK" : outcome.failure.reason);
  assert.equal(reasonOf(await attempt({ tierRule: rule({ tiers: [{ minQuantity: 3, discountValue: 100 }] }) })), "INVALID_INPUT");
  assert.equal(reasonOf(await attempt({ tierRule: rule({ tiers: [{ minQuantity: 3, discountValue: 100 }] }) }, {})), "INVALID_INPUT", "malformed input is refused even with the gate off");
  assert.equal(reasonOf(await attempt({ tierRule: rule(), stackingEnabled: true })), "INVALID_INPUT");
  assert.equal(reasonOf(await attempt({ tierRule: rule(), stackPriority: 9 })), "INVALID_INPUT");
  assert.equal(reasonOf(await attempt({ tierRule: rule({ peers: [{ kind: "QUANTITY_TIER", campaignId: "nope" }] }) })), "INVALID_INPUT", "unknown peers are refused");
  assert.equal(await revision(), before);
  assert.equal((await stored(id)).tiers.length, 2);
});

test("Scheduled edit: a rule patch on a gift campaign is refused", async () => {
  const gift = await prisma.giftQuantityCampaign.create({
    data: { kind: "GIFT_ITEM", name: `${P} gift sched`, startsAt: START, endsAt: END, isEnabled: true, enabledAt: NOW, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"], giftTrigger: "QUANTITY" },
  });
  const outcome = await editScheduledGiftQuantityCampaign({ campaignId: gift.id, now: NOW, session: ADMIN, env: ON, patch: { tierRule: rule() } });
  assert.deepEqual(outcome.ok === false && outcome.failure.reason === "INVALID_INPUT" ? outcome.failure.errors : null, ["TIER_FIELDS_ON_GIFT"]);
});

test("a refused publish is atomic: no revision moves, no frozen set is written, nothing is enabled", async () => {
  const fixedBad = await createTier("fixedbad", rule({ tiers: [{ minQuantity: 3, discountValue: 30 }, { minQuantity: 5, discountValue: 20 }] }), {
    scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"],
  });
  const before = await revision();
  const baseRow = await stored(fixedBad);
  const outcome = await publish(fixedBad);
  assert.equal(outcome.ok === false && outcome.failure.reason, "INVALID_RULE");
  assert.equal(await revision(), before);
  const after = await stored(fixedBad);
  assert.equal(after.revision, baseRow.revision, "the campaign's own revision does not move either");
  assert.equal(after.isEnabled, false);
  assert.equal(after.frozenAt, null);
  assert.equal(await prisma.giftQuantityFrozenProduct.count({ where: { campaignId: fixedBad } }), 0);

  // A cross-row refusal (EX-21) is just as atomic as a rule refusal.
  await product("cheap", 10_000, "setVay");
  const price = await createTier("pricebad", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 10_000 }] }), {
    scopeMode: "FIXED_PRODUCT_SET",
  });
  assert.equal((await publish(price)).ok, false);
  assert.equal(await revision(), before);
  assert.equal(await prisma.giftQuantityFrozenProduct.count({ where: { campaignId: price } }), 0);
});

test("EX-21 reads the cart's base price: pancakeRetailPrice, not the after-discount field; retired variants and fractional prices are ignored", async () => {
  await product("c1", 40_000, "setVay");
  await prisma.variantMirror.update({ where: { id: `${P}-c1-v` }, data: { pancakeRetailPriceAfterDiscount: 5_000 } });
  const v = (fixed: number) => rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: fixed }] });
  // 30.000 leaves 10.000 on the base price; the 5.000 after-discount field is not what the cart charges.
  const ok = await createTier("base-ok", v(30_000));
  assert.equal((await publish(ok)).ok, true);

  // A retired variant or product cannot be bought, so its price must not block a publish.
  await prisma.variantMirror.update({ where: { id: `${P}-c1-v` }, data: { isActive: false } });
  await product("c2", 2_000, "setVay");
  await prisma.productMirror.update({ where: { id: `${P}-c2` }, data: { isActive: false } });
  await product("c3", 2_000.5, "setVay");
  const retired = await createTier("retired", v(100_000));
  assert.equal((await publish(retired)).ok, true, "only the 500.000 variant is sellable and unit-priced");

  // The boundary: exactly price-1 is safe, price is not.
  const edge = await createTier("edge", v(500_000));
  const refused = await publish(edge);
  assert.deepEqual(refused.ok === false && refused.failure.reason === "INVALID_RULE" ? refused.failure.errors : null, ["TIER_PRICE_BELOW_MINIMUM"]);
  const edgeOk = await createTier("edge-ok", v(499_999));
  assert.equal((await publish(edgeOk)).ok, true);
});

test("EX-21 percent tiers and Fixed/include scopes use the same price facts", async () => {
  await product("inc", 60_000);
  const include = await createTier("inc", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 60_000 }] }), {
    categoryKeys: [], includeProductIds: [`${P}-inc`],
  });
  const refused = await publish(include);
  assert.deepEqual(refused.ok === false && refused.failure.reason === "INVALID_RULE" ? refused.failure.errors : null, ["TIER_PRICE_BELOW_MINIMUM"]);
  // An exclusion removes the product from the price check as well as from the scope.
  const excluded = await createTier("exc", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 60_000 }] }), {
    categoryKeys: ["setVay"], includeProductIds: [`${P}-inc`], excludeProductIds: [`${P}-a`],
  });
  assert.equal((await refusedErrors(await publish(excluded)))[0], "TIER_PRICE_BELOW_MINIMUM", "the included 60.000 product is still in scope");
});

async function refusedErrors(outcome: Awaited<ReturnType<typeof publish>>) {
  return outcome.ok === false && outcome.failure.reason === "INVALID_RULE" ? outcome.failure.errors : [];
}

test("stack priority: two concurrent publishes with the same priority cannot both win", async () => {
  const peer = await createTier("peer", rule());
  const mk = (name: string) => createTier(name, rule({ stackingEnabled: true, stackPriority: 11, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  const [a, b] = [await mk("race-a"), await mk("race-b")];
  const results = await Promise.all([publish(a), publish(b)]);
  assert.equal(results.filter((r) => r.ok).length, 1, show(results));
  const loser = results.find((r) => !r.ok)!;
  assert.deepEqual(await refusedErrors(loser), ["STACK_PRIORITY_CONFLICT"]);
});

test("stack priority: a gift campaign's priority orders nothing and never collides; a non-stacking tier needs no slot", async () => {
  await prisma.giftQuantityCampaign.create({
    data: { kind: "GIFT_ITEM", name: `${P} gift prio`, isEnabled: true, enabledAt: NOW, stackingEnabled: true, stackPriority: 21, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"] },
  });
  const peer = await createTier("peer", rule());
  const tier = await createTier("t21", rule({ stackingEnabled: true, stackPriority: 21, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  assert.equal((await publish(tier)).ok, true, "a gift campaign does not occupy a price-order slot");
  const notStacking = await createTier("t21b", rule({ stackingEnabled: false, stackPriority: 21 }));
  assert.equal((await publish(notStacking)).ok, true, "stacking off: the priority is inert");
});

test("re-enable runs the cross-row checks again: a slot taken meanwhile blocks it, and the refusal changes nothing", async () => {
  const peer = await createTier("peer", rule());
  const mk = (name: string) => createTier(name, rule({ stackingEnabled: true, stackPriority: 31, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  const a = await mk("re-a");
  const b = await mk("re-b");
  assert.equal((await publish(a)).ok, true);
  assert.equal((await disableGiftQuantityCampaign({ campaignId: a, now: NOW, session: ADMIN })).ok, true);
  assert.equal((await publish(b)).ok, true);
  const before = await revision();
  const rowBefore = await stored(a);
  const reEnable = await publish(a);
  assert.deepEqual(await refusedErrors(reEnable), ["STACK_PRIORITY_CONFLICT"]);
  assert.equal(await revision(), before);
  const rowAfter = await stored(a);
  assert.equal(rowAfter.isEnabled, false);
  assert.equal(rowAfter.revision, rowBefore.revision);
  // Once the holder is gone the same call succeeds: create -> publish -> disable -> re-enable.
  assert.equal((await disableGiftQuantityCampaign({ campaignId: b, now: NOW, session: ADMIN })).ok, true);
  const again = await publish(a);
  assert.equal(again.ok, true, show(again));
  assert.deepEqual((await stored(a)).tiers.map((t) => [t.minQuantity, t.discountValue]), [[3, 10], [5, 15]], "the rule survived the cycle intact");
});

test("peers: a kind wildcard is stored and publishes; a gift peer, a missing peer and a wrong-kind peer are refused", async () => {
  const wild = await createTier("wild", rule({ stackingEnabled: true, stackPriority: 41, peers: [{ kind: "PROMOTION", campaignId: "*" }, { kind: "QUANTITY_TIER", campaignId: "*" }] }));
  assert.deepEqual((await stored(wild)).stackPeers.map((p) => `${p.peerKind}:${p.peerCampaignId}`).sort(), ["PROMOTION:*", "QUANTITY_TIER:*"]);
  assert.equal((await publish(wild)).ok, true);
  const gift = await createDraftGiftQuantityCampaign({ values: values("gp", rule({ peers: [{ kind: "GIFT_ITEM" as never, campaignId: "*" }] })), session: ADMIN });
  assert.deepEqual(gift.ok === false && gift.failure.reason === "INVALID_INPUT" ? gift.failure.errors : null, ["STACK_PEER_INVALID"]);
});

test("form round trip: tier fields parse, persist and reload; a form without tier fields keeps the stored rule", async () => {
  const peer = await createTier("peer", rule());
  const fd = new FormData();
  for (const [key, value] of Object.entries({
    kind: "QUANTITY_TIER", name: `${P} form`, scopeMode: "DYNAMIC_CATEGORY", tierUnit: "FIXED_AMOUNT_PER_UNIT_VND",
    tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "CHEAPEST_FIRST", stackingEnabled: "on", stackPriority: "5",
  })) fd.append(key, value);
  fd.append("categoryKey", "setVay");
  fd.append("tierMinQuantity", "2"); fd.append("tierDiscountValue", "20000");
  fd.append("tierMinQuantity", ""); fd.append("tierDiscountValue", "");
  fd.append("tierMinQuantity", "4"); fd.append("tierDiscountValue", "30000");
  fd.append("stackPeer", `QUANTITY_TIER:${peer}`);
  const parsedForm = parseGiftQuantityDraftForm(fd);
  assert.equal(parsedForm.ok, true, show(parsedForm));
  if (!parsedForm.ok) return;
  const created = await createDraftGiftQuantityCampaign({ values: parsedForm.value, session: ADMIN });
  assert.equal(created.ok, true, show(created));
  if (!created.ok) return;
  const row = await stored(created.campaignId);
  assert.deepEqual([row.tierUnit, row.tierDiscountedUnits, row.tierSelectionPriority, row.stackingEnabled, row.stackPriority],
    ["FIXED_AMOUNT_PER_UNIT_VND", "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST", true, 5]);
  assert.deepEqual(row.tiers.map((t) => [t.minQuantity, t.discountValue]), [[2, 20_000], [4, 30_000]]);

  // The scope-only form of the GQ05 editor carries no tier field: the rule must survive its save.
  const scopeOnly = new FormData();
  for (const [key, value] of Object.entries({ kind: "QUANTITY_TIER", name: `${P} form renamed`, scopeMode: "DYNAMIC_CATEGORY" })) scopeOnly.append(key, value);
  scopeOnly.append("categoryKey", "setVay");
  const parsedScopeOnly = parseGiftQuantityDraftForm(scopeOnly);
  assert.equal(parsedScopeOnly.ok && parsedScopeOnly.value.tierRule === null, true);
  if (!parsedScopeOnly.ok) return;
  const edited = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, now: NOW, session: ADMIN, values: parsedScopeOnly.value });
  assert.equal(edited.ok, true, show(edited));
  const kept = await stored(created.campaignId);
  assert.equal(kept.name, `${P} form renamed`);
  assert.equal(kept.tiers.length, 2);
  assert.equal(kept.stackPeers.length, 1);
});

test("malformed tier input on edit writes nothing, even for a Draft", async () => {
  const id = await createTier("keep", rule());
  const before = await stored(id);
  for (const bad of [rule({ tiers: [{ minQuantity: 1.5, discountValue: 5 }] }), rule({ tiers: [{ minQuantity: 3, discountValue: Number.MAX_SAFE_INTEGER }], unit: "FIXED_AMOUNT_PER_UNIT_VND" }), rule({ stackPriority: -1 })]) {
    const outcome = await editDraftGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, values: values("keep-changed", bad) });
    assert.equal(outcome.ok === false && outcome.failure.reason, "INVALID_INPUT");
  }
  const after = await stored(id);
  assert.equal(after.name, before.name);
  assert.deepEqual(after.tiers.map((t) => t.discountValue), before.tiers.map((t) => t.discountValue));
});

test("authorization comes first: no session, no write and no read on every new entry point", async () => {
  await assert.rejects(() => createDraftGiftQuantityCampaign({ values: values("anon", rule()), session: null }));
  await assert.rejects(() => publishGiftQuantityCampaign({ campaignId: "x", now: NOW, session: null, env: ON }));
  await assert.rejects(() => editScheduledGiftQuantityCampaign({ campaignId: "x", now: NOW, session: { user: { id: "u", role: "USER" }, session: { id: "s" } }, env: ON, patch: { tierRule: rule() } }));
  await assert.rejects(() => clearLegacyPromotionStackConsent({ campaignId: "x", session: undefined }));
  assert.equal(await prisma.giftQuantityCampaign.count({ where: { name: { startsWith: `${P} anon` } } }), 0);
});

test("copy keeps the whole rule and the copy is a Draft that must pass its own publish", async () => {
  const peer = await createTier("peer", rule());
  const id = await createTier("orig", rule({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", stackingEnabled: true, stackPriority: 51, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  assert.equal((await publish(id)).ok, true);
  const copied = await copyGiftQuantityCampaign({ campaignId: id, session: ADMIN });
  assert.equal(copied.ok, true, show(copied));
  if (!copied.ok) return;
  const copy = await stored(copied.campaignId);
  assert.deepEqual([copy.tierUnit, copy.tierDiscountedUnits, copy.tierSelectionPriority, copy.stackPriority], ["PERCENTAGE", "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST", 51]);
  assert.equal(copy.tiers.length, 2);
  assert.equal(copy.isEnabled, false);
  assert.deepEqual(await refusedErrors(await publish(copied.campaignId)), ["STACK_PRIORITY_CONFLICT"]);
});

test("Scheduled Fixed edit: price safety includes frozen products that left their category", async () => {
  await product("frozen-cheap", 40_000, "setVay");
  const id = await createTier("frozen-cheap", rule(), { scopeMode: "FIXED_PRODUCT_SET" });
  assert.equal((await publish(id)).ok, true);
  await prisma.productCategoryMembership.deleteMany({ where: { productId: `${P}-frozen-cheap` } });
  const before = await revision();
  const base = await stored(id);
  const outcome = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { tierRule: rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }) },
  });
  assert.deepEqual(await refusedErrors(outcome), ["TIER_PRICE_BELOW_MINIMUM"]);
  assert.equal(await revision(), before);
  assert.equal((await stored(id)).revision, base.revision);
  assert.equal((await stored(id)).tierUnit, "PERCENTAGE");
  assert.equal(await prisma.giftQuantityFrozenProduct.count({ where: { campaignId: id } }), 2);
});

test("Scheduled Fixed edit: newly categorized products do not affect the retained frozen scope", async () => {
  const id = await createTier("frozen-safe", rule(), { scopeMode: "FIXED_PRODUCT_SET" });
  assert.equal((await publish(id)).ok, true);
  await product("new-cheap", 40_000, "setVay");
  const before = await revision();
  const outcome = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { tierRule: rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }) },
  });
  assert.equal(outcome.ok, true, show(outcome));
  assert.equal(await revision(), before + BigInt(1));
  assert.deepEqual((await prisma.giftQuantityFrozenProduct.findMany({ where: { campaignId: id } })).map(p => p.productId), [`${P}-a`]);
  // A real scope change re-freezes current membership, so the new cheap product now counts.
  const refreshed = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"], includeProductIds: [`${P}-new-cheap`], excludeProductIds: [] } },
  });
  assert.deepEqual(await refusedErrors(refreshed), ["TIER_PRICE_BELOW_MINIMUM"]);
});

test("Scheduled edit: scalar stack priority bounds are refused as typed input errors", async () => {
  const id = await createTier("scalar-bounds", rule());
  assert.equal((await publish(id)).ok, true);
  const before = await revision();
  for (const stackPriority of [-1, 1.5, 1_000_001, Number.NaN]) {
    const outcome = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { stackPriority } });
    assert.deepEqual(outcome.ok === false && outcome.failure.reason === "INVALID_INPUT" ? outcome.failure.errors : null, ["STACK_PRIORITY_OUT_OF_RANGE"]);
  }
  assert.equal(await revision(), before);
  assert.equal((await stored(id)).stackPriority, null);
});

test("Scheduled edit: distinct peer sets cannot collide in the real-change comparison", async () => {
  const a = await legacy("compare-a");
  const b = await legacy("compare-b");
  const combined = await legacy(`compare-a,PROMOTION|${b}`);
  const id = await createTier("peer-compare", rule({ peers: [{ kind: "PROMOTION", campaignId: a }, { kind: "PROMOTION", campaignId: b }] }));
  assert.equal((await publish(id)).ok, true);
  const changed = rule({ peers: [{ kind: "PROMOTION", campaignId: combined }] });
  const before = await revision();
  const off = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: {}, patch: { tierRule: changed } });
  assert.equal(off.ok === false && off.failure.reason, "FEATURE_DISABLED");
  const on = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { tierRule: changed } });
  assert.equal(on.ok, true, show(on));
  assert.equal(await revision(), before + BigInt(1));
  assert.deepEqual((await stored(id)).stackPeers.map(p => p.peerCampaignId), [combined]);
});


async function compositePriceFixture() {
  for (const [key, price, sku] of [
    ["hidden-ao", 20_000, "AO-GQ09"], ["hidden-cv", 200_000, "CV-GQ09"], ["hidden-quan", 200_000, "QUAN-GQ09"],
    ["combo", 500_000, "COMBO-GQ09"], ["hidden-set", 20_000, "SET-GQ09"],
  ] as const) {
    await product(key, price, ...(["hidden-ao", "hidden-set"].includes(key) ? ["setVay"] : []));
    await prisma.variantMirror.update({ where: { id: `${P}-${key}-v` }, data: { sku, color: "Black", size: "M" } });
    await prisma.warehouseStock.create({ data: { variantId: `${P}-${key}-v`, pancakeWarehouseId: `${P}-wh`, quantity: 50, syncedAt: NOW } });
    if (key !== "combo") await prisma.productMirror.update({ where: { id: `${P}-${key}` }, data: { isActive: false } });
  }
  await prisma.compositeComponentMirror.createMany({ data: [
    ...["hidden-ao", "hidden-cv", "hidden-quan"].map(k => ({ parentVariantId: `${P}-combo-v`, componentVariantId: `${P}-${k}-v`, quantity: 1, syncedAt: NOW })),
    ...["hidden-ao", "hidden-cv"].map(k => ({ parentVariantId: `${P}-hidden-set-v`, componentVariantId: `${P}-${k}-v`, quantity: 1, syncedAt: NOW })),
  ] });
}

test("GQ09a-F2: publish and cart include inactive-owner components and authorized subsets in price safety", async () => {
  await compositePriceFixture();
  const cart = createStorefrontCartRepository(prisma);
  for (const key of ["hidden-ao", "hidden-set"]) {
    const variantId = `${P}-${key}-v`;
    const lines = await cart.getLines({ shopId: SHOP, items: [{ variantId, quantity: 2 }], now: NOW });
    assert.equal(lines[0]!.available, true, `${key}: ${show(lines)}`);
    assert.equal(lines[0]!.price, 20_000);
    const id = await createTier(`eligible-${key}`, rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }),
      { categoryKeys: [], includeProductIds: [`${P}-${key}`] });
    const before = await revision();
    assert.deepEqual(await refusedErrors(await publish(id)), ["TIER_PRICE_BELOW_MINIMUM"]);
    assert.equal(await revision(), before);
    assert.equal((await stored(id)).isEnabled, false);
    assert.equal((await stored(id)).revision, 1);
  }
});

test("GQ09a-F2: a truly unavailable inactive-owner variant does not block publish", async () => {
  await product("unavailable", 20_000, "setVay");
  await prisma.productMirror.update({ where: { id: `${P}-unavailable` }, data: { isActive: false } });
  await prisma.warehouseStock.create({ data: { variantId: `${P}-unavailable-v`, pancakeWarehouseId: `${P}-wh`, quantity: 50, syncedAt: NOW } });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId: SHOP, items: [{ variantId: `${P}-unavailable-v`, quantity: 2 }], now: NOW });
  assert.equal(lines[0]!.available, false);
  const id = await createTier("unavailable-safe", rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] }));
  assert.equal((await publish(id)).ok, true);
});

function catalogInterleavingClient(onPriceRead: (tx: import("../../src/commerce/promotion-activation-service.ts").Tx) => Promise<void>) {
  // Both transactions are real database transactions. The proxy only places the second commit
  // precisely after the price SELECT, so the test does not depend on a scheduling delay.
  return new Proxy(prisma, { get(target, key, receiver) {
    if (key !== "$transaction") return Reflect.get(target, key, receiver);
    return (operation: (tx: unknown) => Promise<unknown>, options: unknown) => target.$transaction(async tx => {
      let fired = false;
      const wrapped = new Proxy(tx, { get(t, property, r) {
        if (property !== "$queryRaw") return Reflect.get(t, property, r);
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(t.$queryRaw, t, args);
          if (!fired && Array.isArray(args[0]) && args[0].join("").includes('SELECT MIN(v."pancakeRetailPrice")')) {
            fired = true;
            await onPriceRead(tx);
          }
          return result;
        };
      } });
      return operation(wrapped);
    }, options as never);
  } });
}

for (const operation of ["publish", "re-enable", "scope edit"] as const) {
  test(`GQ09a-F3: ${operation} price validation and Fixed freeze use the same catalog snapshot`, async () => {
    const fixedRule = rule({ unit: "FIXED_AMOUNT_PER_UNIT_VND", tiers: [{ minQuantity: 2, discountValue: 50_000 }] });
    const id = await createTier(`snapshot-${operation}`, fixedRule, { scopeMode: operation === "scope edit" ? "DYNAMIC_CATEGORY" : "FIXED_PRODUCT_SET" });
    if (operation !== "publish") assert.equal((await publish(id)).ok, true);
    if (operation === "re-enable") assert.equal((await disableGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN })).ok, true);
    await product("race-cheap", 20_000);
    const before = await revision();
    const base = await stored(id);
    let interleavings = 0;
    let priceInFreezeSnapshot: number | null = null;
    const client = catalogInterleavingClient(async tx => {
      interleavings++;
      await prisma.$transaction(async catalog => {
        await catalog.productCategoryMembership.deleteMany({ where: { productId: `${P}-a` } });
        await catalog.productCategoryMembership.create({ data: { productId: `${P}-race-cheap`, categoryKey: "setVay" } });
        await catalog.variantMirror.update({ where: { id: `${P}-a-v` }, data: { pancakeRetailPrice: 20_000 } });
      });
      const old = await tx.variantMirror.findUniqueOrThrow({ where: { id: `${P}-a-v` } });
      priceInFreezeSnapshot = old.pancakeRetailPrice;
    });
    const outcome = operation === "scope edit"
      ? await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, client,
          patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"], includeProductIds: [], excludeProductIds: [] } } })
      : await publishGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: ON, client });
    assert.equal(outcome.ok, true, show(outcome));
    assert.equal(interleavings, 1);
    const frozen = await prisma.giftQuantityFrozenProduct.findMany({ where: { campaignId: id } });
    assert.deepEqual(frozen.map(p => p.productId), [`${P}-a`], "the newly categorized cheap product was never in the validated snapshot");
    assert.equal(priceInFreezeSnapshot, 500_000, "the freeze transaction keeps the price snapshot it validated");
    assert.equal(await revision(), before + BigInt(1));
    assert.equal((await stored(id)).revision, base.revision + 1);
    assert.equal((await prisma.variantMirror.findUniqueOrThrow({ where: { id: `${P}-a-v` } })).pancakeRetailPrice, 20_000, "the separate catalog transaction really committed");
  });
}
