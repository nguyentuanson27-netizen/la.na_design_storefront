-- The normalized SKU a secondary-shop stock row (`secondary:<shopId>:<warehouseId>`) was attributed
-- to. A primary sync that finds the variant no longer carries that SKU (renamed, removed, retired,
-- or now shared with another variant) deletes the row in its own transaction, without waiting for
-- the secondary shop's API to answer. NULL for primary rows.
ALTER TABLE "WarehouseStock" ADD COLUMN "secondarySku" TEXT;
