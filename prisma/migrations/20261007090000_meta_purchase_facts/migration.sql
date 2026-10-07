-- Additive only. Do not infer historical conversion times or IDs from mutable catalog rows.
ALTER TABLE "OrderMirror"
  ADD COLUMN "purchaseOccurredAt" TIMESTAMP(3),
  ADD COLUMN "metaPurchaseContext" TEXT,
  ADD COLUMN "metaPurchasePayload" TEXT,
  ADD COLUMN "metaPurchaseSentAt" TIMESTAMP(3);
ALTER TABLE "OrderLineSnapshot" ADD COLUMN "metaContentId" TEXT;
