-- Vietnam's post-2025 administrative units are two levels: province -> ward/commune, with no
-- district. A checkout snapshotted with the new address therefore has no districtRef.
--
-- The snapshot stays all-or-nothing for every other field. districtRef is the one field that may
-- now be NULL on a completed snapshot; an empty snapshot still requires it NULL like the rest.
-- Rows written before this migration all carry a district and satisfy the new check unchanged.
ALTER TABLE "OrderMirror" DROP CONSTRAINT "OrderMirror_checkout_snapshot_complete";

ALTER TABLE "OrderMirror"
ADD CONSTRAINT "OrderMirror_checkout_snapshot_complete"
CHECK (
  (
    "checkoutSnapshottedAt" IS NULL
    AND "guestName" IS NULL
    AND "guestPhone" IS NULL
    AND "provinceRef" IS NULL
    AND "districtRef" IS NULL
    AND "communeRef" IS NULL
    AND "addressDetail" IS NULL
    AND "note" IS NULL
    AND "merchandiseSubtotalVnd" IS NULL
    AND "shippingFeeVnd" IS NULL
    AND "totalVnd" IS NULL
  )
  OR
  (
    "checkoutSnapshottedAt" IS NOT NULL
    AND "guestName" IS NOT NULL
    AND "guestPhone" IS NOT NULL
    AND "provinceRef" IS NOT NULL
    AND "communeRef" IS NOT NULL
    AND "addressDetail" IS NOT NULL
    AND "merchandiseSubtotalVnd" IS NOT NULL
    AND "shippingFeeVnd" IS NOT NULL
    AND "totalVnd" IS NOT NULL
  )
);
