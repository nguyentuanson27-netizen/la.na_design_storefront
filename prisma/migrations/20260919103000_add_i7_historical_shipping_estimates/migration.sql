-- F8c — immutable historical preorder shipping estimates.
--
-- Additive and NO BACKFILL. Existing I7 rows keep all four fields NULL, including historical
-- preorder rows created before this migration. F8c treats that as "preorder history exists, but no
-- immutable shipping estimate was captured" and omits the shipping portion rather than reading
-- today's A5 policy as yesterday's fact.
--
-- We snapshot factual day ranges, not presentation prose. The existing I7 UPDATE/DELETE trigger
-- already protects this table, so these columns inherit the same database-level immutability.

ALTER TABLE "OrderPreorderSnapshot"
  ADD COLUMN "shippingInnerCityMinDays" INTEGER,
  ADD COLUMN "shippingInnerCityMaxDays" INTEGER,
  ADD COLUMN "shippingOtherProvinceMinDays" INTEGER,
  ADD COLUMN "shippingOtherProvinceMaxDays" INTEGER;

ALTER TABLE "OrderPreorderSnapshot"
  ADD CONSTRAINT "OrderPreorderSnapshot_shipping_estimates_complete"
  CHECK (
    (
      "shippingInnerCityMinDays" IS NULL
      AND "shippingInnerCityMaxDays" IS NULL
      AND "shippingOtherProvinceMinDays" IS NULL
      AND "shippingOtherProvinceMaxDays" IS NULL
    )
    OR
    (
      "shippingInnerCityMinDays" > 0
      AND "shippingInnerCityMaxDays" >= "shippingInnerCityMinDays"
      AND "shippingOtherProvinceMinDays" > 0
      AND "shippingOtherProvinceMaxDays" >= "shippingOtherProvinceMinDays"
    )
  );
