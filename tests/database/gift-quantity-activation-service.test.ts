import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";
import {
  disableGiftQuantityCampaign,
  editScheduledGiftQuantityCampaign,
  endGiftQuantityCampaignEarly,
  publishGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-activation-service.ts";
import {
  MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS,
  readActiveGiftQuantityCampaigns,
  readScopeProductFacts,
  type GiftQuantityCandidateReadClient,
} from "../../src/commerce/gift-quantity-candidate-repository.ts";
import { RULE_VALIDATION_NOT_AVAILABLE } from "../../src/commerce/gift-quantity-rule-validation.ts";
import { MAX_FROZEN_PRODUCTS } from "../../src/commerce/gift-quantity-scope.ts";
import { deriveCampaignLifecycle } from "../../src/commerce/promotion-campaign-lifecycle.ts";
import { PROMOTION_REVISION_ID } from "../../src/commerce/promotion-activation-service.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq04";
const SHOP = 920_944;
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const LEGACY_ON_ONLY = { LA_PROMOTION_ACTIVATION_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const CUSTOMER = { user: { id: "c-1", role: "CUSTOMER" }, session: { id: "s-2" } } as const;
const T0 = new Date("2026-10-13T00:00:00.000Z");
const START = new Date("2026-10-20T00:00:00.000Z");
const END = new Date("2026-10-30T00:00:00.000Z");
/** Rule validation is GQ09a/GQ13a's job; these tests exercise the lifecycle around it. */
const passRules = () => [] as const;

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductCategoryMembership" WHERE "productId" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${P}-%`}`;
}

async function product(suffix: string, ...categoryKeys: string[]) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'GQ04 product',NOW(),NOW(),NOW())`,
    `${P}-${suffix}`, SHOP, `${P}-${suffix}-ext`, `${P}-${suffix}-slug`,
  );
  for (const key of categoryKeys) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ProductCategoryMembership" ("productId","categoryKey") VALUES ($1,$2)`,
      `${P}-${suffix}`, key,
    );
  }
}

type DraftOptions = {
  kind?: "GIFT_ITEM" | "QUANTITY_TIER";
  scopeMode?: "DYNAMIC_CATEGORY" | "FIXED_PRODUCT_SET" | "GLOBAL_ALL_PAID_LINES";
  categoryKeys?: string[];
  startsAt?: Date | null;
  endsAt?: Date | null;
  includes?: string[];
  excludes?: string[];
  enabled?: boolean;
  enabledAt?: Date | null;
  disabledAt?: Date | null;
};

async function draft(suffix: string, options: DraftOptions = {}) {
  const o = { kind: "GIFT_ITEM", scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"], startsAt: START, endsAt: END, ...options };
  const gift = o.kind === "GIFT_ITEM";
  const global = o.scopeMode === "GLOBAL_ALL_PAID_LINES";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign"
       ("id","kind","name","startsAt","endsAt","isEnabled","enabledAt","disabledAt","scopeMode","categoryKeys",
        "giftTrigger","minimumQuantity","minimumSubtotalVnd","subtotalScope","awardMode","tierUnit","tierDiscountedUnits","updatedAt")
     VALUES ($1,$2::"GiftQuantityCampaignKind",$3,$4,$5,$6,$7,$8,$9::"GiftQuantityScopeMode",$10::text[],
        $11::"GiftTrigger",$12,$13,$14::"GiftSubtotalScope",$15::"GiftAwardMode",$16::"QuantityTierDiscountUnit",$17::"QuantityTierDiscountedUnits",NOW())`,
    `${P}-${suffix}`, o.kind, `Campaign ${suffix}`, o.startsAt, o.endsAt, o.enabled ?? false, o.enabledAt ?? null, o.disabledAt ?? null,
    o.scopeMode, global ? [] : o.categoryKeys,
    gift ? (global ? "ORDER_SUBTOTAL" : "QUANTITY") : null,
    gift && !global ? 2 : null,
    gift && global ? 1_000_000 : null,
    gift && global ? "ALL_PAID_LINES" : null,
    gift && global ? "ONCE" : null,
    gift ? null : "PERCENTAGE",
    gift ? null : "ALL_ELIGIBLE_UNITS",
  );
  for (const id of o.includes ?? []) {
    await prisma.giftQuantityTarget.create({ data: { campaignId: `${P}-${suffix}`, productId: `${P}-${id}`, role: "INCLUDE" } });
  }
  for (const id of o.excludes ?? []) {
    await prisma.giftQuantityTarget.create({ data: { campaignId: `${P}-${suffix}`, productId: `${P}-${id}`, role: "EXCLUDE" } });
  }
}

async function revision(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ revision: bigint }>>`
    SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  return row?.revision ?? BigInt(-1);
}

async function frozenIds(suffix: string): Promise<string[]> {
  const rows = await prisma.giftQuantityFrozenProduct.findMany({ where: { campaignId: `${P}-${suffix}` }, orderBy: { productId: "asc" } });
  return rows.map((row) => row.productId.replace(`${P}-`, ""));
}

const campaign = (suffix: string) => prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id: `${P}-${suffix}` } });

