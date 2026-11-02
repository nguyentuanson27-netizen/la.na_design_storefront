-- Per-shop fence for secondary-shop stock reads: a secondary read that began before this instant
-- is discarded instead of written. One row per shop, set by a configuration-change purge (feature
-- switched off, secondary shop replaced) under the shop's catalog-sync lock, so it needs no lock on
-- any variant row.
ALTER TABLE "CatalogSyncState" ADD COLUMN "secondaryFenceAt" TIMESTAMP(3);
