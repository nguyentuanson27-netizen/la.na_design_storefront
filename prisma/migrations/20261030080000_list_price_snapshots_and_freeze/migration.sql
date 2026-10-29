ALTER TABLE "OrderLineSnapshot" ADD COLUMN "listUnitPriceVnd" BIGINT;
ALTER TABLE "OrderQuoteLine" ADD COLUMN "listUnitPriceVnd" BIGINT;
ALTER TABLE "PromotionPricingRevision"
  ADD COLUMN "campaignMutationFrozen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "campaignFreezeActor" TEXT,
  ADD COLUMN "campaignFreezeAt" TIMESTAMP(3),
  ADD COLUMN "campaignRollbackId" TEXT;
ALTER TABLE "OrderLineSnapshot" ADD CONSTRAINT "OrderLineSnapshot_list_price_positive" CHECK ("listUnitPriceVnd" IS NULL OR "listUnitPriceVnd" > 0);
ALTER TABLE "OrderQuoteLine" ADD CONSTRAINT "OrderQuoteLine_list_price_positive" CHECK ("listUnitPriceVnd" IS NULL OR ("role" = 'PAID' AND "listUnitPriceVnd" > 0));

ALTER TABLE "OrderQuoteLine" ADD COLUMN "productName" TEXT, ADD COLUMN "color" TEXT, ADD COLUMN "size" TEXT;
