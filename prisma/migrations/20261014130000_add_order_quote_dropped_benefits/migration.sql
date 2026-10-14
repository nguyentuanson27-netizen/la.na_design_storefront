-- Gift & Quantity Promotions v1 (GQ18): why a benefit the buyer might expect is not on this order.
--
-- Additive: one nullable column on a table (GQ15) that nothing writes to yet. A tier campaign whose
-- runtime price became invalid (EX-21, `TIER_PRICE_INVALID`) or that could not stack is dropped from
-- the quote, and FR-10 asks that the reason is kept for audit. It is provenance only: it never
-- re-prices or re-grants anything, and it is frozen with the rest of the quote when the order leaves
-- DRAFT (the GQ15 trigger covers every column of the row).
--
-- Rolling back: ALTER TABLE "OrderQuoteSnapshot" DROP COLUMN "droppedBenefits";

ALTER TABLE "OrderQuoteSnapshot" ADD COLUMN "droppedBenefits" JSONB;

ALTER TABLE "OrderQuoteSnapshot"
  ADD CONSTRAINT "OrderQuoteSnapshot_dropped_benefits_check" CHECK (
    "droppedBenefits" IS NULL
    OR (jsonb_typeof("droppedBenefits") = 'array' AND pg_column_size("droppedBenefits") <= 16384)
  );
