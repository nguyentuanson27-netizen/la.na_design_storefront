-- Gift & Quantity Promotions v1 (GQ03, ADR 0016): campaign, scope, tier, gift-option and stack
-- persistence.
--
-- Additive only. No existing table, column, enum or constraint is touched: the new rule campaigns
-- live in their own tables and enums, so legacy `PromotionCampaign` rows, the legacy resolver, the
-- legacy candidate lookup and every historical order read exactly as before, and an application
-- rollback is never blocked by a column older code does not know. Rolling the feature back is
-- `DROP TABLE` of the tables below (children first) plus `DROP TYPE` of the enums; nothing else
-- references them yet. The feature is additionally gated by LA_GIFT_QUANTITY_PROMOTIONS_ENABLED,
-- which is OFF unless it is exactly "true".
--
-- What the database enforces is what is universal at rest. A Draft may be incomplete, so the rule
-- columns are nullable and Publish / re-enable / Scheduled material edit validate completeness and
-- economics in the lifecycle service. The constraints below protect shape, exclusivity, bounds and
-- identity so no write path can store a row that no reader can interpret.

-- CreateEnum
CREATE TYPE "GiftQuantityCampaignKind" AS ENUM ('GIFT_ITEM', 'QUANTITY_TIER');

-- CreateEnum
CREATE TYPE "GiftQuantityScopeMode" AS ENUM ('GLOBAL_ALL_PAID_LINES', 'DYNAMIC_CATEGORY', 'FIXED_PRODUCT_SET');

-- CreateEnum
CREATE TYPE "GiftTrigger" AS ENUM ('QUANTITY', 'ORDER_SUBTOTAL');

-- CreateEnum
CREATE TYPE "GiftSubtotalScope" AS ENUM ('ALL_PAID_LINES', 'ELIGIBLE_PAID_LINES');

-- CreateEnum
CREATE TYPE "GiftAwardMode" AS ENUM ('ONCE', 'REPEAT_PER_THRESHOLD');

-- CreateEnum
CREATE TYPE "QuantityTierDiscountUnit" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT_PER_UNIT_VND');

-- CreateEnum
CREATE TYPE "QuantityTierDiscountedUnits" AS ENUM ('ALL_ELIGIBLE_UNITS', 'FROM_REACHED_THRESHOLD');

-- CreateEnum
CREATE TYPE "QuantityTierSelectionPriority" AS ENUM ('CHEAPEST_FIRST', 'MOST_EXPENSIVE_FIRST');

-- CreateEnum
CREATE TYPE "GiftQuantityScopeTargetRole" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateEnum
CREATE TYPE "GiftQuantityStackPeerKind" AS ENUM ('PROMOTION', 'FLASH_SALE', 'CLEARANCE', 'QUANTITY_TIER');

