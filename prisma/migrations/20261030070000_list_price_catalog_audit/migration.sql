ALTER TABLE "CatalogSyncState"
 ADD COLUMN "listPriceAuditAt" TIMESTAMP(3),
 ADD COLUMN "listPriceAuditedSyncAt" TIMESTAMP(3),
 ADD COLUMN "listPriceAuditRetryAt" TIMESTAMP(3),
 ADD COLUMN "listPriceAuditError" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "listPriceAuditSummary" JSONB;
