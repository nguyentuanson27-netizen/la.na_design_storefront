-- Order-value discount ladders (owner decision 15/10/2026), step 2 of 2.
--
-- A QUANTITY_TIER campaign gains a `tierBasis`: what its thresholds count. NULL means QUANTITY, so
-- every row that exists today, and every writer that does not know about the column, keeps its exact
-- meaning. ORDER_SUBTOTAL thresholds are VND of paid order value (after every other discount, before
-- shipping, gifts excluded); the discount is a percentage or a VND total off the whole order.
--
-- Everything below only adds or widens what a row may hold in the new shape; no stored row is
-- rewritten except that the existing tier campaigns are stamped QUANTITY for readability.

CREATE TYPE "QuantityTierBasis" AS ENUM ('QUANTITY', 'ORDER_SUBTOTAL');

ALTER TABLE "GiftQuantityCampaign" ADD COLUMN "tierBasis" "QuantityTierBasis";

UPDATE "GiftQuantityCampaign" SET "tierBasis" = 'QUANTITY' WHERE "kind" = 'QUANTITY_TIER';

-- The gift and tier field groups stay mutually exclusive; the basis belongs to the tier group.
ALTER TABLE "GiftQuantityCampaign" DROP CONSTRAINT "GiftQuantityCampaign_rule_shape_check";
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_rule_shape_check"
CHECK (
  (
    "kind" = 'GIFT_ITEM'
    AND "tierBasis" IS NULL
    AND "tierUnit" IS NULL
    AND "tierDiscountedUnits" IS NULL
    AND "tierSelectionPriority" IS NULL
  )
  OR (
    "kind" = 'QUANTITY_TIER'
    AND "giftTrigger" IS NULL
    AND "minimumQuantity" IS NULL
    AND "minimumSubtotalVnd" IS NULL
    AND "subtotalScope" IS NULL
    AND "awardMode" IS NULL
    AND "maxGiftsPerOrder" IS NULL
    AND "allowDuplicateGifts" IS NULL
  )
);

-- An order-value ladder discounts the whole order: a percentage or a total, every unit, no
-- "from the threshold" slice and no cheapest/most-expensive choice. A total off the order is an
-- order-value idea only; a QUANTITY ladder cannot hold it. COALESCE keeps an unset basis from
-- passing as NULL.
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_tier_basis_check"
CHECK (
  (
    "tierBasis" IS DISTINCT FROM 'ORDER_SUBTOTAL'
    OR (
      ("tierUnit" IS NULL OR "tierUnit" IN ('PERCENTAGE', 'FIXED_AMOUNT_TOTAL_VND'))
      AND ("tierDiscountedUnits" IS NULL OR "tierDiscountedUnits" = 'ALL_ELIGIBLE_UNITS')
      AND "tierSelectionPriority" IS NULL
    )
  )
  AND (
    COALESCE("tierBasis" = 'ORDER_SUBTOTAL', FALSE)
    OR "tierUnit" IS DISTINCT FROM 'FIXED_AMOUNT_TOTAL_VND'
  )
);

-- Owner decision: an order-value ladder applies to the whole basket. So the global scope now also
-- belongs to ORDER_SUBTOTAL tiers, and an ORDER_SUBTOTAL tier can have no other scope.
ALTER TABLE "GiftQuantityCampaign" DROP CONSTRAINT "GiftQuantityCampaign_global_scope_check";
ALTER TABLE "GiftQuantityCampaign"
ADD CONSTRAINT "GiftQuantityCampaign_global_scope_check"
CHECK (
  (
    "scopeMode" <> 'GLOBAL_ALL_PAID_LINES'
    OR (
      cardinality("categoryKeys") = 0
      AND (
        (
          "kind" = 'GIFT_ITEM'
          AND COALESCE("giftTrigger" = 'ORDER_SUBTOTAL', FALSE)
          AND COALESCE("subtotalScope" = 'ALL_PAID_LINES', FALSE)
        )
        OR (
          "kind" = 'QUANTITY_TIER'
          AND COALESCE("tierBasis" = 'ORDER_SUBTOTAL', FALSE)
        )
      )
    )
  )
  AND (
    COALESCE("tierBasis" = 'ORDER_SUBTOTAL', FALSE) = FALSE
    OR "scopeMode" = 'GLOBAL_ALL_PAID_LINES'
  )
);

-- The threshold column now also holds VND of order value, so its ceiling moves from 1.000.000 to
-- the INTEGER-safe 2.000.000.000 the application already uses for money. A QUANTITY ladder keeps
-- its tighter application bound. A total off the order must stay below the order value that
-- earns it, so no order can be priced at or below nothing.
ALTER TABLE "QuantityTier" DROP CONSTRAINT "QuantityTier_bounds_check";
ALTER TABLE "QuantityTier"
ADD CONSTRAINT "QuantityTier_bounds_check"
CHECK (
  "minQuantity" BETWEEN 1 AND 2000000000
  AND "discountValue" BETWEEN 1 AND 2000000000
  AND ("unit" <> 'PERCENTAGE' OR "discountValue" <= 99)
  AND ("unit" <> 'FIXED_AMOUNT_TOTAL_VND' OR "discountValue" < "minQuantity")
);