test.beforeEach(async () => {
  await cleanup();
  await product("a", "setVay");
  await product("b", "setVay");
  await product("x", "phuKien");
});
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("gate OFF refuses publish and Scheduled edit, reads nothing, advances nothing — even with legacy activation ON", async () => {
  await draft("g");
  const before = await revision();
  for (const env of [{}, LEGACY_ON_ONLY, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }]) {
    const publish = await publishGiftQuantityCampaign({ campaignId: `${P}-g`, now: T0, session: ADMIN, env, validateRule: passRules });
    assert.deepEqual(publish, { ok: false, failure: { reason: "FEATURE_DISABLED" } });
    const edit = await editScheduledGiftQuantityCampaign({
      campaignId: `${P}-g`, now: T0, session: ADMIN, env, patch: { stackPriority: 3 }, validateRule: passRules,
    });
    assert.deepEqual(edit, { ok: false, failure: { reason: "FEATURE_DISABLED" } });
  }
  assert.equal(await revision(), before);
  const row = await campaign("g");
  assert.equal(row.isEnabled, false);
  assert.equal(row.revision, 1);
  assert.deepEqual(await frozenIds("g"), []);
});

test("authorization is checked first: a non-admin or missing session throws before anything else", async () => {
  await draft("auth");
  await assert.rejects(() => publishGiftQuantityCampaign({ campaignId: `${P}-auth`, now: T0, session: CUSTOMER, env: ON }));
  await assert.rejects(() => publishGiftQuantityCampaign({ campaignId: `${P}-auth`, now: T0, session: null, env: ON }));
  await assert.rejects(() => disableGiftQuantityCampaign({ campaignId: `${P}-auth`, now: T0, session: CUSTOMER }));
  await assert.rejects(() => endGiftQuantityCampaignEarly({ campaignId: `${P}-auth`, now: T0, session: null }));
  await assert.rejects(() =>
    editScheduledGiftQuantityCampaign({ campaignId: `${P}-auth`, now: T0, session: CUSTOMER, env: ON, patch: {} }),
  );
});

test("oversized campaign ids are refused before a transaction opens", async () => {
  const outcome = await publishGiftQuantityCampaign({ campaignId: "x".repeat(200), now: T0, session: ADMIN, env: ON });
  assert.deepEqual(outcome, { ok: false, failure: { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] } });
});

test("with the production rule validator a campaign cannot become effective yet (fail closed)", async () => {
  await draft("prod");
  const before = await revision();
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-prod`, now: T0, session: ADMIN, env: ON });
  assert.deepEqual(outcome, { ok: false, failure: { reason: "INVALID_RULE", errors: [RULE_VALIDATION_NOT_AVAILABLE] } });
  assert.equal(await revision(), before);
  assert.equal((await campaign("prod")).isEnabled, false);
  assert.deepEqual(await frozenIds("prod"), []);
});

test("publishing a Scheduled Fixed campaign freezes ids, frozenAt and revision in one commit; zero traffic at startsAt mutates nothing", async () => {
  await draft("fx");
  const before = await revision();
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-fx`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.frozenProductCount, 2);
  assert.equal(outcome.revision, before + BigInt(1));
  assert.equal(outcome.campaignRevision, 2);

  const row = await campaign("fx");
  assert.equal(row.isEnabled, true);
  assert.equal(row.revision, 2);
  assert.equal(row.frozenCampaignRevision, 2);
  assert.equal(row.frozenAt?.toISOString(), T0.toISOString());
  assert.deepEqual(await frozenIds("fx"), ["a", "b"]);
  assert.equal(deriveCampaignLifecycle({ ...row, now: T0 }).status, "SCHEDULED");

  // EX-20: product c joins the category after publish and before startsAt. Nothing runs at startsAt.
  await product("c", "setVay");
  const snapshotBefore = await campaign("fx");
  const revisionBefore = await revision();
  const atStart = new Date(START.getTime() + 1000);
  assert.equal(deriveCampaignLifecycle({ ...snapshotBefore, now: atStart }).status, "ACTIVE");
  assert.deepEqual(await frozenIds("fx"), ["a", "b"], "a category added later never joins the fixed set");
  const snapshotAfter = await campaign("fx");
  assert.equal(snapshotAfter.updatedAt.toISOString(), snapshotBefore.updatedAt.toISOString(), "no write at startsAt");
  assert.equal(await revision(), revisionBefore);
});

