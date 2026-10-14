import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCartGiftSelectionService } from "../../src/commerce/cart-gift-selection.ts";
import {
  disableGiftQuantityCampaign,
  editScheduledGiftQuantityCampaign,
  publishGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-activation-service.ts";
import { parseGiftQuantityDraftForm, type GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "../../src/commerce/gift-quantity-admin-service.ts";
import { readGiftRule, type GiftRuleInput } from "../../src/commerce/gift-quantity-gift-rule.ts";
import { PROMOTION_REVISION_ID } from "../../src/commerce/promotion-activation-service.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq13";
const SHOP = 920_948;
const ON = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } as const;
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;
const CUSTOMER = { user: { id: "customer-1", role: "CUSTOMER" }, session: { id: "s-2" } } as const;
const NOW = new Date("2026-10-13T00:00:00.000Z");
const START = new Date("2026-10-20T00:00:00.000Z");
const END = new Date("2026-10-30T00:00:00.000Z");
const SYNCED = new Date("2026-10-01T00:00:00.000Z");

/** Variant ids by logical name, filled by `seedCatalog`. */
const v: Record<string, string> = {};

async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.cartGiftSelection.deleteMany({ where: { campaign: { name: { startsWith: P } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}

async function product(suffix: string, options: Readonly<{ stock?: number; price?: number; category?: string | null; variantActive?: boolean; productActive?: boolean }> = {}) {
  const { stock = 5, price = 100_000, category = null, variantActive = true, productActive = true } = options;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name: `GQ13 ${suffix}`,
      isActive: productActive, isPresent: true, syncedAt: SYNCED,
      variants: {
        create: {
          pancakeVariationId: `${P}-${suffix}-var`, color: "Black", size: "M", isActive: variantActive, isPresent: true,
          pancakeRetailPrice: price, pancakeRetailPriceAfterDiscount: price, syncedAt: SYNCED,
          warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh`, quantity: stock, syncedAt: SYNCED } },
        },
      },
    },
    include: { variants: true },
  });
  if (category !== null) await prisma.productCategoryMembership.create({ data: { productId: created.id, categoryKey: category } });
  v[suffix] = created.variants[0]!.id;
  return created;
}

async function revision(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ revision: bigint }>>`SELECT "revision" FROM "PromotionPricingRevision" WHERE "id" = ${PROMOTION_REVISION_ID}`;
  return row?.revision ?? BigInt(-1);
}

const quantityRule = (variantIds: readonly string[], overrides: Partial<GiftRuleInput> = {}): GiftRuleInput => ({
  minimumQuantity: 2, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: null, allowDuplicateGifts: false, variantIds, ...overrides,
});
const subtotalRule = (variantIds: readonly string[], overrides: Partial<GiftRuleInput> = {}): GiftRuleInput => ({
  minimumQuantity: null, minimumSubtotalVnd: 300_000, awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: 2, allowDuplicateGifts: true, variantIds, ...overrides,
});
const values = (name: string, giftRule: GiftRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}): GiftQuantityDraftValues => ({
  kind: "GIFT_ITEM", name: `${P} ${name}`, startsAt: START, endsAt: END, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
  includeProductIds: [], excludeProductIds: [], giftTrigger: "QUANTITY", subtotalScope: null, tierRule: null, giftRule, ...overrides,
});
const globalValues = (name: string, giftRule: GiftRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}) =>
  values(name, giftRule, { scopeMode: "GLOBAL_ALL_PAID_LINES", categoryKeys: [], giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES", ...overrides });

async function create(name: string, giftRule: GiftRuleInput | null, overrides: Partial<GiftQuantityDraftValues> = {}) {
  const outcome = await createDraftGiftQuantityCampaign({ values: values(name, giftRule, overrides), session: ADMIN });
  assert.equal(outcome.ok, true, show(outcome));
  return (outcome as Extract<typeof outcome, { ok: true }>).campaignId;
}
const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
const stored = (id: string) =>
  prisma.giftQuantityCampaign.findUniqueOrThrow({ where: { id }, include: { giftOptions: { orderBy: { variantId: "asc" } }, targets: true } });
const sortedIds = (ids: readonly string[]) => [...ids].sort();
const publish = (campaignId: string, now = NOW, env: Readonly<Record<string, string | undefined>> = ON) =>
  publishGiftQuantityCampaign({ campaignId, now, session: ADMIN, env });
const errorsOf = (outcome: { ok: boolean; failure?: { reason: string; errors?: readonly string[] } }) =>
  outcome.ok ? null : outcome.failure?.reason === "INVALID_RULE" || outcome.failure?.reason === "INVALID_INPUT" ? outcome.failure.errors : outcome.failure?.reason;

test.beforeEach(async () => {
  await cleanup();
  await product("paid", { price: 200_000, category: "setVay" });
  await product("g1");
  await product("g2");
  await product("g3");
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("create: a quantity gift Draft persists threshold, cap, duplicate policy and allowlist, and moves no revision", async () => {
  const before = await revision();
  const id = await create("qty", quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 3, allowDuplicateGifts: true, minimumQuantity: 4 }));
  const row = await stored(id);
  assert.equal(row.kind, "GIFT_ITEM");
  assert.equal(row.giftTrigger, "QUANTITY");
  assert.equal(row.minimumQuantity, 4);
  assert.equal(row.minimumSubtotalVnd, null);
  assert.equal(row.awardMode, null);
  assert.equal(row.maxGiftsPerOrder, 3);
  assert.equal(row.allowDuplicateGifts, true);
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), sortedIds([v.g1!, v.g2!]));
  assert.equal(row.isEnabled, false);
  assert.equal(row.revision, 1);
  assert.equal(await revision(), before, "a Draft write is not effective");
});

test("create: a subtotal gift Draft with the global scope persists T and the award mode", async () => {
  const outcome = await createDraftGiftQuantityCampaign({ values: globalValues("sub", subtotalRule([v.g3!])), session: ADMIN });
  assert.equal(outcome.ok, true, show(outcome));
  const row = await stored((outcome as Extract<typeof outcome, { ok: true }>).campaignId);
  assert.equal(row.giftTrigger, "ORDER_SUBTOTAL");
  assert.equal(row.minimumSubtotalVnd, BigInt(300_000));
  assert.equal(row.awardMode, "REPEAT_PER_THRESHOLD");
  assert.equal(row.minimumQuantity, null);
  assert.equal(row.scopeMode, "GLOBAL_ALL_PAID_LINES");
});

test("create: an unfinished rule is a valid Draft; a malformed or contradictory one writes nothing", async () => {
  await create("empty", quantityRule([], { minimumQuantity: null, allowDuplicateGifts: null }));
  await create("no-rule", null);
  const count = () => prisma.giftQuantityCampaign.count({ where: { name: { startsWith: P } } });
  const before = await count();
  const bad: Array<[string, GiftRuleInput, Partial<GiftQuantityDraftValues>]> = [
    ["zero", quantityRule([v.g1!], { minimumQuantity: 0 }), {}],
    ["huge", quantityRule([v.g1!], { minimumQuantity: 1_000_001 }), {}],
    ["cap", quantityRule([v.g1!], { maxGiftsPerOrder: 101 }), {}],
    ["duplicate-variant", quantityRule([v.g1!, v.g1!]), {}],
    ["subtotal-on-quantity", subtotalRule([v.g1!]), {}],
    ["quantity-on-subtotal", quantityRule([v.g1!]), { scopeMode: "DYNAMIC_CATEGORY", giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" }],
    ["threshold-without-trigger", quantityRule([v.g1!]), { giftTrigger: null }],
    ["bogus-mode", quantityRule([v.g1!], { awardMode: "ALWAYS" as unknown as "ONCE", minimumQuantity: null }), { giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" }],
    ["unknown-variant", quantityRule(["no-such-variant"]), {}],
  ];
  for (const [label, rule, overrides] of bad) {
    const outcome = await createDraftGiftQuantityCampaign({ values: values(`bad-${label}`, rule, overrides), session: ADMIN });
    assert.equal(outcome.ok, false, label);
    if (!outcome.ok) assert.equal(outcome.failure.reason, "INVALID_INPUT", label);
  }
  const tierWithGiftRule = await createDraftGiftQuantityCampaign({
    values: { ...values("bad-tier", quantityRule([v.g1!])), kind: "QUANTITY_TIER", giftTrigger: null },
    session: ADMIN,
  });
  assert.equal(tierWithGiftRule.ok, false);
  assert.equal(await count(), before);
});

test("read-back returns exactly what was written, and nothing for a tier, a missing or an oversized id", async () => {
  const rule = subtotalRule([v.g2!, v.g1!], { maxGiftsPerOrder: null });
  const id = (await createDraftGiftQuantityCampaign({ values: globalValues("readback", rule), session: ADMIN })) as { ok: true; campaignId: string };
  assert.deepEqual(await readGiftRule(prisma, id.campaignId), { ...rule, variantIds: sortedIds(rule.variantIds) });
  assert.equal(await readGiftRule(prisma, "missing"), null);
  assert.equal(await readGiftRule(prisma, "x".repeat(200)), null);
  const tier = await prisma.giftQuantityCampaign.create({ data: { kind: "QUANTITY_TIER", name: `${P} tier`, tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS" } });
  assert.equal(await readGiftRule(prisma, tier.id), null);
});

test("form round trip: the posted fields become the stored rule; a form without gift fields keeps it", async () => {
  const data = new FormData();
  for (const [key, value] of [
    ["kind", "GIFT_ITEM"], ["name", `${P} form`], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"], ["giftTrigger", "QUANTITY"],
    ["giftRuleForm", "on"], ["giftMinimumQuantity", "3"], ["giftMaxPerOrder", "2"], ["giftAllowDuplicates", "on"],
    ["giftVariantId", v.g1!], ["giftVariantId", ""], ["giftVariantId", v.g2!],
  ] as const) data.append(key, value);
  const parsed = parseGiftQuantityDraftForm(data);
  assert.equal(parsed.ok, true, show(parsed));
  if (!parsed.ok) return;
  const created = await createDraftGiftQuantityCampaign({ values: parsed.value, session: ADMIN });
  assert.equal(created.ok, true, show(created));
  if (!created.ok) return;
  const rule = await readGiftRule(prisma, created.campaignId);
  assert.deepEqual(rule, { minimumQuantity: 3, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: 2, allowDuplicateGifts: true, variantIds: sortedIds([v.g1!, v.g2!]) });

  // A later form that only renames (no gift fields at all) must leave the stored allowlist alone.
  const rename = new FormData();
  for (const [key, value] of [["kind", "GIFT_ITEM"], ["name", `${P} form renamed`], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"], ["giftTrigger", "QUANTITY"]] as const) rename.append(key, value);
  const renameParsed = parseGiftQuantityDraftForm(rename);
  assert.equal(renameParsed.ok, true);
  if (!renameParsed.ok) return;
  const edited = await editDraftGiftQuantityCampaign({ campaignId: created.campaignId, values: renameParsed.value, now: NOW, session: ADMIN });
  assert.equal(edited.ok, true, show(edited));
  assert.deepEqual(await readGiftRule(prisma, created.campaignId), rule);
  assert.equal((await stored(created.campaignId)).name, `${P} form renamed`);
});

test("edit Draft: the rule and the whole allowlist are replaced atomically; a refused edit leaves the stored rule intact", async () => {
  const id = await create("edit", quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 2 }));
  const before = await revision();
  const edited = await editDraftGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN,
    values: values("edit", quantityRule([v.g3!], { minimumQuantity: 5, maxGiftsPerOrder: null, allowDuplicateGifts: true })),
  });
  assert.equal(edited.ok, true, show(edited));
  const row = await stored(id);
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), [v.g3!], "the old options are gone");
  assert.equal(row.minimumQuantity, 5);
  assert.equal(row.maxGiftsPerOrder, null);
  assert.equal(row.allowDuplicateGifts, true);
  assert.equal(await revision(), before, "a Draft edit is not effective");

  const refused = await editDraftGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, values: values("edit", quantityRule(["no-such-variant"], { minimumQuantity: 9 })),
  });
  assert.equal(refused.ok, false);
  const after = await stored(id);
  assert.deepEqual(after.giftOptions.map((option) => option.variantId), [v.g3!]);
  assert.equal(after.minimumQuantity, 5);
});

test("edit Draft: changing the trigger with a rule that fits the new trigger clears the old thresholds", async () => {
  const id = await create("trigger", quantityRule([v.g1!]));
  const edited = await editDraftGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN,
    values: values("trigger", subtotalRule([v.g1!], { maxGiftsPerOrder: null }), { giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" }),
  });
  assert.equal(edited.ok, true, show(edited));
  const row = await stored(id);
  assert.equal(row.giftTrigger, "ORDER_SUBTOTAL");
  assert.equal(row.minimumQuantity, null);
  assert.equal(row.minimumSubtotalVnd, BigInt(300_000));
  assert.equal(row.awardMode, "REPEAT_PER_THRESHOLD");
});

test("publish: a finished quantity gift becomes effective, moves both revisions and keeps the allowlist", async () => {
  const id = await create("pub", quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 2 }));
  const before = await revision();
  const outcome = await publish(id);
  assert.equal(outcome.ok, true, show(outcome));
  assert.equal(await revision(), before + BigInt(1));
  const row = await stored(id);
  assert.equal(row.isEnabled, true);
  assert.equal(row.revision, 2);
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), sortedIds([v.g1!, v.g2!]));
});

test("publish: a finished global subtotal gift is accepted, one option with READY stock is enough", async () => {
  await product("dry", { stock: 0 });
  const created = await createDraftGiftQuantityCampaign({ values: globalValues("pub-global", subtotalRule([v.dry!, v.g1!])), session: ADMIN });
  assert.equal(created.ok, true, show(created));
  const outcome = await publish((created as { campaignId: string }).campaignId);
  assert.equal(outcome.ok, true, show(outcome));
});

test("publish refusals name what is wrong, write nothing and move no revision", async () => {
  await product("inactive", { variantActive: false });
  await product("hidden", { productActive: false });
  await product("dry", { stock: 0 });
  await product("combo");
  await product("part");
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: v.combo!, componentVariantId: v.part!, quantity: 1, syncedAt: SYNCED } });
  const cases: Array<[string, GiftRuleInput | null, readonly string[]]> = [
    ["unfinished", quantityRule([], { minimumQuantity: null, allowDuplicateGifts: null }), ["GIFT_MINIMUM_QUANTITY_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"]],
    ["no-rule", null, ["GIFT_MINIMUM_QUANTITY_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"]],
    ["no-options", quantityRule([]), ["GIFT_OPTIONS_EMPTY"]],
    ["no-duplicate-policy", quantityRule([v.g1!], { allowDuplicateGifts: null }), ["GIFT_DUPLICATE_POLICY_REQUIRED"]],
    ["inactive-variant", quantityRule([v.g1!, v.inactive!]), ["GIFT_VARIANT_UNAVAILABLE"]],
    ["inactive-product", quantityRule([v.hidden!]), ["GIFT_VARIANT_UNAVAILABLE"]],
    ["composite", quantityRule([v.g1!, v.combo!]), ["GIFT_VARIANT_COMPOSITE"]],
    ["no-ready-stock", quantityRule([v.dry!]), ["GIFT_NO_READY_STOCK"]],
  ];
  for (const [label, rule, expected] of cases) {
    const id = await create(`refuse-${label}`, rule);
    const before = await revision();
    const outcome = await publish(id);
    assert.deepEqual(errorsOf(outcome), expected, label);
    assert.equal(outcome.ok === false && outcome.failure.reason, "INVALID_RULE", label);
    assert.equal(await revision(), before, `${label}: no revision moves`);
    const row = await stored(id);
    assert.equal(row.isEnabled, false, label);
    assert.equal(row.revision, 1, label);
  }
});

test("publish: an unfinished subtotal rule needs the threshold, the award mode and a subtotal scope", async () => {
  const id = (await createDraftGiftQuantityCampaign({
    values: globalValues("sub-unfinished", subtotalRule([v.g1!], { minimumSubtotalVnd: null, awardMode: null })), session: ADMIN,
  })) as { ok: true; campaignId: string };
  const outcome = await publish(id.campaignId);
  assert.deepEqual(errorsOf(outcome), ["GIFT_MINIMUM_SUBTOTAL_REQUIRED", "GIFT_AWARD_MODE_REQUIRED"]);
});

test("publish: gate OFF refuses before reading anything; a customer session is rejected", async () => {
  const id = await create("gate", quantityRule([v.g1!]));
  const before = await revision();
  for (const env of [{}, { LA_PROMOTION_ACTIVATION_ENABLED: "true" }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "1" }]) {
    const refused = await publish(id, NOW, env);
    assert.equal(refused.ok === false && refused.failure.reason, "FEATURE_DISABLED");
  }
  await assert.rejects(() => publishGiftQuantityCampaign({ campaignId: id, now: NOW, session: CUSTOMER, env: ON }));
  assert.equal(await revision(), before);
  assert.equal((await stored(id)).isEnabled, false);
});

test("re-enable re-validates the allowlist: a variant that became composite blocks it, and removing it unblocks", async () => {
  const id = await create("reenable", quantityRule([v.g1!, v.g2!]));
  assert.equal((await publish(id)).ok, true);
  const disabled = await disableGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN });
  assert.equal(disabled.ok, true, show(disabled));
  await product("part2");
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: v.g2!, componentVariantId: v.part2!, quantity: 1, syncedAt: SYNCED } });
  const before = await revision();
  const refused = await publish(id, NOW);
  assert.deepEqual(errorsOf(refused), ["GIFT_VARIANT_COMPOSITE"]);
  assert.equal(await revision(), before);
  assert.equal((await stored(id)).isEnabled, false);
  await prisma.compositeComponentMirror.deleteMany({ where: { parentVariantId: v.g2! } });
  assert.equal((await publish(id, NOW)).ok, true);
});

async function scheduled(name: string, rule: GiftRuleInput) {
  const id = await create(name, rule);
  const outcome = await publish(id);
  assert.equal(outcome.ok, true, show(outcome));
  return id;
}
const patchFrom = (id: string, giftRule: GiftRuleInput) => ({
  campaignId: id, now: NOW, session: ADMIN, env: ON, patch: { kind: "GIFT_ITEM" as const, giftTrigger: "QUANTITY" as const, giftRule },
});

test("Scheduled edit: a real change replaces the rule and allowlist and moves both revisions in one commit", async () => {
  const id = await scheduled("sched", quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 2 }));
  const before = await revision();
  const edited = await editScheduledGiftQuantityCampaign(patchFrom(id, quantityRule([v.g3!], { minimumQuantity: 6, maxGiftsPerOrder: null, allowDuplicateGifts: true })));
  assert.equal(edited.ok, true, show(edited));
  assert.equal(await revision(), before + BigInt(1));
  const row = await stored(id);
  assert.equal(row.revision, 3);
  assert.equal(row.minimumQuantity, 6);
  assert.equal(row.maxGiftsPerOrder, null);
  assert.equal(row.allowDuplicateGifts, true);
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), [v.g3!]);
  assert.equal(row.isEnabled, true);
});

test("Scheduled edit: re-sending the stored rule (options reordered) or only renaming is not an effective edit", async () => {
  const rule = quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 2 });
  const id = await scheduled("sched-noop", rule);
  const before = await revision();
  const same = await editScheduledGiftQuantityCampaign(patchFrom(id, { ...rule, variantIds: [v.g2!, v.g1!] }));
  assert.equal(same.ok, true, show(same));
  const renamed = await editScheduledGiftQuantityCampaign({ campaignId: id, now: NOW, session: ADMIN, env: {}, patch: { name: `${P} sched-noop renamed` } });
  assert.equal(renamed.ok, true, show(renamed));
  assert.equal(await revision(), before, "neither moves the durable revision");
  const row = await stored(id);
  assert.equal(row.revision, 2, "nor the campaign revision");
  assert.equal(row.name, `${P} sched-noop renamed`);
});

test("Scheduled edit: gate OFF refuses a real rule change but not the re-sent stored rule", async () => {
  const rule = quantityRule([v.g1!]);
  const id = await scheduled("sched-gate", rule);
  const sameOff = await editScheduledGiftQuantityCampaign({ ...patchFrom(id, rule), env: {} });
  assert.equal(sameOff.ok, true, show(sameOff));
  const changedOff = await editScheduledGiftQuantityCampaign({ ...patchFrom(id, quantityRule([v.g1!], { minimumQuantity: 9 })), env: {} });
  assert.equal(changedOff.ok === false && changedOff.failure.reason, "FEATURE_DISABLED");
  assert.equal((await stored(id)).minimumQuantity, 2);
});

test("Scheduled edit: a rule the trigger does not own, malformed input and a tier campaign are refused and change nothing", async () => {
  const id = await scheduled("sched-bad", quantityRule([v.g1!, v.g2!]));
  const before = await revision();
  const wrongTrigger = await editScheduledGiftQuantityCampaign(patchFrom(id, subtotalRule([v.g1!])));
  assert.deepEqual(errorsOf(wrongTrigger), ["GIFT_FIELD_NOT_APPLICABLE"]);
  for (const bad of [quantityRule([v.g1!], { minimumQuantity: 0 }), quantityRule([v.g1!, v.g1!]), quantityRule([v.g1!], { maxGiftsPerOrder: 500 })]) {
    const outcome = await editScheduledGiftQuantityCampaign(patchFrom(id, bad));
    assert.equal(outcome.ok === false && outcome.failure.reason, "INVALID_INPUT");
  }
  const tier = await prisma.giftQuantityCampaign.create({
    data: { kind: "QUANTITY_TIER", name: `${P} sched-tier`, startsAt: START, endsAt: END, tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", isEnabled: true, enabledAt: NOW, tiers: { create: { minQuantity: 2, discountValue: 10 } } },
  });
  const onTier = await editScheduledGiftQuantityCampaign({ campaignId: tier.id, now: NOW, session: ADMIN, env: ON, patch: { giftRule: quantityRule([v.g1!]) } });
  assert.deepEqual(errorsOf(onTier), ["GIFT_FIELDS_ON_TIER"]);
  assert.equal(await revision(), before);
  const row = await stored(id);
  assert.equal(row.revision, 2);
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), sortedIds([v.g1!, v.g2!]));
});

test("Scheduled edit: an allowlist that fails publish rules is refused and rolled back whole", async () => {
  await product("combo2");
  await product("part3");
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: v.combo2!, componentVariantId: v.part3!, quantity: 1, syncedAt: SYNCED } });
  const id = await scheduled("sched-rollback", quantityRule([v.g1!, v.g2!]));
  const before = await revision();
  const outcome = await editScheduledGiftQuantityCampaign(patchFrom(id, quantityRule([v.g3!, v.combo2!], { minimumQuantity: 7 })));
  assert.deepEqual(errorsOf(outcome), ["GIFT_VARIANT_COMPOSITE"]);
  assert.equal(await revision(), before);
  const row = await stored(id);
  assert.equal(row.revision, 2);
  assert.equal(row.minimumQuantity, 2, "the threshold did not change either");
  assert.deepEqual(row.giftOptions.map((option) => option.variantId), sortedIds([v.g1!, v.g2!]));
});

test("Scheduled edit: the form-built patch carries the gift rule exactly like the Server Action does", async () => {
  const id = await scheduled("sched-form", quantityRule([v.g1!]));
  const data = new FormData();
  for (const [key, value] of [
    ["kind", "GIFT_ITEM"], ["name", `${P} sched-form`], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"], ["giftTrigger", "QUANTITY"],
    ["startsAt", "2026-10-20T07:00"], ["endsAt", "2026-10-30T07:00"],
    ["giftRuleForm", "on"], ["giftMinimumQuantity", "8"], ["giftAllowDuplicates", "off"], ["giftVariantId", v.g2!],
  ] as const) data.append(key, value);
  const parsed = parseGiftQuantityDraftForm(data);
  assert.equal(parsed.ok, true, show(parsed));
  if (!parsed.ok) return;
  const submitted = parsed.value;
  const edited = await editScheduledGiftQuantityCampaign({
    campaignId: id, now: NOW, session: ADMIN, env: ON,
    patch: {
      kind: submitted.kind, giftTrigger: submitted.giftTrigger, subtotalScope: submitted.subtotalScope, name: submitted.name,
      scope: { scopeMode: submitted.scopeMode, categoryKeys: submitted.categoryKeys, includeProductIds: submitted.includeProductIds, excludeProductIds: submitted.excludeProductIds },
      ...(submitted.giftRule ? { giftRule: submitted.giftRule } : {}),
    },
  });
  assert.equal(edited.ok, true, show(edited));
  assert.deepEqual(await readGiftRule(prisma, id), { minimumQuantity: 8, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: null, allowDuplicateGifts: false, variantIds: [v.g2!] });
});

test("copy: a gift Draft copy keeps the thresholds and the allowlist verbatim, and publishes on its own", async () => {
  const sourceId = await create("copy-src", quantityRule([v.g1!, v.g2!], { maxGiftsPerOrder: 4, allowDuplicateGifts: true, minimumQuantity: 3 }));
  const copied = await copyGiftQuantityCampaign({ campaignId: sourceId, session: ADMIN });
  assert.equal(copied.ok, true, show(copied));
  if (!copied.ok) return;
  assert.notEqual(copied.campaignId, sourceId);
  assert.deepEqual(await readGiftRule(prisma, copied.campaignId), await readGiftRule(prisma, sourceId));
  const row = await stored(copied.campaignId);
  assert.equal(row.isEnabled, false);
  assert.equal(row.revision, 1);
  assert.equal((await publish(copied.campaignId)).ok, true);
  assert.equal((await stored(sourceId)).isEnabled, false, "the source is untouched");
});

test("end to end: a gift built through GQ13a is consumed by the cart gift service and earns the expected slots", async () => {
  const id = await create("e2e", quantityRule([v.g1!, v.g2!], { minimumQuantity: 2, maxGiftsPerOrder: 2 }), { startsAt: null, endsAt: null });
  assert.equal((await publish(id)).ok, true);
  const cart = await prisma.cart.create({
    data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: { variantId: v.paid!, quantity: 5 } } },
  });
  const service = createCartGiftSelectionService(prisma, { get: () => ({ value: cart.id }) }, { shopId: SHOP, env: ON });
  const state = await service.get(NOW);
  assert.ok("state" in state, "expected a gift state from get()");
  const entitlement = state.state.entitlements.find((entry) => entry.campaignId === id);
  assert.ok(entitlement !== undefined);
  assert.equal(entitlement.eligibleQuantity, 5);
  assert.equal(entitlement.earned, 2);
  assert.equal(entitlement.entitled, 2);
  assert.equal(entitlement.grantable, 2, "two distinct products, duplicates not allowed");
  assert.deepEqual(entitlement.selectableOptions.map((option) => option.variantId), sortedIds([v.g1!, v.g2!]));
  assert.deepEqual(await service.set({ campaignId: id, variantId: v.g1!, quantity: 1, campaignRevision: 2 }, NOW), { ok: true });
});
