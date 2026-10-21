-- Additive only. Existing order money is not rewritten and no campaign is activated.
CREATE TABLE "ShippingPromotionCampaign" (
  "id" TEXT NOT NULL,
  "pancakeShopId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "enabledAt" TIMESTAMPTZ(3),
  "disabledAt" TIMESTAMPTZ(3),
  "startsAt" TIMESTAMPTZ(3),
  "endsAt" TIMESTAMPTZ(3),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "minimumQuantity" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "stackingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "categoryKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "includeProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "excludeProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ShippingPromotionCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShippingPromotionCampaign_values_check" CHECK (
    "pancakeShopId" > 0 AND length(btrim("name")) BETWEEN 1 AND 120
    AND "revision" > 0 AND "minimumQuantity" BETWEEN 1 AND 10000
    AND "priority" BETWEEN 0 AND 1000000
    AND cardinality("categoryKeys") <= 50
    AND cardinality("includeProductIds") <= 500
    AND cardinality("excludeProductIds") <= 500
    AND cardinality("categoryKeys") + cardinality("includeProductIds") > 0
    AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt")
    AND (NOT "isEnabled" OR "enabledAt" IS NOT NULL)
  )
);
CREATE INDEX "ShippingPromotionCampaign_pancakeShopId_isEnabled_priority_id_idx"
  ON "ShippingPromotionCampaign"("pancakeShopId", "isEnabled", "priority", "id");
ALTER TABLE "OrderMirror"
  ADD COLUMN "shippingBaseFeeVnd" BIGINT,
  ADD COLUMN "shippingPromotionCampaignId" TEXT,
  ADD COLUMN "shippingPromotionRevision" INTEGER;
ALTER TABLE "OrderMirror" ADD CONSTRAINT "OrderMirror_shipping_provenance_check" CHECK (
  ("shippingBaseFeeVnd" IS NULL OR "shippingBaseFeeVnd" >= 0)
  AND (("shippingPromotionCampaignId" IS NULL AND "shippingPromotionRevision" IS NULL)
    OR ("shippingPromotionCampaignId" IS NOT NULL AND "shippingPromotionRevision" IS NOT NULL AND "shippingPromotionRevision" > 0))
);
