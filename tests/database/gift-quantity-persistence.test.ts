import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const PREFIX = "gq03";

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" LIKE ${`${PREFIX}-%`}`;
  await prisma.$executeRaw`DELETE FROM "PromotionCampaign" WHERE "id" LIKE ${`${PREFIX}-%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${PREFIX}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${PREFIX}-%`}`;
}

before(async () => {
  await cleanup();
  await prisma.$executeRaw`
    INSERT INTO "ProductMirror" ("id", "pancakeShopId", "pancakeProductId", "slug", "name", "syncedAt", "createdAt", "updatedAt")
    VALUES (${`${PREFIX}-product`}, 920007, ${`${PREFIX}-ext-product`}, ${`${PREFIX}-slug`}, 'GQ03 product', NOW(), NOW(), NOW()),
           (${`${PREFIX}-product-2`}, 920007, ${`${PREFIX}-ext-product-2`}, ${`${PREFIX}-slug-2`}, 'GQ03 product 2', NOW(), NOW(), NOW())
  `;
  await prisma.$executeRaw`
    INSERT INTO "VariantMirror" ("id", "pancakeVariationId", "productId", "syncedAt", "createdAt", "updatedAt")
    VALUES (${`${PREFIX}-variant`}, ${`${PREFIX}-ext-variation`}, ${`${PREFIX}-product`}, NOW(), NOW(), NOW())
  `;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

type CampaignRow = {
  id: string;
  kind: "GIFT_ITEM" | "QUANTITY_TIER";
  name?: string;
  scopeMode?: string;
  categoryKeys?: string[];
  giftTrigger?: string | null;
  minimumQuantity?: number | null;
  minimumSubtotalVnd?: bigint | null;
  subtotalScope?: string | null;
  awardMode?: string | null;
  maxGiftsPerOrder?: number | null;
  allowDuplicateGifts?: boolean | null;
  tierUnit?: string | null;
  tierDiscountedUnits?: string | null;
  tierSelectionPriority?: string | null;
  stackPriority?: number | null;
  frozenAt?: string | null;
  frozenCampaignRevision?: number | null;
  revision?: number;
};

async function insertCampaign(row: CampaignRow) {
  const v = {
    name: "GQ03 campaign",
    scopeMode: "DYNAMIC_CATEGORY",
    categoryKeys: [] as string[],
    giftTrigger: null,
    minimumQuantity: null,
    minimumSubtotalVnd: null,
    subtotalScope: null,
    awardMode: null,
    maxGiftsPerOrder: null,
    allowDuplicateGifts: null,
    tierUnit: null,
    tierDiscountedUnits: null,
    tierSelectionPriority: null,
    stackPriority: null,
    frozenAt: null,
    frozenCampaignRevision: null,
    revision: 1,
    ...row,
  };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign"
      ("id","kind","name","scopeMode","categoryKeys","giftTrigger","minimumQuantity","minimumSubtotalVnd",
       "subtotalScope","awardMode","maxGiftsPerOrder","allowDuplicateGifts","tierUnit","tierDiscountedUnits",
       "tierSelectionPriority","stackPriority","frozenAt","frozenCampaignRevision","revision","updatedAt")
     VALUES ($1,$2::"GiftQuantityCampaignKind",$3,$4::"GiftQuantityScopeMode",$5::text[],$6::"GiftTrigger",$7,$8,
       $9::"GiftSubtotalScope",$10::"GiftAwardMode",$11,$12,$13::"QuantityTierDiscountUnit",
       $14::"QuantityTierDiscountedUnits",$15::"QuantityTierSelectionPriority",$16,$17::timestamp,$18,$19,NOW())`,
    v.id, v.kind, v.name, v.scopeMode, v.categoryKeys, v.giftTrigger, v.minimumQuantity, v.minimumSubtotalVnd,
    v.subtotalScope, v.awardMode, v.maxGiftsPerOrder, v.allowDuplicateGifts, v.tierUnit, v.tierDiscountedUnits,
    v.tierSelectionPriority, v.stackPriority, v.frozenAt, v.frozenCampaignRevision, v.revision,
  );
}

async function rejects(operation: () => Promise<unknown>, constraint: string | RegExp) {
  await assert.rejects(operation, (error: unknown) => {
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    return typeof constraint === "string" ? text.includes(constraint) : constraint.test(text);
  });
}

const gift = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id: `${PREFIX}-${id}`,
  kind: "GIFT_ITEM",
  giftTrigger: "QUANTITY",
  minimumQuantity: 2,
  allowDuplicateGifts: false,
  ...extra,
});
const tier = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id: `${PREFIX}-${id}`,
  kind: "QUANTITY_TIER",
  tierUnit: "PERCENTAGE",
  tierDiscountedUnits: "ALL_ELIGIBLE_UNITS",
  ...extra,
});

test("config round-trips: gift campaign with scope targets, frozen set, options and stack peers", async () => {
  await insertCampaign(
    gift("rt-gift", {
      scopeMode: "FIXED_PRODUCT_SET",
      categoryKeys: ["aoDai", "setVay"],
      maxGiftsPerOrder: 3,
      stackPriority: 10,
      frozenAt: "2026-10-13T00:00:00Z",
      frozenCampaignRevision: 1,
    }),
  );
  await prisma.giftQuantityTarget.createMany({
    data: [
      { campaignId: `${PREFIX}-rt-gift`, productId: `${PREFIX}-product`, role: "INCLUDE" },
      { campaignId: `${PREFIX}-rt-gift`, productId: `${PREFIX}-product-2`, role: "EXCLUDE" },
    ],
  });
  await prisma.giftQuantityFrozenProduct.create({
    data: { campaignId: `${PREFIX}-rt-gift`, productId: `${PREFIX}-product` },
  });
  await prisma.giftOption.create({ data: { campaignId: `${PREFIX}-rt-gift`, variantId: `${PREFIX}-variant` } });
  await prisma.giftQuantityStackPeer.createMany({
    data: [
      { campaignId: `${PREFIX}-rt-gift`, peerKind: "FLASH_SALE", peerCampaignId: "*" },
      { campaignId: `${PREFIX}-rt-gift`, peerKind: "PROMOTION", peerCampaignId: "some-campaign-id" },
    ],
  });

  const read = await prisma.giftQuantityCampaign.findUniqueOrThrow({
    where: { id: `${PREFIX}-rt-gift` },
    include: { targets: true, frozen: true, giftOptions: true, stackPeers: true, tiers: true },
  });
  assert.equal(read.kind, "GIFT_ITEM");
  assert.equal(read.isEnabled, false, "a new campaign is never enabled");
  assert.equal(read.revision, 1);
  assert.deepEqual(read.categoryKeys, ["aoDai", "setVay"]);
  assert.equal(read.scopeMode, "FIXED_PRODUCT_SET");
  assert.equal(read.maxGiftsPerOrder, 3);
  assert.equal(read.targets.length, 2);
  assert.equal(read.frozen.length, 1);
  assert.equal(read.giftOptions.length, 1);
  assert.equal(read.stackPeers.length, 2);
  assert.equal(read.tiers.length, 0);
});

test("config round-trips: tier campaign with ordered tiers and one discount unit", async () => {
  await insertCampaign(tier("rt-tier", { tierDiscountedUnits: "FROM_REACHED_THRESHOLD", tierSelectionPriority: "CHEAPEST_FIRST" }));
  await prisma.quantityTier.createMany({
    data: [
      { campaignId: `${PREFIX}-rt-tier`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 10 },
      { campaignId: `${PREFIX}-rt-tier`, unit: "PERCENTAGE", minQuantity: 4, discountValue: 15 },
    ],
  });
  const read = await prisma.giftQuantityCampaign.findUniqueOrThrow({
    where: { id: `${PREFIX}-rt-tier` },
    include: { tiers: { orderBy: { minQuantity: "asc" } } },
  });
  assert.equal(read.tierUnit, "PERCENTAGE");
  assert.deepEqual(
    read.tiers.map((entry) => [entry.minQuantity, entry.discountValue, entry.campaignKind]),
    [
      [2, 10, "QUANTITY_TIER"],
      [4, 15, "QUANTITY_TIER"],
    ],
  );
});

test("legacy PromotionCampaign rows are untouched and cannot be confused with the new kinds", async () => {
  await prisma.$executeRaw`
    INSERT INTO "PromotionCampaign" ("id","kind","name","discountType","percentageValue","updatedAt")
    VALUES (${`${PREFIX}-legacy`}, 'PROMOTION', 'legacy', 'PERCENTAGE', 10, NOW())`;
  const legacy = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: `${PREFIX}-legacy` } });
  assert.equal(legacy.discountType, "PERCENTAGE");
  assert.equal(legacy.percentageValue, 10);
  // the legacy enums did not gain the new kinds
  await rejects(
    () => prisma.$executeRaw`
      INSERT INTO "PromotionCampaign" ("id","kind","name","discountType","updatedAt")
      VALUES (${`${PREFIX}-bad-legacy`}, 'GIFT_ITEM', 'x', 'PERCENTAGE', NOW())`,
    /invalid input value for enum/,
  );
  // and the legacy table does not list the new campaigns
  const legacyIds = (await prisma.promotionCampaign.findMany({ where: { id: { startsWith: PREFIX } } })).map((c) => c.id);
  assert.deepEqual(legacyIds, [`${PREFIX}-legacy`]);
});

test("invalid enum values are rejected by the database", async () => {
  await rejects(() => insertCampaign({ id: `${PREFIX}-bad-enum`, kind: "COUPON" as never }), /invalid input value for enum/);
  await rejects(
    () => insertCampaign(gift("bad-scope", { scopeMode: "EVERYTHING" })),
    /invalid input value for enum/,
  );
  await rejects(
    () => insertCampaign(tier("bad-unit", { tierUnit: "FIXED_PRICE" })),
    /invalid input value for enum/,
  );
});

test("a blank or oversized name is rejected", async () => {
  await rejects(() => insertCampaign(gift("blank", { name: " \t\n" })), "GiftQuantityCampaign_name_check");
  await rejects(() => insertCampaign(gift("long", { name: "x".repeat(121) })), "GiftQuantityCampaign_name_check");
});

test("gift and tier field groups are exclusive", async () => {
  await rejects(() => insertCampaign(gift("mixed-1", { tierUnit: "PERCENTAGE" })), "GiftQuantityCampaign_rule_shape_check");
  await rejects(
    () => insertCampaign(tier("mixed-2", { giftTrigger: "QUANTITY", minimumQuantity: 2 })),
    "GiftQuantityCampaign_rule_shape_check",
  );
  await rejects(
    () => insertCampaign(tier("mixed-3", { allowDuplicateGifts: false })),
    "GiftQuantityCampaign_rule_shape_check",
  );
});

test("a gift trigger owns only its own fields", async () => {
  await rejects(
    () => insertCampaign(gift("trigger-1", { giftTrigger: "QUANTITY", minimumSubtotalVnd: BigInt(1_000_000) })),
    "GiftQuantityCampaign_gift_trigger_check",
  );
  await rejects(
    () => insertCampaign(gift("trigger-2", { giftTrigger: "ORDER_SUBTOTAL", minimumQuantity: 2, minimumSubtotalVnd: BigInt(1_000_000), subtotalScope: "ELIGIBLE_PAID_LINES", awardMode: "ONCE" })),
    "GiftQuantityCampaign_gift_trigger_check",
  );
  await insertCampaign(
    gift("trigger-ok", {
      giftTrigger: "ORDER_SUBTOTAL",
      minimumQuantity: null,
      minimumSubtotalVnd: BigInt(1_000_000),
      subtotalScope: "ELIGIBLE_PAID_LINES",
      awardMode: "REPEAT_PER_THRESHOLD",
      categoryKeys: ["aoDai"],
    }),
  );
});

test("cheapest/most-expensive selection exists only with FROM_REACHED_THRESHOLD", async () => {
  await rejects(
    () => insertCampaign(tier("sel-1", { tierSelectionPriority: "CHEAPEST_FIRST" })),
    "GiftQuantityCampaign_tier_selection_check",
  );
});

test("global scope exists only for gift + ORDER_SUBTOTAL + ALL_PAID_LINES and carries no categories", async () => {
  const globalGift = {
    scopeMode: "GLOBAL_ALL_PAID_LINES",
    giftTrigger: "ORDER_SUBTOTAL",
    minimumQuantity: null,
    minimumSubtotalVnd: BigInt(1_000_000),
    subtotalScope: "ALL_PAID_LINES",
    awardMode: "ONCE",
  } as const;
  await insertCampaign(gift("global-ok", globalGift));
  await rejects(() => insertCampaign(gift("global-cats", { ...globalGift, categoryKeys: ["aoDai"] })), "GiftQuantityCampaign_global_scope_check");
  await rejects(() => insertCampaign(gift("global-eligible", { ...globalGift, subtotalScope: "ELIGIBLE_PAID_LINES" })), "GiftQuantityCampaign_global_scope_check");
  await rejects(() => insertCampaign(gift("global-qty", { scopeMode: "GLOBAL_ALL_PAID_LINES" })), "GiftQuantityCampaign_global_scope_check");
  await rejects(() => insertCampaign(tier("global-tier", { scopeMode: "GLOBAL_ALL_PAID_LINES" })), "GiftQuantityCampaign_global_scope_check");
});

test("numeric bounds are enforced", async () => {
  await rejects(() => insertCampaign(gift("b-qty0", { minimumQuantity: 0 })), "GiftQuantityCampaign_bounds_check");
  await rejects(() => insertCampaign(gift("b-qty-big", { minimumQuantity: 1_000_001 })), "GiftQuantityCampaign_bounds_check");
  await rejects(() => insertCampaign(gift("b-max0", { maxGiftsPerOrder: 0 })), "GiftQuantityCampaign_bounds_check");
  await rejects(() => insertCampaign(gift("b-max-big", { maxGiftsPerOrder: 101 })), "GiftQuantityCampaign_bounds_check");
  await rejects(() => insertCampaign(gift("b-rev0", { revision: 0 })), "GiftQuantityCampaign_bounds_check");
  await rejects(() => insertCampaign(gift("b-prio", { stackPriority: -1 })), "GiftQuantityCampaign_bounds_check");
  await rejects(
    () => insertCampaign(gift("b-cats", { categoryKeys: Array.from({ length: 51 }, (_, index) => `c${index}`) })),
    "GiftQuantityCampaign_bounds_check",
  );
  await rejects(
    () => insertCampaign(gift("b-sub", { giftTrigger: "ORDER_SUBTOTAL", minimumQuantity: null, minimumSubtotalVnd: BigInt(0) })),
    "GiftQuantityCampaign_bounds_check",
  );
});

test("a frozen snapshot carries both its time and its campaign revision, or neither", async () => {
  await rejects(() => insertCampaign(gift("fz-1", { frozenAt: "2026-10-13T00:00:00Z" })), "GiftQuantityCampaign_frozen_audit_check");
  await rejects(() => insertCampaign(gift("fz-2", { frozenCampaignRevision: 1 })), "GiftQuantityCampaign_frozen_audit_check");
});

test("tiers: duplicate thresholds, non-positive values and tiers on a gift campaign are rejected", async () => {
  await insertCampaign(tier("t-main"));
  await prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-main`, unit: "PERCENTAGE", minQuantity: 3, discountValue: 10 } });
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-main`, unit: "PERCENTAGE", minQuantity: 3, discountValue: 20 } }),
    /Unique constraint|QuantityTier_campaignId_minQuantity_key/,
  );
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-main`, unit: "PERCENTAGE", minQuantity: 0, discountValue: 10 } }),
    "QuantityTier_bounds_check",
  );
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-main`, unit: "PERCENTAGE", minQuantity: 5, discountValue: 0 } }),
    "QuantityTier_bounds_check",
  );
  await insertCampaign(gift("t-gift"));
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-gift`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 5 } }),
    /Foreign key constraint|QuantityTier_campaignId_campaignKind_fkey/,
  );
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-t-main`, campaignKind: "GIFT_ITEM", unit: "PERCENTAGE", minQuantity: 7, discountValue: 5 } }),
    /QuantityTier_kind_check|Foreign key constraint/,
  );
});

test("the database bounds a percentage tier to 1..99 and keeps the unit in step with the campaign", async () => {
  await insertCampaign(tier("pct"));
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-pct`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 100 } }),
    "QuantityTier_bounds_check",
  );
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-pct`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 150 } }),
    "QuantityTier_bounds_check",
  );
  // a tier whose unit disagrees with the campaign's unit is an orphan of the composite key
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-pct`, unit: "FIXED_AMOUNT_PER_UNIT_VND", minQuantity: 2, discountValue: 50_000 } }),
    /Foreign key constraint|QuantityTier_campaignId_campaignKind_unit_fkey/,
  );
  await prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-pct`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 99 } });

  // a campaign with no unit chosen yet cannot hold tiers at all
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","updatedAt")
     VALUES ($1,'QUANTITY_TIER','no unit','DYNAMIC_CATEGORY',ARRAY[]::text[],NOW())`,
    `${PREFIX}-nounit`,
  );
  await rejects(
    () => prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-nounit`, unit: "PERCENTAGE", minQuantity: 2, discountValue: 10 } }),
    /Foreign key constraint|QuantityTier_campaignId_campaignKind_unit_fkey/,
  );

  // VND -> PERCENTAGE with a tier above 99 is refused; with in-range tiers the unit cascades to the tiers
  await insertCampaign(tier("switch", { tierUnit: "FIXED_AMOUNT_PER_UNIT_VND" }));
  await prisma.quantityTier.create({ data: { campaignId: `${PREFIX}-switch`, unit: "FIXED_AMOUNT_PER_UNIT_VND", minQuantity: 2, discountValue: 50_000 } });
  await rejects(
    () => prisma.$executeRaw`UPDATE "GiftQuantityCampaign" SET "tierUnit" = 'PERCENTAGE' WHERE "id" = ${`${PREFIX}-switch`}`,
    "QuantityTier_bounds_check",
  );
  await prisma.quantityTier.update({ where: { campaignId_minQuantity: { campaignId: `${PREFIX}-switch`, minQuantity: 2 } }, data: { discountValue: 20, unit: "FIXED_AMOUNT_PER_UNIT_VND" } });
  await prisma.$executeRaw`UPDATE "GiftQuantityCampaign" SET "tierUnit" = 'PERCENTAGE' WHERE "id" = ${`${PREFIX}-switch`}`;
  const switched = await prisma.quantityTier.findFirstOrThrow({ where: { campaignId: `${PREFIX}-switch` } });
  assert.equal(switched.unit, "PERCENTAGE", "the tier unit follows the campaign");
});

test("NULL columns never let a CHECK pass silently: unset trigger/units are treated as violations", async () => {
  // global scope with the trigger and subtotal scope both unset
  await rejects(
    () => insertCampaign({ id: `${PREFIX}-null-global`, kind: "GIFT_ITEM", scopeMode: "GLOBAL_ALL_PAID_LINES" }),
    "GiftQuantityCampaign_global_scope_check",
  );
  // global scope with a quantity trigger and the subtotal scope unset
  await rejects(
    () => insertCampaign({ id: `${PREFIX}-null-global-2`, kind: "GIFT_ITEM", scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "QUANTITY", minimumQuantity: 2 }),
    "GiftQuantityCampaign_global_scope_check",
  );
  // no trigger chosen but trigger fields set: two competing readings
  await rejects(
    () => insertCampaign({ id: `${PREFIX}-null-trigger`, kind: "GIFT_ITEM", minimumQuantity: 3, minimumSubtotalVnd: BigInt(1_000_000), subtotalScope: "ELIGIBLE_PAID_LINES", awardMode: "ONCE" }),
    "GiftQuantityCampaign_gift_trigger_check",
  );
  await rejects(
    () => insertCampaign({ id: `${PREFIX}-null-trigger-2`, kind: "GIFT_ITEM", awardMode: "ONCE" }),
    "GiftQuantityCampaign_gift_trigger_check",
  );
  // a selection priority with no discounted-units choice at all
  await rejects(
    () => insertCampaign({ id: `${PREFIX}-null-units`, kind: "QUANTITY_TIER", tierUnit: "PERCENTAGE", tierSelectionPriority: "CHEAPEST_FIRST" }),
    "GiftQuantityCampaign_tier_selection_check",
  );
  // an unset draft (nothing chosen) is fine
  await insertCampaign({ id: `${PREFIX}-null-ok`, kind: "GIFT_ITEM" });
});

test("a frozen snapshot is only valid on a FIXED_PRODUCT_SET campaign", async () => {
  await rejects(
    () => insertCampaign(gift("fz-dyn", { scopeMode: "DYNAMIC_CATEGORY", frozenAt: "2026-10-13T00:00:00Z", frozenCampaignRevision: 1 })),
    "GiftQuantityCampaign_frozen_audit_check",
  );
  await insertCampaign(gift("fz-fixed", { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["aoDai"], frozenAt: "2026-10-13T00:00:00Z", frozenCampaignRevision: 1 }));
  await rejects(
    () => prisma.$executeRaw`UPDATE "GiftQuantityCampaign" SET "scopeMode" = 'DYNAMIC_CATEGORY' WHERE "id" = ${`${PREFIX}-fz-fixed`}`,
    "GiftQuantityCampaign_frozen_audit_check",
  );
});

test("gift options only hang off gift campaigns and are unique per variant", async () => {
  await insertCampaign(gift("o-gift"));
  await prisma.giftOption.create({ data: { campaignId: `${PREFIX}-o-gift`, variantId: `${PREFIX}-variant` } });
  await rejects(
    () => prisma.giftOption.create({ data: { campaignId: `${PREFIX}-o-gift`, variantId: `${PREFIX}-variant` } }),
    /Unique constraint|GiftOption_campaignId_variantId_key/,
  );
  await insertCampaign(tier("o-tier"));
  await rejects(
    () => prisma.giftOption.create({ data: { campaignId: `${PREFIX}-o-tier`, variantId: `${PREFIX}-variant` } }),
    /Foreign key constraint|GiftOption_campaignId_campaignKind_fkey/,
  );
});

test("targets: one entry per product, no orphans", async () => {
  await insertCampaign(gift("tg"));
  await prisma.giftQuantityTarget.create({ data: { campaignId: `${PREFIX}-tg`, productId: `${PREFIX}-product`, role: "INCLUDE" } });
  await rejects(
    () => prisma.giftQuantityTarget.create({ data: { campaignId: `${PREFIX}-tg`, productId: `${PREFIX}-product`, role: "EXCLUDE" } }),
    /Unique constraint|GiftQuantityTarget_campaignId_productId_key/,
    // an include and an exclude of one product cannot coexist
  );
  await rejects(
    () => prisma.giftQuantityTarget.create({ data: { campaignId: `${PREFIX}-tg`, productId: "no-such-product", role: "INCLUDE" } }),
    /Foreign key constraint|GiftQuantityTarget_productId_fkey/,
  );
  await rejects(
    () => prisma.giftQuantityTarget.create({ data: { campaignId: "no-such-campaign", productId: `${PREFIX}-product-2`, role: "INCLUDE" } }),
    /Foreign key constraint|GiftQuantityTarget_campaignId_fkey/,
  );
});

test("stack peers are unique per (campaign, kind, peer) and bounded", async () => {
  await insertCampaign(gift("sp"));
  await prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-sp`, peerKind: "FLASH_SALE", peerCampaignId: "*" } });
  await rejects(
    () => prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-sp`, peerKind: "FLASH_SALE", peerCampaignId: "*" } }),
    /Unique constraint|GiftQuantityStackPeer_campaignId_peerKind_peerCampaignId_key/,
  );
  await rejects(
    () => prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-sp`, peerKind: "PROMOTION", peerCampaignId: "" } }),
    "GiftQuantityStackPeer_peer_check",
  );
  await rejects(
    () => prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-sp`, peerKind: "PROMOTION", peerCampaignId: "x".repeat(65) } }),
    "GiftQuantityStackPeer_peer_check",
  );
  await rejects(
    () => prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-sp`, peerKind: "QUANTITY_TIER", peerCampaignId: `${PREFIX}-sp` } }),
    "GiftQuantityStackPeer_peer_check",
  );
});

