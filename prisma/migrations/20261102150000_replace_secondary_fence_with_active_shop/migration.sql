-- The secondary shop the deployment is configured with, stored under the shop's catalog-sync lock
-- (NULL: none). A secondary sync chunk takes the same lock and writes only if its shop is the one
-- stored here, so a worker started under an earlier configuration can never write after the
-- configuration changed -- whether or not it had stored anything yet, and without any timestamp
-- comparison. Replaces the time-based "secondaryFenceAt".
ALTER TABLE "CatalogSyncState" DROP COLUMN "secondaryFenceAt";
ALTER TABLE "CatalogSyncState" ADD COLUMN "secondaryShopId" INTEGER;
