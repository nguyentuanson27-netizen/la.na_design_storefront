import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import type { GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-admin-service.ts";
import { PROMOTION_REVISION_ID } from "../../src/commerce/promotion-activation-service.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq05";
const SHOP = 920_945;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const CUSTOMER = { user: { id: "c-1", role: "CUSTOMER" }, session: { id: "s-2" } } as const;
const NOW = new Date("2026-10-13T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "name" LIKE ${`${P}%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${P}-%`}`;
}

async function product(suffix: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'GQ05 product',NOW(),NOW(),NOW())`,
    `${P}-${suffix}`, SHOP, `${P}-${suffix}-ext`, `${P}-${suffix}-slug`,
  );
}
async function revision(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  return row?.revision ?? BigInt(-1);
}

const values = (overrides: Partial<GiftQuantityDraftValues> = {}): GiftQuantityDraftValues => ({
  kind: "GIFT_ITEM", name: `${P} campaign`, startsAt: null, endsAt: null, scopeMode: "DYNAMIC_CATEGORY",
  categoryKeys: ["vayDam"], includeProductIds: [], excludeProductIds: [], giftTrigger: "QUANTITY", subtotalScope: null, ...overrides,
});

test.beforeEach(async () => {
  await cleanup();
  await product("a");
  await product("b");
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("authorization comes first: a non-admin or missing session writes nothing", async () => {
  for (const session of [CUSTOMER, null]) {
    await assert.rejects(() => createDraftGiftQuantityCampaign({ values: values(), session }));
    await assert.rejects(() => editDraftGiftQuantityCampaign({ campaignId: "x", values: values(), now: NOW, session }));
    await assert.rejects(() => copyGiftQuantityCampaign({ campaignId: "x", session }));
  }
  assert.equal(await prisma.giftQuantityCampaign.count({ where: { name: { startsWith: P } } }), 0);
});

test("create: a Draft with scope, targets and the gift trigger round-trips; it is never enabled and moves no revision", async () => {
  const before = await revision();
  const outcome = await createDraftGiftQuantityCampaign({
    values: values({ categoryKeys: ["vayDam", "setDo"], includeProductIds: [`${P}-a`], excludeProductIds: [`${P}-b`], scopeMode: "FIXED_PRODUCT_SET" }),
    session: ADMIN,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const row = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: outcome.campaignId }, include: { targets: true } });
  assert.equal(row.kind, "GIFT_ITEM");
  assert.equal(row.isEnabled, false);
  assert.equal(row.enabledAt, null);
  assert.equal(row.revision, 1);
  assert.equal(row.scopeMode, "FIXED_PRODUCT_SET");
  assert.deepEqual(row.categoryKeys, ["vayDam", "setDo"]);
  assert.equal(row.frozenAt, null, "a Draft is never frozen");
  assert.deepEqual(row.targets.map((t) => [t.productId, t.role]).sort(), [[`${P}-a`, "INCLUDE"], [`${P}-b`, "EXCLUDE"]]);
  assert.equal(await revision(), before, "a Draft write is not effective");
});

test("create: an incomplete Draft (no categories, no products, no window) is allowed", async () => {
  const outcome = await createDraftGiftQuantityCampaign({ values: values({ categoryKeys: [], giftTrigger: null }), session: ADMIN });
  assert.equal(outcome.ok, true);
});

test("create: a tier Draft carries no gift fields; a name is trimmed", async () => {
  const outcome = await createDraftGiftQuantityCampaign({ values: values({ kind: "QUANTITY_TIER", giftTrigger: null, name: `  ${P} tier  ` }), session: ADMIN });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const row = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: outcome.campaignId } });
  assert.equal(row.name, `${P} tier`);
  assert.equal(row.giftTrigger, null);
});

test("EX-22: a global all-paid gift needs no categories or products", async () => {
  const outcome = await createDraftGiftQuantityCampaign({
    values: values({ scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES" }),
    session: ADMIN,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const row = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: outcome.campaignId }, include: { targets: true } });
  assert.equal(row.scopeMode, "GLOBAL_ALL_PAID_LINES");
  assert.deepEqual(row.categoryKeys, []);
  assert.equal(row.targets.length, 0);
  assert.equal(row.subtotalScope, "ALL_PAID_LINES");
});

test("contradictory or out-of-bounds drafts are refused and write nothing", async () => {
  const refused = async (overrides: Partial<GiftQuantityDraftValues>) => {
    const outcome = await createDraftGiftQuantityCampaign({ values: values(overrides), session: ADMIN });
    assert.equal(outcome.ok, false, JSON.stringify(overrides));
    return outcome.ok ? null : outcome.failure;
  };
  const globalGift = { scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES" } as const;
  assert.equal((await refused({ ...globalGift, categoryKeys: ["vayDam"] }))?.reason, "INVALID_SCOPE", "global + categories");
  assert.equal((await refused({ ...globalGift, categoryKeys: [], includeProductIds: [`${P}-a`] }))?.reason, "INVALID_SCOPE", "global + includes");
  assert.equal((await refused({ ...globalGift, categoryKeys: [], excludeProductIds: [`${P}-a`] }))?.reason, "INVALID_SCOPE", "global + excludes");
  assert.equal((await refused({ scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], giftTrigger: "QUANTITY" }))?.reason, "INVALID_INPUT");
  assert.equal((await refused({ kind: "QUANTITY_TIER", scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], giftTrigger: null }))?.reason, "INVALID_INPUT");
  assert.equal((await refused({ giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES" }))?.reason, "INVALID_INPUT", "ALL_PAID_LINES with a real scope");
  assert.equal((await refused({ categoryKeys: ["nope"] }))?.reason, "INVALID_SCOPE");
  assert.equal((await refused({ categoryKeys: ["vayDam", "vayDam"] }))?.reason, "INVALID_SCOPE");
  assert.equal((await refused({ includeProductIds: [`${P}-missing`] }))?.reason, "INVALID_SCOPE", "unknown product");
  assert.equal((await refused({ includeProductIds: ["x".repeat(200)] }))?.reason, "INVALID_SCOPE");
  assert.equal((await refused({ includeProductIds: Array.from({ length: 501 }, (_, i) => `p${i}`) }))?.reason, "INVALID_SCOPE", "too many includes");
  assert.equal((await refused({ name: "   " }))?.reason, "INVALID_INPUT");
  assert.equal((await refused({ name: `${P}${"x".repeat(200)}` }))?.reason, "INVALID_INPUT");
  assert.equal(await prisma.giftQuantityCampaign.count({ where: { name: { startsWith: P } } }), 0);
});

test("edit: replaces scope and targets and keeps the kind; trigger changes clear the replaced trigger's fields", async () => {
  const created = await createDraftGiftQuantityCampaign({ values: values({ includeProductIds: [`${P}-a`] }), session: ADMIN });
  assert.ok(created.ok);
  if (!created.ok) return;
  // give the draft values for the quantity trigger, as GQ13a will
  await prisma.giftQuantityCampaign.update({ where: { id: created.campaignId }, data: { minimumQuantity: 3, maxGiftsPerOrder: 2 } });

  const edited = await editDraftGiftQuantityCampaign({
    campaignId: created.campaignId, now: NOW, session: ADMIN,
    values: values({ name: `${P} renamed`, categoryKeys: ["setDo"], includeProductIds: [], excludeProductIds: [`${P}-b`], giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" }),
  });
  assert.equal(edited.ok, true);
  const row = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: created.campaignId }, include: { targets: true } });
  assert.equal(row.name, `${P} renamed`);
  assert.deepEqual(row.categoryKeys, ["setDo"]);
  assert.deepEqual(row.targets.map((t) => [t.productId, t.role]), [[`${P}-b`, "EXCLUDE"]]);
  assert.equal(row.giftTrigger, "ORDER_SUBTOTAL");
  assert.equal(row.subtotalScope, "ELIGIBLE_PAID_LINES");
  assert.equal(row.minimumQuantity, null, "the replaced trigger's value is cleared");
  assert.equal(row.maxGiftsPerOrder, 2, "unrelated rule fields are kept");
  assert.equal(row.revision, 1);

  const back = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, now: NOW, session: ADMIN, values: values({ giftTrigger: null, categoryKeys: [] }) });
  assert.equal(back.ok, true);
  const cleared = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: created.campaignId } });
  assert.equal(cleared.subtotalScope, null);
  assert.equal(cleared.giftTrigger, null);
});

test("edit: the kind cannot change, only a Draft can be edited, a missing campaign and a refused edit leave rows untouched", async () => {
  const created = await createDraftGiftQuantityCampaign({ values: values({ includeProductIds: [`${P}-a`] }), session: ADMIN });
  assert.ok(created.ok);
  if (!created.ok) return;

  const kind = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, now: NOW, session: ADMIN, values: values({ kind: "QUANTITY_TIER", giftTrigger: null }) });
  assert.deepEqual(kind, { ok: false, failure: { reason: "KIND_IMMUTABLE" } });

  const refused = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, now: NOW, session: ADMIN, values: values({ categoryKeys: ["nope"] }) });
  assert.equal(!refused.ok && refused.failure.reason, "INVALID_SCOPE");
  const untouched = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: created.campaignId }, include: { targets: true } });
  assert.deepEqual(untouched.categoryKeys, ["vayDam"]);
  assert.equal(untouched.targets.length, 1);

  assert.deepEqual(await editDraftGiftQuantityCampaign({ campaignId: `${P}-none`, now: NOW, session: ADMIN, values: values() }), { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } });
  assert.equal((await editDraftGiftQuantityCampaign({ campaignId: "x".repeat(200), now: NOW, session: ADMIN, values: values() })).ok, false);

  await prisma.giftQuantityCampaign.update({ where: { id: created.campaignId }, data: { isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-02T00:00:00Z") } });
  const active = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, now: NOW, session: ADMIN, values: values({ name: `${P} no` }) });
  assert.deepEqual(active, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "ACTIVE" } });
  assert.equal((await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: created.campaignId } })).name, `${P} campaign`);
});

test("copy: configuration and children are copied verbatim into a fresh, unfrozen Draft", async () => {
  const created = await createDraftGiftQuantityCampaign({
    values: values({ kind: "QUANTITY_TIER", giftTrigger: null, scopeMode: "FIXED_PRODUCT_SET", includeProductIds: [`${P}-a`], excludeProductIds: [`${P}-b`] }),
    session: ADMIN,
  });
  assert.ok(created.ok);
  if (!created.ok) return;
  await prisma.giftQuantityCampaign.update({
    where: { id: created.campaignId },
    data: { tierUnit: "PERCENTAGE", tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "CHEAPEST_FIRST", stackPriority: 4, stackingEnabled: true, isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), frozenAt: new Date("2026-10-01T00:00:00Z"), frozenCampaignRevision: 2, revision: 2 },
  });
  await prisma.quantityTier.createMany({ data: [{ campaignId: created.campaignId, unit: "PERCENTAGE", minQuantity: 2, discountValue: 10 }, { campaignId: created.campaignId, unit: "PERCENTAGE", minQuantity: 4, discountValue: 15 }] });
  await prisma.giftQuantityFrozenProduct.create({ data: { campaignId: created.campaignId, productId: `${P}-a` } });
  await prisma.giftQuantityStackPeer.createMany({ data: [{ campaignId: created.campaignId, peerKind: "FLASH_SALE", peerCampaignId: "*" }] });

  const before = await revision();
  const copy = await copyGiftQuantityCampaign({ campaignId: created.campaignId, session: ADMIN });
  assert.ok(copy.ok);
  if (!copy.ok) return;
  assert.notEqual(copy.campaignId, created.campaignId);
  const row = await prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: copy.campaignId }, include: { targets: true, tiers: true, frozen: true, stackPeers: true } });
  assert.equal(row.name, `${P} campaign - Bản sao`);
  assert.equal(row.isEnabled, false);
  assert.equal(row.enabledAt, null);
  assert.equal(row.revision, 1);
  assert.equal(row.frozenAt, null);
  assert.equal(row.frozen.length, 0, "a copy re-captures its own frozen set at publish");
  assert.equal(row.tierUnit, "PERCENTAGE");
  assert.equal(row.tierSelectionPriority, "CHEAPEST_FIRST");
  assert.equal(row.stackPriority, 4);
  assert.deepEqual(row.tiers.map((t) => [t.minQuantity, t.discountValue]).sort(), [[2, 10], [4, 15]]);
  assert.deepEqual(row.targets.map((t) => [t.productId, t.role]).sort(), [[`${P}-a`, "INCLUDE"], [`${P}-b`, "EXCLUDE"]]);
  assert.deepEqual(row.stackPeers.map((p) => [p.peerKind, p.peerCampaignId]), [["FLASH_SALE", "*"]]);
  assert.equal(await revision(), before, "a copy is not effective");

  assert.deepEqual(await copyGiftQuantityCampaign({ campaignId: `${P}-none`, session: ADMIN }), { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } });
});

test("F04: a product named as both applicable and excluded is stored once, as excluded, by create and by edit — never a unique-constraint failure", async () => {
  const created = await createDraftGiftQuantityCampaign({
    values: values({ includeProductIds: [`${P}-a`, `${P}-b`], excludeProductIds: [`${P}-a`] }),
    session: ADMIN,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) return;
  const rolesOf = async () =>
    (await prisma.giftQuantityTarget.findMany({ where: { campaignId: created.campaignId }, orderBy: { productId: "asc" } })).map((t) => [t.productId, t.role]);
  assert.deepEqual(await rolesOf(), [[`${P}-a`, "EXCLUDE"], [`${P}-b`, "INCLUDE"]]);

  const edited = await editDraftGiftQuantityCampaign({
    campaignId: created.campaignId, now: NOW, session: ADMIN,
    values: values({ includeProductIds: [`${P}-b`, `${P}-a`], excludeProductIds: [`${P}-b`] }),
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(await rolesOf(), [[`${P}-a`, "INCLUDE"], [`${P}-b`, "EXCLUDE"]]);
});
