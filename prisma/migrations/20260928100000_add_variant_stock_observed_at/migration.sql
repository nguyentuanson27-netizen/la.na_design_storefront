-- Durable newer-read-wins watermark: survives a read that observed no warehouse rows.
ALTER TABLE "VariantMirror" ADD COLUMN "stockObservedAt" TIMESTAMP(3);

-- Backfill from the rows that carried it until now.
UPDATE "VariantMirror" AS v
SET "stockObservedAt" = ws."observedAt"
FROM (
  SELECT "variantId", MAX("syncedAt") AS "observedAt"
  FROM "WarehouseStock"
  GROUP BY "variantId"
) AS ws
WHERE ws."variantId" = v."id";