test("publish applies include/exclude (exclude wins) and freezes uncategorised explicit includes", async () => {
  await product("solo");
  await draft("inc", { includes: ["solo", "x"], excludes: ["b"] });
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-inc`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(outcome.ok, true);
  assert.deepEqual(await frozenIds("inc"), ["a", "solo", "x"]);
});

test("a Dynamic campaign freezes nothing and records no frozen audit", async () => {
  await draft("dyn", { scopeMode: "DYNAMIC_CATEGORY" });
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-dyn`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(outcome.ok && outcome.frozenProductCount, null);
  const row = await campaign("dyn");
  assert.equal(row.frozenAt, null);
  assert.equal(row.frozenCampaignRevision, null);
  assert.deepEqual(await frozenIds("dyn"), []);
});

test("a global all-paid scope publishes with no scope data; global on any other campaign is refused", async () => {
  await draft("glob", { scopeMode: "GLOBAL_ALL_PAID_LINES" });
  const ok = await publishGiftQuantityCampaign({ campaignId: `${P}-glob`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(ok.ok, true);
  assert.deepEqual(await frozenIds("glob"), []);

  // the DB already forbids it for a tier; for a gift with ORDER_SUBTOTAL+ELIGIBLE the scope validator must too
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","giftTrigger","minimumSubtotalVnd","subtotalScope","awardMode","updatedAt")
     VALUES ($1,'GIFT_ITEM','Eligible with no scope','DYNAMIC_CATEGORY',ARRAY[]::text[],'ORDER_SUBTOTAL',1000000,'ELIGIBLE_PAID_LINES','ONCE',NOW())`,
    `${P}-nosc`,
  );
  const refused = await publishGiftQuantityCampaign({ campaignId: `${P}-nosc`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.failure.reason, "INVALID_SCOPE");
});

test("an empty Fixed set is refused and rolls everything back", async () => {
  await draft("empty", { categoryKeys: ["aoDaiCuoi"] });
  const before = await revision();
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-empty`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(outcome, { ok: false, failure: { reason: "FROZEN_SET_INVALID", code: "scope-frozen-empty" } });
  assert.equal(await revision(), before);
  const row = await campaign("empty");
  assert.equal(row.isEnabled, false);
  assert.equal(row.revision, 1);
});

test("the freeze bound is reported, not truncated", async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     SELECT $1 || i, $2, $1 || i || '-ext', $1 || i || '-slug', 'bulk', NOW(), NOW(), NOW() FROM generate_series(1, $3::int) AS i`,
    `${P}-bulk`, SHOP, MAX_FROZEN_PRODUCTS + 1,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductCategoryMembership" ("productId","categoryKey") SELECT "id", 'setQuanAo' FROM "ProductMirror" WHERE "id" LIKE $1`,
    `${P}-bulk%`,
  );
  await draft("bulk", { categoryKeys: ["setQuanAo"] });
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-bulk`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(outcome, { ok: false, failure: { reason: "FROZEN_SET_INVALID", code: "scope-frozen-too-many" } });
  assert.equal((await campaign("bulk")).isEnabled, false);
});

test("illegal transitions: an Active campaign cannot be published again and is not editable as Scheduled", async () => {
  await draft("act", { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: END, enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z") });
  const publish = await publishGiftQuantityCampaign({ campaignId: `${P}-act`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(publish, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "ACTIVE" } });
  const edit = await editScheduledGiftQuantityCampaign({ campaignId: `${P}-act`, now: T0, session: ADMIN, env: ON, patch: { name: "x" }, validateRule: passRules });
  assert.deepEqual(edit, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "ACTIVE" } });
  const missing = await publishGiftQuantityCampaign({ campaignId: `${P}-none`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(missing, { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } });
});

test("publish validates the window: inverted and already-ended windows are refused", async () => {
  await draft("w1", { startsAt: END, endsAt: START });
  await draft("w2", { startsAt: null, endsAt: new Date("2026-10-01T00:00:00Z") });
  const inverted = await publishGiftQuantityCampaign({ campaignId: `${P}-w1`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(inverted, { ok: false, failure: { reason: "INVALID_INPUT", errors: ["WINDOW_NOT_POSITIVE"] } });
  const ended = await publishGiftQuantityCampaign({ campaignId: `${P}-w2`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.deepEqual(ended, { ok: false, failure: { reason: "INVALID_INPUT", errors: ["WINDOW_ALREADY_ENDED"] } });
});

test("Scheduled scope edit replaces the snapshot atomically and bumps both revisions", async () => {
  await draft("ed");
  await publishGiftQuantityCampaign({ campaignId: `${P}-ed`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  await product("c", "setQuanAo");
  const before = await revision();

  const outcome = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-ed`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setQuanAo"], includeProductIds: [], excludeProductIds: [] } },
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(await frozenIds("ed"), ["c"], "the whole snapshot is replaced, not merged");
  const row = await campaign("ed");
  assert.equal(row.revision, 3);
  assert.equal(row.frozenCampaignRevision, 3);
  assert.deepEqual(row.categoryKeys, ["setQuanAo"]);
  assert.equal(await revision(), before + BigInt(1));
});

