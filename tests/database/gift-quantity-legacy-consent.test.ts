import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  clearLegacyPromotionStackConsent,
  createLegacyConsentReader,
  setLegacyPromotionStackConsent,
} from "../../src/commerce/gift-quantity-legacy-consent.ts";
import {
  createDraftPromotionCampaign,
  disablePromotionCampaign,
  editDraftPromotionCampaign,
  PROMOTION_REVISION_ID,
  publishPromotionCampaign,
} from "../../src/commerce/promotion-activation-service.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq09c";
const SHOP = 920_947;
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const NOW = new Date("2026-10-13T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "name" LIKE ${`${P}%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${P}-%`} OR "name" LIKE ${`${P}%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${P}-%`}`;
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

const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
const errorsOf = (outcome: { ok: boolean; failure?: { reason: string; errors?: readonly string[] } }) =>
  outcome.ok === false && outcome.failure?.reason === "INVALID_RULE" ? outcome.failure.errors : null;

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("legacy consent: set / change / clear, gated and revision-advancing only while the campaign is live", async () => {
  const live = await legacy("live");
  const draft = await legacy("draft", { isEnabled: false });
  const before = await revision();

  const gateOff = await setLegacyPromotionStackConsent({ campaignId: live, stackPriority: 1, now: NOW, session: ADMIN, env: {} });
  assert.equal(gateOff.ok === false && gateOff.failure.reason, "FEATURE_DISABLED");
  assert.equal(await prisma.legacyPromotionStackConsent.count({ where: { campaignId: live } }), 0);
  assert.equal(await revision(), before, "a gated refusal advances nothing");

  const set = await setLegacyPromotionStackConsent({ campaignId: live, stackPriority: 1, now: NOW, session: ADMIN, env: ON });
  assert.equal(set.ok && set.changed, true);
  assert.equal(await revision(), before + BigInt(1), "a live campaign's consent changes quotes");
  const same = await setLegacyPromotionStackConsent({ campaignId: live, stackPriority: 1, now: NOW, session: ADMIN, env: ON });
  assert.equal(same.ok && same.changed, false);
  assert.equal(await revision(), before + BigInt(1), "an unchanged consent is a no-op");

  const onDraft = await setLegacyPromotionStackConsent({ campaignId: draft, stackPriority: 2, now: NOW, session: ADMIN, env: ON });
  assert.equal(onDraft.ok, true);
  assert.equal(await revision(), before + BigInt(1), "a Draft is not effective");

  const clash = await setLegacyPromotionStackConsent({ campaignId: draft, stackPriority: 1, now: NOW, session: ADMIN, env: ON });
  assert.deepEqual(errorsOf(clash), ["STACK_PRIORITY_CONFLICT"]);

  // Clearing works with the gate off and advances the revision for a live campaign.
  const cleared = await clearLegacyPromotionStackConsent({ campaignId: live, session: ADMIN });
  assert.equal(cleared.ok && cleared.changed, true);
  assert.equal(await revision(), before + BigInt(2));
  const again = await clearLegacyPromotionStackConsent({ campaignId: live, session: ADMIN });
  assert.equal(again.ok && again.changed, false);
});

test("legacy consent: the priority is unique against enabled tier campaigns too, and a gift's priority is ignored", async () => {
  const legacyId = await legacy("leg");
  const tier = (name: string, priority: number, kind: "QUANTITY_TIER" | "GIFT_ITEM", extra: { isEnabled?: boolean; endsAt?: Date } = {}) =>
    prisma.giftQuantityCampaign.create({
      data: {
        kind, name: `${P} ${name}`, isEnabled: extra.isEnabled ?? true, enabledAt: NOW, endsAt: extra.endsAt ?? null,
        stackingEnabled: true, stackPriority: priority, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
        ...(kind === "QUANTITY_TIER" ? { tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS" } : { giftTrigger: "QUANTITY" }),
      },
    });
  await tier("tier-live", 3, "QUANTITY_TIER");
  await tier("tier-off", 4, "QUANTITY_TIER", { isEnabled: false });
  await tier("tier-ended", 5, "QUANTITY_TIER", { endsAt: new Date("2026-10-01T00:00:00Z") });
  await tier("gift", 6, "GIFT_ITEM");
  const set = (stackPriority: number) => setLegacyPromotionStackConsent({ campaignId: legacyId, stackPriority, now: NOW, session: ADMIN, env: ON });
  assert.deepEqual(errorsOf(await set(3)), ["STACK_PRIORITY_CONFLICT"]);
  for (const free of [4, 5, 6]) assert.equal((await set(free)).ok, true, `priority ${free} is free`);
});

test("legacy consent: bounds, unknown and ended campaigns are refused; authorization comes first", async () => {
  const ended = await legacy("ended", { endsAt: new Date("2026-10-01T00:00:00Z") });
  const live = await legacy("bounds");
  const set = (campaignId: string, stackPriority: number) =>
    setLegacyPromotionStackConsent({ campaignId, stackPriority, now: NOW, session: ADMIN, env: ON });
  assert.equal((await set("missing", 1)).ok, false);
  assert.equal((await set(ended, 1)).ok, false);
  for (const bad of [-1, 1.5, 2_000_000, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await set(live, bad)).ok, false);
  assert.equal((await set("x".repeat(500), 1)).ok, false, "an unbounded id is refused");
  assert.equal(await prisma.legacyPromotionStackConsent.count({ where: { campaignId: { startsWith: P } } }), 0);

  await assert.rejects(() => setLegacyPromotionStackConsent({ campaignId: live, stackPriority: 1, now: NOW, session: null, env: ON }));
  await assert.rejects(() => setLegacyPromotionStackConsent({ campaignId: live, stackPriority: 1, now: NOW, session: { user: { id: "u", role: "USER" }, session: { id: "s" } }, env: ON }));
  await assert.rejects(() => clearLegacyPromotionStackConsent({ campaignId: live, session: undefined }));
});

test("the consent reader returns only campaigns that opted in, in one bounded query", async () => {
  const a = await legacy("ra");
  const b = await legacy("rb");
  await setLegacyPromotionStackConsent({ campaignId: a, stackPriority: 5, now: NOW, session: ADMIN, env: ON });
  const read = createLegacyConsentReader(prisma as never);
  const map = await read([a, b, a]);
  assert.deepEqual([...map.entries()], [[a, { priority: 5 }]]);
  assert.equal((await read([])).size, 0);
  await assert.rejects(() => read(Array.from({ length: 201 }, (_, i) => `x${i}`)));
});

test("the consent table enforces its own bounds and its foreign key below the application", async () => {
  const id = await legacy("dbc");
  for (const bad of [-1, 1_000_001]) {
    await assert.rejects(() => prisma.legacyPromotionStackConsent.create({ data: { campaignId: id, stackPriority: bad } }), `priority ${bad}`);
  }
  await assert.rejects(() => prisma.legacyPromotionStackConsent.create({ data: { campaignId: `${P}-missing`, stackPriority: 1 } }));
  await prisma.legacyPromotionStackConsent.create({ data: { campaignId: id, stackPriority: 0 } });
  await assert.rejects(() => prisma.legacyPromotionStackConsent.create({ data: { campaignId: id, stackPriority: 1 } }), "one consent per campaign");
});

test("legacy parity: legacy create / edit / publish / disable behave as before with the consent table present, and consent is separate", async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'GQ09c product',NOW(),NOW(),NOW())`,
    `${P}-a`, SHOP, `${P}-a-ext`, `${P}-a-slug`,
  );
  await prisma.variantMirror.create({ data: { id: `${P}-a-v`, pancakeVariationId: `${P}-a-var`, productId: `${P}-a`, pancakeRetailPrice: 500_000, syncedAt: NOW } });

  const LEG_ON = { LA_PROMOTION_ACTIVATION_ENABLED: "true" } as const;
  const created = await createDraftPromotionCampaign({
    name: `${P} legacy flow`, kind: "PROMOTION", discountType: "PERCENTAGE", percentageValue: 10,
    targets: [{ productId: `${P}-a`, variantId: null }], session: ADMIN,
  });
  assert.equal(created.ok, true, show(created));
  if (!created.ok) return;
  const id = created.campaignId;
  const base = await revision();
  const edited = await editDraftPromotionCampaign({ campaignId: id, now: NOW, session: ADMIN, patch: { percentageValue: 20 } });
  assert.equal(edited.ok, true, show(edited));
  assert.equal(await revision(), base, "a legacy Draft edit is still not effective");

  // Consent exists beside the campaign, never on it.
  assert.equal((await setLegacyPromotionStackConsent({ campaignId: id, stackPriority: 61, now: NOW, session: ADMIN, env: ON })).ok, true);
  assert.equal(await revision(), base, "a Draft's consent is not effective");

  const published = await publishPromotionCampaign({ campaignId: id, now: NOW, session: ADMIN, env: LEG_ON });
  assert.equal(published.ok, true, show(published));
  assert.equal(await revision(), base + BigInt(1));
  const legacyRow = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id } });
  assert.equal(legacyRow.percentageValue, 20);
  assert.equal(legacyRow.isEnabled, true);
  assert.equal((await setLegacyPromotionStackConsent({ campaignId: id, stackPriority: 62, now: NOW, session: ADMIN, env: ON })).ok, true);
  assert.equal(await revision(), base + BigInt(2), "consent on a live campaign is effective");
  assert.equal((await disablePromotionCampaign({ campaignId: id, now: NOW, session: ADMIN })).ok, true);
  // Deleting the legacy campaign takes its consent with it.
  await prisma.promotionCampaign.delete({ where: { id } });
  assert.equal(await prisma.legacyPromotionStackConsent.count({ where: { campaignId: id } }), 0);
});
