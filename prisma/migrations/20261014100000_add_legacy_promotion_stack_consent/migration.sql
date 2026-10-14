-- Gift & Quantity Promotions v1 (GQ09a, ADR 0016 D-10): a legacy campaign's consent to stack with
-- quantity-tier campaigns.
--
-- Additive and isolated: one new table that references `PromotionCampaign` by foreign key. No column
-- is added to the legacy table, no legacy constraint or enum is touched, and a legacy campaign with
-- no row here behaves exactly as before. Rolling back is `DROP TABLE "LegacyPromotionStackConsent"`;
-- nothing else depends on it. Writes happen only through the gift/quantity admin write contract,
-- which is itself behind LA_GIFT_QUANTITY_PROMOTIONS_ENABLED.

-- CreateTable
CREATE TABLE "LegacyPromotionStackConsent" (
    "campaignId" TEXT NOT NULL,
    "stackPriority" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyPromotionStackConsent_pkey" PRIMARY KEY ("campaignId")
);

-- AddForeignKey
ALTER TABLE "LegacyPromotionStackConsent" ADD CONSTRAINT "LegacyPromotionStackConsent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "PromotionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same bound as `GiftQuantityCampaign.stackPriority`.
ALTER TABLE "LegacyPromotionStackConsent"
ADD CONSTRAINT "LegacyPromotionStackConsent_priority_check"
CHECK ("stackPriority" BETWEEN 0 AND 1000000);