test("Scheduled edits that do not touch scope keep the frozen ids and frozenAt", async () => {
  await draft("keep");
  await publishGiftQuantityCampaign({ campaignId: `${P}-keep`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  await product("c", "setVay"); // would join a re-freeze, must not join the kept snapshot
  const frozenAt = (await campaign("keep")).frozenAt?.toISOString();

  const window = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-keep`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { endsAt: new Date("2026-11-15T00:00:00Z"), stackPriority: 5, stackingEnabled: true },
  });
  assert.equal(window.ok, true);
  assert.deepEqual(await frozenIds("keep"), ["a", "b"]);
  const row = await campaign("keep");
  assert.equal(row.frozenAt?.toISOString(), frozenAt);
  assert.equal(row.frozenCampaignRevision, 2, "the snapshot keeps the revision it was taken at");
  assert.equal(row.revision, 3, "an effective edit still bumps the campaign revision");
  assert.equal(row.stackPriority, 5);

  // name only: not effective, nothing moves
  const revisionBefore = await revision();
  const nameOnly = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-keep`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { name: "  Renamed  " },
  });
  assert.equal(nameOnly.ok, true);
  assert.equal(await revision(), revisionBefore);
  const renamed = await campaign("keep");
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.revision, 3);
  assert.deepEqual(await frozenIds("keep"), ["a", "b"]);

  // an unchanged scope submitted again is not a scope change
  const same = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-keep`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"], includeProductIds: [], excludeProductIds: [] } },
  });
  assert.equal(same.ok, true);
  assert.deepEqual(await frozenIds("keep"), ["a", "b"], "a no-op scope resubmission does not re-freeze");
  assert.equal(await revision(), revisionBefore, "and is not effective");
});

test("a refused Scheduled edit leaves the stored campaign, scope rows and snapshot untouched", async () => {
  await draft("rf", { includes: ["x"] });
  await publishGiftQuantityCampaign({ campaignId: `${P}-rf`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const before = await campaign("rf");
  const revisionBefore = await revision();
  const idsBefore = await frozenIds("rf");

  const emptySet = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-rf`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["aoDaiCuoi"], includeProductIds: [], excludeProductIds: [] } },
  });
  assert.deepEqual(emptySet, { ok: false, failure: { reason: "FROZEN_SET_INVALID", code: "scope-frozen-empty" } });

  const badScope = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-rf`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { scope: { scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: ["setVay"], includeProductIds: [], excludeProductIds: [] } },
  });
  assert.equal(!badScope.ok && badScope.failure.reason, "INVALID_SCOPE");

  const badWindow = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-rf`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { startsAt: END, endsAt: START },
  });
  assert.equal(!badWindow.ok && badWindow.failure.reason, "INVALID_INPUT");

  const badName = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-rf`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { name: "   " },
  });
  assert.deepEqual(badName, { ok: false, failure: { reason: "INVALID_INPUT", errors: ["INVALID_NAME"] } });

  const after = await campaign("rf");
  assert.equal(after.updatedAt.toISOString(), before.updatedAt.toISOString());
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.categoryKeys, before.categoryKeys);
  assert.deepEqual(await frozenIds("rf"), idsBefore);
  assert.equal(await revision(), revisionBefore);
  assert.equal(await prisma.giftQuantityTarget.count({ where: { campaignId: `${P}-rf` } }), 1, "scope rows survived the rolled-back edit");
});

test("re-enabling a campaign disabled before it was active re-captures the Fixed set from current membership", async () => {
  await draft("re");
  await publishGiftQuantityCampaign({ campaignId: `${P}-re`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const firstFrozenAt = (await campaign("re")).frozenAt?.toISOString();

  const later = new Date("2026-10-14T00:00:00.000Z");
  const disabled = await disableGiftQuantityCampaign({ campaignId: `${P}-re`, now: later, session: ADMIN });
  assert.equal(disabled.ok, true);
  assert.deepEqual(await frozenIds("re"), ["a", "b"], "disable keeps the audit of what was frozen");

  await product("c", "setVay");
  const reenabled = await publishGiftQuantityCampaign({ campaignId: `${P}-re`, now: later, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(reenabled.ok, true);
  assert.deepEqual(await frozenIds("re"), ["a", "b", "c"]);
  const row = await campaign("re");
  assert.notEqual(row.frozenAt?.toISOString(), firstFrozenAt);
  assert.equal(row.frozenAt?.toISOString(), later.toISOString());
  assert.equal(row.revision, 4, "publish 2, disable 3, re-enable 4");
  assert.equal(row.frozenCampaignRevision, 4);
  assert.equal(row.disabledAt, null);
});

test("disable and end-early are not gated by the feature flag (the rollback path never fails)", async () => {
  await draft("kill", { enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-01T00:00:00Z") });
  const before = await revision();
  const ended = await endGiftQuantityCampaignEarly({ campaignId: `${P}-kill`, now: T0, session: ADMIN });
  assert.equal(ended.ok, true);
  assert.equal((await campaign("kill")).endsAt?.toISOString(), T0.toISOString());
  assert.equal(await revision(), before + BigInt(1));

  await draft("kill2", { enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-01T00:00:00Z") });
  const disabled = await disableGiftQuantityCampaign({ campaignId: `${P}-kill2`, now: T0, session: ADMIN });
  assert.equal(disabled.ok, true);
  assert.equal((await campaign("kill2")).isEnabled, false);
  const again = await disableGiftQuantityCampaign({ campaignId: `${P}-kill2`, now: T0, session: ADMIN });
  assert.deepEqual(again, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "DISABLED" } });
  const draftOnly = await endGiftQuantityCampaignEarly({ campaignId: `${P}-kill2`, now: T0, session: ADMIN });
  assert.equal(!draftOnly.ok && draftOnly.failure.reason, "ILLEGAL_TRANSITION");
});

test("concurrent publishes are serialized by the revision lock: each advances it exactly once", async () => {
  await draft("c1", { scopeMode: "DYNAMIC_CATEGORY" });
  await draft("c2", { scopeMode: "DYNAMIC_CATEGORY" });
  const before = await revision();
  const results = await Promise.all([
    publishGiftQuantityCampaign({ campaignId: `${P}-c1`, now: T0, session: ADMIN, env: ON, validateRule: passRules }),
    publishGiftQuantityCampaign({ campaignId: `${P}-c2`, now: T0, session: ADMIN, env: ON, validateRule: passRules }),
  ]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.equal(await revision(), before + BigInt(2));
  const revisions = results.map((result) => (result.ok ? result.revision : BigInt(0))).sort();
  assert.deepEqual(revisions, [before + BigInt(1), before + BigInt(2)]);
});

test("a rename is not effective: allowed while the gate is OFF and without rule validation, moving no revision", async () => {
  await draft("rn");
  await publishGiftQuantityCampaign({ campaignId: `${P}-rn`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const before = await revision();
  const renamed = await editScheduledGiftQuantityCampaign({ campaignId: `${P}-rn`, now: T0, session: ADMIN, env: {}, patch: { name: "Renamed while off" } });
  assert.equal(renamed.ok, true, "no gate and no rule validator involved for a pure rename");
  assert.equal(await revision(), before);
  assert.equal((await campaign("rn")).name, "Renamed while off");
});

test("a Scheduled edit can never clear or backdate startsAt, and an undefined key means not provided", async () => {
  await draft("st");
  await publishGiftQuantityCampaign({ campaignId: `${P}-st`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const before = await campaign("st");
  const revisionBefore = await revision();
  for (const startsAt of [null, new Date(T0.getTime() - 1000), T0]) {
    const refused = await editScheduledGiftQuantityCampaign({ campaignId: `${P}-st`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { startsAt } });
    assert.deepEqual(refused, { ok: false, failure: { reason: "INVALID_INPUT", errors: ["WINDOW_START_NOT_FUTURE"] } }, String(startsAt));
  }
  const undefinedKey = await editScheduledGiftQuantityCampaign({ campaignId: `${P}-st`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { name: "Only a name", startsAt: undefined, endsAt: undefined } });
  assert.equal(undefinedKey.ok, true);
  const after = await campaign("st");
  assert.equal(after.startsAt?.toISOString(), before.startsAt?.toISOString(), "an undefined start never clears it");
  assert.equal(deriveCampaignLifecycle({ ...after, now: T0 }).status, "SCHEDULED");
  assert.equal(await revision(), revisionBefore);
  // moving it later is fine
  const later = await editScheduledGiftQuantityCampaign({ campaignId: `${P}-st`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { startsAt: new Date("2026-10-25T00:00:00Z") } });
  assert.equal(later.ok, true);
});

test("disable only switches off a campaign that can still charge someone, and ending early bumps the campaign revision", async () => {
  await draft("dis-draft");
  const onDraft = await disableGiftQuantityCampaign({ campaignId: `${P}-dis-draft`, now: T0, session: ADMIN });
  assert.deepEqual(onDraft, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "DRAFT" } });

  await draft("dis-ended", { enabled: true, enabledAt: new Date("2026-09-01T00:00:00Z"), startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: new Date("2026-09-30T00:00:00Z") });
  const revisionBefore = await revision();
  const onEnded = await disableGiftQuantityCampaign({ campaignId: `${P}-dis-ended`, now: T0, session: ADMIN });
  assert.deepEqual(onEnded, { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: "ENDED" } });
  assert.equal(await revision(), revisionBefore, "history is not rewritten and no revision moves");
  assert.equal((await campaign("dis-ended")).isEnabled, true);

  await draft("dis-active", { enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-01T00:00:00Z") });
  const disabled = await disableGiftQuantityCampaign({ campaignId: `${P}-dis-active`, now: T0, session: ADMIN });
  assert.ok(disabled.ok && disabled.campaignRevision === 2);

  await draft("end-rev", { enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-01T00:00:00Z") });
  const ended = await endGiftQuantityCampaignEarly({ campaignId: `${P}-end-rev`, now: T0, session: ADMIN });
  assert.ok(ended.ok && ended.campaignRevision === 2);
  assert.equal((await campaign("end-rev")).revision, 2);
});

test("explicit excludes are removed before the freeze bound, so they cannot consume its budget", async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     SELECT $1 || i, $2, $1 || i || '-ext', $1 || i || '-slug', 'bulk', NOW(), NOW(), NOW() FROM generate_series(1, $3::int) AS i`,
    `${P}-bulk`, SHOP, MAX_FROZEN_PRODUCTS + 1,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductCategoryMembership" ("productId","categoryKey") SELECT "id", 'setQuanAo' FROM "ProductMirror" WHERE "id" LIKE $1`,
    `${P}-bulk%`,
  );
  await draft("bulk-ex", { categoryKeys: ["setQuanAo"], excludes: ["bulk1"] });
  const outcome = await publishGiftQuantityCampaign({ campaignId: `${P}-bulk-ex`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  assert.equal(outcome.ok && outcome.frozenProductCount, MAX_FROZEN_PRODUCTS);
  assert.equal((await frozenIds("bulk-ex")).includes("bulk1"), false);
});

