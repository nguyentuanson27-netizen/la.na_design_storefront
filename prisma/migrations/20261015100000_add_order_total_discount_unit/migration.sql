-- Order-value discount ladders (owner decision 15/10/2026): "from X ₫ take Y % / Z ₫ off the order".
--
-- Step 1 of 2. PostgreSQL does not let a new enum value be used in the transaction that adds it, so
-- the value is added here on its own and the constraints that name it follow in the next migration.
--
-- Additive: an enum value that no row uses can stay. Nothing writes it until the admin write
-- contract does, and that is behind LA_GIFT_QUANTITY_PROMOTIONS_ENABLED.
ALTER TYPE "QuantityTierDiscountUnit" ADD VALUE IF NOT EXISTS 'FIXED_AMOUNT_TOTAL_VND';
