-- Counts the changes of the configured secondary shop, advanced under the shop's catalog-sync lock.
-- A secondary sync writes only while the epoch it started in is still current, so it is bound to one
-- ACTIVATION of its shop, not just to the shop's id (A -> B -> A would otherwise let a stale read of
-- A through). Additive; releases that do not know the column ignore it.
ALTER TABLE "CatalogSyncState" ADD COLUMN "secondaryEpoch" INTEGER NOT NULL DEFAULT 0;