test("deleting a campaign cascades to its children; deleting a product removes its scope rows", async () => {
  await insertCampaign(gift("cascade", { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: ["aoDai"], frozenAt: "2026-10-13T00:00:00Z", frozenCampaignRevision: 1 }));
  await prisma.giftQuantityTarget.create({ data: { campaignId: `${PREFIX}-cascade`, productId: `${PREFIX}-product-2`, role: "INCLUDE" } });
  await prisma.giftQuantityFrozenProduct.create({ data: { campaignId: `${PREFIX}-cascade`, productId: `${PREFIX}-product-2` } });
  await prisma.giftOption.create({ data: { campaignId: `${PREFIX}-cascade`, variantId: `${PREFIX}-variant` } });

  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" = ${`${PREFIX}-product-2`}`;
  assert.equal(await prisma.giftQuantityTarget.count({ where: { campaignId: `${PREFIX}-cascade` } }), 0);
  assert.equal(await prisma.giftQuantityFrozenProduct.count({ where: { campaignId: `${PREFIX}-cascade` } }), 0);
  assert.equal(await prisma.giftOption.count({ where: { campaignId: `${PREFIX}-cascade` } }), 1);

  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" = ${`${PREFIX}-cascade`}`;
  assert.equal(await prisma.giftOption.count({ where: { campaignId: `${PREFIX}-cascade` } }), 0);
});