test("candidate lookup: gate OFF reads nothing at all", async () => {
  await draft("cand", { scopeMode: "DYNAMIC_CATEGORY" });
  await publishGiftQuantityCampaign({ campaignId: `${P}-cand`, now: START, session: ADMIN, env: ON, validateRule: passRules });
  let calls = 0;
  const spy = new Proxy({}, { get: () => { calls += 1; throw new Error("database must not be touched"); } }) as unknown as GiftQuantityCandidateReadClient;
  for (const env of [{}, LEGACY_ON_ONLY]) {
    const lookup = await readActiveGiftQuantityCampaigns({ now: START, productIds: [`${P}-a`], client: spy, env });
    assert.deepEqual(lookup, { enabled: false, campaigns: [] });
  }
  assert.equal(calls, 0);
});

test("candidate lookup: ON returns only ACTIVE campaigns, with frozen membership limited to cart products", async () => {
  await draft("on-fx");
  await draft("on-dyn", { scopeMode: "DYNAMIC_CATEGORY" });
  await draft("on-draft", { scopeMode: "DYNAMIC_CATEGORY" });
  await publishGiftQuantityCampaign({ campaignId: `${P}-on-fx`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  await publishGiftQuantityCampaign({ campaignId: `${P}-on-dyn`, now: T0, session: ADMIN, env: ON, validateRule: passRules });

  const scheduledOnly = await readActiveGiftQuantityCampaigns({ now: T0, productIds: [`${P}-a`], env: ON });
  assert.equal(scheduledOnly.campaigns.filter((entry) => entry.campaign.id.startsWith(P)).length, 0, "Scheduled is not active");

  const lookup = await readActiveGiftQuantityCampaigns({ now: START, productIds: [`${P}-a`, `${P}-x`], env: ON });
  const mine = lookup.campaigns.filter((entry) => entry.campaign.id.startsWith(P));
  assert.deepEqual(mine.map((entry) => entry.campaign.id).sort(), [`${P}-on-dyn`, `${P}-on-fx`]);
  const fixed = mine.find((entry) => entry.campaign.id === `${P}-on-fx`);
  assert.deepEqual(fixed?.frozen?.productIds, [`${P}-a`], "only cart products that are in the frozen set are listed");
  assert.equal(fixed?.frozen?.campaignRevision, 2);
  assert.equal(mine.find((entry) => entry.campaign.id === `${P}-on-dyn`)?.frozen, null);

  const facts = await readScopeProductFacts({ productIds: [`${P}-a`, `${P}-x`, `${P}-nope`] });
  assert.deepEqual(facts, [
    { productId: `${P}-a`, categoryKeys: ["setVay"] },
    { productId: `${P}-x`, categoryKeys: ["phuKien"] },
    { productId: `${P}-nope`, categoryKeys: [] },
  ]);
});

test("an active Fixed campaign that was never frozen reports no snapshot instead of an invented audit", async () => {
  await draft("nofreeze", { enabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"), startsAt: new Date("2026-10-01T00:00:00Z") });
  const lookup = await readActiveGiftQuantityCampaigns({ now: T0, productIds: [`${P}-a`], env: ON });
  const entry = lookup.campaigns.find((candidate) => candidate.campaign.id === `${P}-nofreeze`);
  assert.ok(entry);
  assert.equal(entry.frozen, null);
});

test("candidate lookup is bounded by DISTINCT products and fails closed", async () => {
  const many = Array.from({ length: 201 }, (_, i) => `p${i}`);
  await assert.rejects(() => readActiveGiftQuantityCampaigns({ now: T0, productIds: many, env: ON }), /bounded/);
  await assert.rejects(() => readScopeProductFacts({ productIds: many }), /bounded/);
  // the same product on many cart lines is one product
  const sameProduct = Array(500).fill(`${P}-a`);
  await assert.doesNotReject(() => readActiveGiftQuantityCampaigns({ now: T0, productIds: sameProduct, env: ON }));
  await assert.doesNotReject(() => readScopeProductFacts({ productIds: sameProduct }));
  assert.ok(MAX_ACTIVE_GIFT_QUANTITY_CAMPAIGNS >= 1);
});

const throwingValidator = () => {
  throw new Error("the rule validator must not run for an edit that changes nothing a buyer is charged");
};

test("F03: a rename that re-sends every stored value is not an effective edit — ungated, unvalidated, no revision, frozen ids kept", async () => {
  await draft("f03");
  await publishGiftQuantityCampaign({ campaignId: `${P}-f03`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const stored = await campaign("f03");
  const before = await revision();
  const frozenBefore = await frozenIds("f03");

  // exactly what the admin form sends on a save: every field, unchanged, plus a new name
  for (const env of [{}, ON]) {
    const outcome = await editScheduledGiftQuantityCampaign({
      campaignId: `${P}-f03`, now: T0, session: ADMIN, env, validateRule: throwingValidator,
      patch: {
        kind: "GIFT_ITEM", giftTrigger: stored.giftTrigger, subtotalScope: stored.subtotalScope,
        name: `Renamed ${env === ON ? "on" : "off"}`,
        startsAt: stored.startsAt, endsAt: stored.endsAt,
        scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: [...stored.categoryKeys], includeProductIds: [], excludeProductIds: [] },
      },
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.equal(outcome.ok && outcome.campaignRevision, stored.revision, "the campaign revision does not move");
  }
  assert.equal(await revision(), before, "the shared pricing revision does not move");
  const after = await campaign("f03");
  assert.equal(after.revision, stored.revision);
  assert.equal(after.name, "Renamed on");
  assert.deepEqual(await frozenIds("f03"), frozenBefore);
  assert.equal(after.frozenAt?.toISOString(), stored.frozenAt?.toISOString());
});

test("F03: a save that changes nothing at all is a no-op even with the gate OFF; a real change is still gated", async () => {
  await draft("f03b");
  await publishGiftQuantityCampaign({ campaignId: `${P}-f03b`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const stored = await campaign("f03b");
  const before = await revision();
  const same = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-f03b`, now: T0, session: ADMIN, env: {}, validateRule: throwingValidator,
    patch: { startsAt: new Date(stored.startsAt!.getTime()), endsAt: new Date(stored.endsAt!.getTime()), stackingEnabled: stored.stackingEnabled, stackPriority: stored.stackPriority },
  });
  assert.equal(same.ok, true);
  assert.equal(await revision(), before);

  const moved = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-f03b`, now: T0, session: ADMIN, env: {}, patch: { endsAt: new Date("2026-11-15T00:00:00Z") },
  });
  assert.deepEqual(moved, { ok: false, failure: { reason: "FEATURE_DISABLED" } });
  assert.equal((await campaign("f03b")).endsAt?.toISOString(), stored.endsAt?.toISOString());
  assert.equal(await revision(), before);

  const real = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-f03b`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch: { endsAt: new Date("2026-11-15T00:00:00Z") },
  });
  assert.equal(real.ok, true);
  assert.equal(await revision(), before + BigInt(1));
  assert.equal((await campaign("f03b")).revision, stored.revision + 1);
});

test("F05: the trigger, subtotal scope and kind are not editable once Scheduled — a different value is refused, not ignored", async () => {
  await draft("f05");
  await publishGiftQuantityCampaign({ campaignId: `${P}-f05`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const stored = await campaign("f05");
  const before = await revision();
  const refuse = async (patch: Parameters<typeof editScheduledGiftQuantityCampaign>[0]["patch"]) =>
    editScheduledGiftQuantityCampaign({ campaignId: `${P}-f05`, now: T0, session: ADMIN, env: ON, validateRule: passRules, patch });

  assert.deepEqual(await refuse({ giftTrigger: "ORDER_SUBTOTAL" }), { ok: false, failure: { reason: "INVALID_INPUT", errors: ["GIFT_TRIGGER_NOT_EDITABLE_WHEN_SCHEDULED"] } });
  assert.deepEqual(await refuse({ giftTrigger: null }), { ok: false, failure: { reason: "INVALID_INPUT", errors: ["GIFT_TRIGGER_NOT_EDITABLE_WHEN_SCHEDULED"] } });
  assert.deepEqual(await refuse({ subtotalScope: "ALL_PAID_LINES" }), { ok: false, failure: { reason: "INVALID_INPUT", errors: ["GIFT_TRIGGER_NOT_EDITABLE_WHEN_SCHEDULED"] } });
  assert.deepEqual(await refuse({ kind: "QUANTITY_TIER" }), { ok: false, failure: { reason: "INVALID_INPUT", errors: ["KIND_IMMUTABLE"] } });
  // a refused edit — even one that also renames — leaves everything as it was
  assert.equal((await refuse({ name: "Sneaky", giftTrigger: "ORDER_SUBTOTAL" })).ok, false);
  const after = await campaign("f05");
  assert.deepEqual([after.name, after.giftTrigger, after.subtotalScope, after.revision], [stored.name, stored.giftTrigger, stored.subtotalScope, stored.revision]);
  assert.equal(await revision(), before);
  // the stored values themselves are accepted
  assert.equal((await refuse({ kind: "GIFT_ITEM", giftTrigger: stored.giftTrigger, subtotalScope: stored.subtotalScope })).ok, true);
});

test("F04: a product on both lists is persisted once, as excluded, by Scheduled edits — never a unique-constraint failure", async () => {
  await draft("f04", { categoryKeys: ["setVay"] });
  await publishGiftQuantityCampaign({ campaignId: `${P}-f04`, now: T0, session: ADMIN, env: ON, validateRule: passRules });
  const outcome = await editScheduledGiftQuantityCampaign({
    campaignId: `${P}-f04`, now: T0, session: ADMIN, env: ON, validateRule: passRules,
    patch: { scope: { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["setVay"], includeProductIds: [`${P}-x`, `${P}-a`], excludeProductIds: [`${P}-a`] } },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const targets = await prisma.giftQuantityTarget.findMany({ where: { campaignId: `${P}-f04` }, orderBy: { productId: "asc" } });
  assert.deepEqual(targets.map((t) => [t.productId.replace(`${P}-`, ""), t.role]), [["a", "EXCLUDE"], ["x", "INCLUDE"]]);
  assert.deepEqual(await frozenIds("f04"), ["b", "x"], "the excluded product is not frozen; the explicit include is");
});
