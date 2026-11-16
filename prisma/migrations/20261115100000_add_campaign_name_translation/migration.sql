-- The English for a campaign's name (admin-entered). Promotion, gift, shipping and voucher campaigns
-- are named by hand in Vietnamese; a row maps that name's text to its English, so one translation
-- serves every campaign that carries the name. Display only: nothing here is read by a quote, an
-- order or a proof. Purely additive: one new table, no existing table or column changes.
CREATE TABLE "CampaignNameTranslation" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignNameTranslation_pkey" PRIMARY KEY ("id"),
    -- The default language is not translated into itself; the database, not only the form, says so.
    CONSTRAINT "CampaignNameTranslation_locale_check" CHECK ("locale" IN ('en')),
    CONSTRAINT "CampaignNameTranslation_text_check" CHECK (char_length(btrim("text")) > 0)
);

CREATE UNIQUE INDEX "CampaignNameTranslation_source_locale_key" ON "CampaignNameTranslation"("source", "locale");
