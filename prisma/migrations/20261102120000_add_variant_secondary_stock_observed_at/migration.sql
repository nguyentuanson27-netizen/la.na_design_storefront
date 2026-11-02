-- Durable newer-read-wins watermark for the stock a secondary Pancake shop contributes
-- (`secondary:<shopId>:<warehouseId>` rows). Like "stockObservedAt" it survives a read that
-- observed no secondary row, so an older read that committed later cannot bring deleted stock back.
ALTER TABLE "VariantMirror" ADD COLUMN "secondaryStockObservedAt" TIMESTAMP(3);