test("F02: gift campaigns can name each other as stack peers (by id and by wildcard) and still cannot name themselves", async () => {
  await insertCampaign(gift("gp1"));
  await insertCampaign(gift("gp2"));
  await prisma.giftQuantityStackPeer.createMany({
    data: [
      { campaignId: `${PREFIX}-gp1`, peerKind: "GIFT_ITEM", peerCampaignId: `${PREFIX}-gp2` },
      { campaignId: `${PREFIX}-gp2`, peerKind: "GIFT_ITEM", peerCampaignId: "*" },
    ],
  });
  const read = await prisma.giftQuantityStackPeer.findMany({
    where: { campaignId: { in: [`${PREFIX}-gp1`, `${PREFIX}-gp2`] } },
    orderBy: { campaignId: "asc" },
  });
  assert.deepEqual(read.map((peer) => [peer.campaignId, peer.peerKind, peer.peerCampaignId]), [
    [`${PREFIX}-gp1`, "GIFT_ITEM", `${PREFIX}-gp2`],
    [`${PREFIX}-gp2`, "GIFT_ITEM", "*"],
  ]);
  await rejects(
    () => prisma.giftQuantityStackPeer.create({ data: { campaignId: `${PREFIX}-gp1`, peerKind: "GIFT_ITEM", peerCampaignId: `${PREFIX}-gp1` } }),
    "GiftQuantityStackPeer_peer_check",
  );
});
