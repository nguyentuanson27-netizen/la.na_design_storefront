import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { parseGiftQuantityDraftForm } from "../../src/commerce/gift-quantity-admin-input.ts";
import { publishGiftQuantityCampaign } from "../../src/commerce/gift-quantity-activation-service.ts";
import type { GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-admin-service.ts";
import { clearLegacyPromotionStackConsent } from "../../src/commerce/gift-quantity-legacy-consent.ts";
import type { TierRuleInput } from "../../src/commerce/gift-quantity-tier-rule.ts";
import { PROMOTION_REVISION_ID } from "../../src/commerce/promotion-activation-service.ts";
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

test("peers: a kind wildcard is stored; a gift peer, a missing peer and a wrong-kind peer are refused", async () => {
  const wild = await createTier("wild", rule({ stackingEnabled: true, stackPriority: 41, peers: [{ kind: "PROMOTION", campaignId: "*" }, { kind: "QUANTITY_TIER", campaignId: "*" }] }));
  assert.deepEqual((await stored(wild)).stackPeers.map((p) => `${p.peerKind}:${p.peerCampaignId}`).sort(), ["PROMOTION:*", "QUANTITY_TIER:*"]);
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
  await assert.rejects(() => editDraftGiftQuantityCampaign({ campaignId: "x", now: NOW, session: { user: { id: "u", role: "USER" }, session: { id: "s" } }, values: values("anon", rule()) }));
  await assert.rejects(() => copyGiftQuantityCampaign({ campaignId: "x", session: null }));
  await assert.rejects(() => clearLegacyPromotionStackConsent({ campaignId: "x", session: undefined }));
  assert.equal(await prisma.giftQuantityCampaign.count({ where: { name: { startsWith: `${P} anon` } } }), 0);
});

test("copy keeps the whole rule and the copy is a Draft", async () => {
  const peer = await createTier("peer", rule());
  const id = await createTier("orig", rule({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", stackingEnabled: true, stackPriority: 51, peers: [{ kind: "QUANTITY_TIER", campaignId: peer }] }));
  const copied = await copyGiftQuantityCampaign({ campaignId: id, session: ADMIN });
  assert.equal(copied.ok, true, show(copied));
  if (!copied.ok) return;
  const copy = await stored(copied.campaignId);
  assert.deepEqual([copy.tierUnit, copy.tierDiscountedUnits, copy.tierSelectionPriority, copy.stackPriority], ["PERCENTAGE", "FROM_REACHED_THRESHOLD", "CHEAPEST_FIRST", 51]);
  assert.equal(copy.tiers.length, 2);
  assert.equal(copy.isEnabled, false);
  assert.deepEqual(copy.stackPeers.map((p) => [p.peerKind, p.peerCampaignId]), [["QUANTITY_TIER", peer]]);
});

test("until the publish contract lands, no tier campaign can be published: it fails closed, moves nothing, and a saved rule changes nothing", async () => {
  const before = await revision();
  const id = await createTier("closed", rule());
  const outcome = await publish(id);
  assert.deepEqual(outcome.ok === false && outcome.failure.reason === "INVALID_RULE" ? outcome.failure.errors : null, ["RULE_VALIDATION_NOT_AVAILABLE"]);
  assert.equal(await revision(), before);
  const row = await stored(id);
  assert.equal(row.isEnabled, false);
  assert.equal(row.revision, 1);
  assert.equal(row.tiers.length, 2, "the saved rule is untouched by the refusal");
});