-- CreateTable
CREATE TABLE "GiftQuantityCampaign" (
    "id" TEXT NOT NULL,
    "kind" "GiftQuantityCampaignKind" NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stackPriority" INTEGER,
    "stackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scopeMode" "GiftQuantityScopeMode" NOT NULL DEFAULT 'DYNAMIC_CATEGORY',
    "categoryKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "frozenAt" TIMESTAMP(3),
    "frozenCampaignRevision" INTEGER,
    "giftTrigger" "GiftTrigger",
    "minimumQuantity" INTEGER,
    "minimumSubtotalVnd" BIGINT,
    "subtotalScope" "GiftSubtotalScope",
    "awardMode" "GiftAwardMode",
    "maxGiftsPerOrder" INTEGER,
    "allowDuplicateGifts" BOOLEAN,
    "tierUnit" "QuantityTierDiscountUnit",
    "tierDiscountedUnits" "QuantityTierDiscountedUnits",
    "tierSelectionPriority" "QuantityTierSelectionPriority",

    CONSTRAINT "GiftQuantityCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftQuantityTarget" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "role" "GiftQuantityScopeTargetRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftQuantityTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftQuantityFrozenProduct" (
    "campaignId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "GiftQuantityFrozenProduct_pkey" PRIMARY KEY ("campaignId","productId")
);

-- CreateTable
CREATE TABLE "QuantityTier" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignKind" "GiftQuantityCampaignKind" NOT NULL DEFAULT 'QUANTITY_TIER',
    "unit" "QuantityTierDiscountUnit" NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuantityTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftOption" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignKind" "GiftQuantityCampaignKind" NOT NULL DEFAULT 'GIFT_ITEM',
    "variantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftQuantityStackPeer" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "peerKind" "GiftQuantityStackPeerKind" NOT NULL,
    "peerCampaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftQuantityStackPeer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftQuantityCampaign_isEnabled_startsAt_endsAt_idx" ON "GiftQuantityCampaign"("isEnabled", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "GiftQuantityCampaign_id_kind_key" ON "GiftQuantityCampaign"("id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "GiftQuantityCampaign_id_kind_tierUnit_key" ON "GiftQuantityCampaign"("id", "kind", "tierUnit");

-- CreateIndex
CREATE INDEX "GiftQuantityTarget_productId_idx" ON "GiftQuantityTarget"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftQuantityTarget_campaignId_productId_key" ON "GiftQuantityTarget"("campaignId", "productId");

-- CreateIndex
CREATE INDEX "GiftQuantityFrozenProduct_productId_idx" ON "GiftQuantityFrozenProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "QuantityTier_campaignId_minQuantity_key" ON "QuantityTier"("campaignId", "minQuantity");

-- CreateIndex
CREATE INDEX "GiftOption_variantId_idx" ON "GiftOption"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftOption_campaignId_variantId_key" ON "GiftOption"("campaignId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftQuantityStackPeer_campaignId_peerKind_peerCampaignId_key" ON "GiftQuantityStackPeer"("campaignId", "peerKind", "peerCampaignId");

-- AddForeignKey
ALTER TABLE "GiftQuantityTarget" ADD CONSTRAINT "GiftQuantityTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftQuantityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftQuantityTarget" ADD CONSTRAINT "GiftQuantityTarget_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftQuantityFrozenProduct" ADD CONSTRAINT "GiftQuantityFrozenProduct_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftQuantityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftQuantityFrozenProduct" ADD CONSTRAINT "GiftQuantityFrozenProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuantityTier" ADD CONSTRAINT "QuantityTier_campaignId_campaignKind_unit_fkey" FOREIGN KEY ("campaignId", "campaignKind", "unit") REFERENCES "GiftQuantityCampaign"("id", "kind", "tierUnit") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftOption" ADD CONSTRAINT "GiftOption_campaignId_campaignKind_fkey" FOREIGN KEY ("campaignId", "campaignKind") REFERENCES "GiftQuantityCampaign"("id", "kind") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftOption" ADD CONSTRAINT "GiftOption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VariantMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftQuantityStackPeer" ADD CONSTRAINT "GiftQuantityStackPeer_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GiftQuantityCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Name: never blank after trimming ASCII whitespace; same contract as PromotionCampaign.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_name_check"
CHECK (btrim("name", E' \t\n\r\f\x0B') <> '' AND char_length("name") <= 120);

-- The gift field group and the tier field group are mutually exclusive: a GIFT_ITEM row can never
-- carry a tier setting and a QUANTITY_TIER row can never carry a gift setting. This is also what
-- keeps one discount unit per campaign: there is a single `tierUnit` column, never one per tier.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_rule_shape_check"
CHECK (
  (
    "kind" = 'GIFT_ITEM'
    AND "tierUnit" IS NULL
    AND "tierDiscountedUnits" IS NULL
    AND "tierSelectionPriority" IS NULL
  )
  OR (
    "kind" = 'QUANTITY_TIER'
    AND "giftTrigger" IS NULL
    AND "minimumQuantity" IS NULL
    AND "minimumSubtotalVnd" IS NULL
    AND "subtotalScope" IS NULL
    AND "awardMode" IS NULL
    AND "maxGiftsPerOrder" IS NULL
    AND "allowDuplicateGifts" IS NULL
  )
);

-- A gift trigger owns only its own fields, and with no trigger chosen yet none of the trigger
-- fields may be set (a Draft cannot hold a half-chosen rule that two readers would read two ways).
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_gift_trigger_check"
CHECK (
  (
    "giftTrigger" IS NULL
    AND "minimumQuantity" IS NULL
    AND "minimumSubtotalVnd" IS NULL
    AND "subtotalScope" IS NULL
    AND "awardMode" IS NULL
  )
  OR (
    COALESCE("giftTrigger" = 'QUANTITY', FALSE)
    AND "minimumSubtotalVnd" IS NULL
    AND "subtotalScope" IS NULL
    AND "awardMode" IS NULL
  )
  OR (
    COALESCE("giftTrigger" = 'ORDER_SUBTOTAL', FALSE)
    AND "minimumQuantity" IS NULL
  )
);

-- The cheapest/most-expensive choice only exists when only some units are discounted.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_tier_selection_check"
CHECK (
  "tierSelectionPriority" IS NULL
  OR COALESCE("tierDiscountedUnits" = 'FROM_REACHED_THRESHOLD', FALSE)
);

-- The global scope exists only for GIFT_ITEM + ORDER_SUBTOTAL + ALL_PAID_LINES and carries no
-- category list; every other campaign needs a real scope (spec FR-02 / FR-04). The comparisons are
-- COALESCEd so an unset trigger or subtotal scope fails the check instead of passing it as NULL.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_global_scope_check"
CHECK (
  "scopeMode" <> 'GLOBAL_ALL_PAID_LINES'
  OR (
    "kind" = 'GIFT_ITEM'
    AND COALESCE("giftTrigger" = 'ORDER_SUBTOTAL', FALSE)
    AND COALESCE("subtotalScope" = 'ALL_PAID_LINES', FALSE)
    AND cardinality("categoryKeys") = 0
  )
);

-- A frozen snapshot belongs to a FIXED_PRODUCT_SET campaign only, and is audited by both its time
-- and the revision it was taken at, or by neither.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_frozen_audit_check"
CHECK (
  ("frozenAt" IS NULL) = ("frozenCampaignRevision" IS NULL)
  AND ("frozenAt" IS NULL OR "scopeMode" = 'FIXED_PRODUCT_SET')
);

-- Bounds. Mirrors the application limits so a direct write cannot exceed them.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_bounds_check"
CHECK (
  "revision" >= 1
  AND cardinality("categoryKeys") <= 50
  AND ("stackPriority" IS NULL OR "stackPriority" BETWEEN 0 AND 1000000)
  AND ("minimumQuantity" IS NULL OR "minimumQuantity" BETWEEN 1 AND 1000000)
  AND ("minimumSubtotalVnd" IS NULL OR "minimumSubtotalVnd" BETWEEN 1 AND 100000000000)
  AND ("maxGiftsPerOrder" IS NULL OR "maxGiftsPerOrder" BETWEEN 1 AND 100)
  AND ("frozenCampaignRevision" IS NULL OR "frozenCampaignRevision" >= 1)
);

-- Tier children. `unit` is a composite-FK copy of the parent's `tierUnit` (ON UPDATE CASCADE keeps
-- it in step), which is what lets the database itself refuse a percentage outside 1..99: the unit
-- cannot be switched to PERCENTAGE while any tier holds a larger value, and a tier cannot be
-- written before the campaign has chosen a unit.
ALTER TABLE "QuantityTier"
ADD CONSTRAINT "QuantityTier_kind_check"
CHECK ("campaignKind" = 'QUANTITY_TIER');

ALTER TABLE "QuantityTier"
ADD CONSTRAINT "QuantityTier_bounds_check"
CHECK (
  "minQuantity" BETWEEN 1 AND 1000000
  AND "discountValue" BETWEEN 1 AND 2000000000
  AND ("unit" <> 'PERCENTAGE' OR "discountValue" <= 99)
);

ALTER TABLE "GiftOption"
ADD CONSTRAINT "GiftOption_kind_check"
CHECK ("campaignKind" = 'GIFT_ITEM');

-- `*` means every campaign of the peer kind; otherwise a bounded campaign id. Peers name campaigns
-- in two different tables (legacy and new), so there is no foreign key to point at; a stale id
-- names nothing (ids are never reused) and grants nothing. A campaign cannot list itself.
ALTER TABLE "GiftQuantityStackPeer"
ADD CONSTRAINT "GiftQuantityStackPeer_peer_check"
CHECK (
  ("peerCampaignId" = '*' OR char_length("peerCampaignId") BETWEEN 1 AND 64)
  AND "peerCampaignId" <> "campaignId"
);
