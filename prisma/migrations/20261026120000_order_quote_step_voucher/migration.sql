-- Voucher v1 V18 (SPEC-VOUCHER-001). A voucher segment of a paid line is one more step of that line's ordered discount
-- ledger (base -> ... -> price the buyer pays), so the stored quote can walk to the price the vendor receives.
-- Relaxes ONE check constraint to admit a third step source; every existing row still satisfies it and nothing is
-- rewritten. No voucher code writes this value until V18 ships behind LA_VOUCHER_ENABLED.
--
-- Rollback (only while no VOUCHER step exists):
--   ALTER TABLE "OrderQuoteDiscountStep" DROP CONSTRAINT "OrderQuoteDiscountStep_source_check",
--     ADD CONSTRAINT "OrderQuoteDiscountStep_source_check" CHECK ("source" IN ('LEGACY', 'QUANTITY_TIER'));

ALTER TABLE "OrderQuoteDiscountStep"
  DROP CONSTRAINT "OrderQuoteDiscountStep_source_check",
  ADD CONSTRAINT "OrderQuoteDiscountStep_source_check" CHECK ("source" IN ('LEGACY', 'QUANTITY_TIER', 'VOUCHER'));
