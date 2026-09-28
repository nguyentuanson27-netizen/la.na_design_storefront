-- Pending Pancake `variations_warehouses` webhook markers for the 30-second targeted inventory batch.
-- A marker is a trigger only; authoritative stock is re-read from Pancake before anything is written.

CREATE TABLE "PancakeInventorySignal" (
    "pancakeVariationId" TEXT NOT NULL,
    "pancakeWarehouseId" TEXT NOT NULL,
    "receivedCount" INTEGER NOT NULL DEFAULT 1,
    "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PancakeInventorySignal_pkey" PRIMARY KEY ("pancakeVariationId", "pancakeWarehouseId"),
    CONSTRAINT "PancakeInventorySignal_counts_valid" CHECK ("receivedCount" > 0 AND "attempts" >= 0)
);

CREATE INDEX "PancakeInventorySignal_lastReceivedAt_idx" ON "PancakeInventorySignal"("lastReceivedAt");
