-- Voucher v1 (SPEC-VOUCHER-001, ADR 0018). Approved by the owner as gates H1-D and H2 on 2026-10-25.
-- Additive only: new enums/tables/functions/triggers. No existing column, row or constraint is changed, and
-- nothing is read or written until LA_VOUCHER_ENABLED is on. Historical orders have no acceptance or
-- redemption row and are therefore never frozen or touched by the guards below.
--
-- Rollback (nothing else depends on these objects until voucher code ships):
--   DROP TRIGGER "OrderMirror_acceptance_freeze" ON "OrderMirror";
--   DROP TRIGGER "OrderLineSnapshot_acceptance_freeze" ON "OrderLineSnapshot";
--   DROP TRIGGER "OrderQuoteSnapshot_acceptance_freeze" ON "OrderQuoteSnapshot";
--   DROP TRIGGER "OrderQuoteLine_acceptance_freeze" ON "OrderQuoteLine";
--   DROP TRIGGER "OrderQuoteEntitlement_acceptance_freeze" ON "OrderQuoteEntitlement";
--   DROP TRIGGER "OrderQuoteDiscountStep_acceptance_freeze" ON "OrderQuoteDiscountStep";
--   DROP TABLE "CartVoucherSelection", "VoucherRedemption", "OrderAcceptance", "VoucherHold", "VoucherCampaign";
--   DROP FUNCTION "voucher_order_freeze_guard"(), "voucher_acceptance_guard"(), "voucher_hold_guard"(),
--     "voucher_redemption_guard"();
--   DROP TYPE "VoucherSelectionMode", "VoucherHoldState", "VoucherScopeMode", "VoucherDiscountType",
--     "VoucherVisibility", "VoucherIssuance", "VoucherKind";

CREATE TYPE "VoucherKind" AS ENUM ('MERCHANDISE', 'SHIPPING_FREE');
CREATE TYPE "VoucherIssuance" AS ENUM ('AUTO', 'CODE');
CREATE TYPE "VoucherVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "VoucherDiscountType" AS ENUM ('FIXED_AMOUNT_VND', 'PERCENTAGE');
CREATE TYPE "VoucherScopeMode" AS ENUM ('ALL_SHOP', 'TARGETED');
CREATE TYPE "VoucherHoldState" AS ENUM ('HELD', 'CONSUMED', 'RELEASED', 'EXPIRED');
CREATE TYPE "VoucherSelectionMode" AS ENUM ('AUTO', 'MANUAL');

-- ---------------------------------------------------------------------------------------------------
-- Campaign + ledger. The CHECKs are the database's own copy of the validation rules and of the quota
-- invariant: redeemed + reserved never exceeds a cap, so a cap edit under the committed floor fails here
-- even when it bypasses the Admin service (TG-05 A, AC-44).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "VoucherCampaign" (
  "id" TEXT NOT NULL,
  "pancakeShopId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "VoucherKind" NOT NULL,
  "issuance" "VoucherIssuance" NOT NULL,
  "visibility" "VoucherVisibility" NOT NULL,
  "code" TEXT,
  "discountType" "VoucherDiscountType",
  "fixedAmountVnd" BIGINT,
  "percent" INTEGER,
  "maxDiscountVnd" BIGINT,
  "minEligibleSubtotalVnd" BIGINT,
  "scopeMode" "VoucherScopeMode" NOT NULL,
  "categoryKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "includeProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "excludeProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "enabledAt" TIMESTAMPTZ(3),
  "disabledAt" TIMESTAMPTZ(3),
  "startsAt" TIMESTAMPTZ(3),
  "endsAt" TIMESTAMPTZ(3),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "maxUses" INTEGER,
  "maxBudgetVnd" BIGINT,
  "redeemedUses" INTEGER NOT NULL DEFAULT 0,
  "redeemedVnd" BIGINT NOT NULL DEFAULT 0,
  "reservedUses" INTEGER NOT NULL DEFAULT 0,
  "reservedVnd" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "VoucherCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherCampaign_values_check" CHECK (
    "pancakeShopId" > 0 AND length(btrim("name")) BETWEEN 1 AND 120 AND "revision" > 0
    AND cardinality("categoryKeys") <= 50 AND cardinality("includeProductIds") <= 500
    AND cardinality("excludeProductIds") <= 500
    AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt")
    AND (NOT "isEnabled" OR "enabledAt" IS NOT NULL)
    AND ("minEligibleSubtotalVnd" IS NULL OR "minEligibleSubtotalVnd" BETWEEN 1 AND 100000000000)
  ),
  CONSTRAINT "VoucherCampaign_issuance_check" CHECK (
    ("issuance" = 'AUTO' AND "code" IS NULL AND "visibility" = 'PUBLIC')
    OR ("issuance" = 'CODE' AND "code" ~ '^[A-Z0-9_-]{3,32}$')
  ),
  CONSTRAINT "VoucherCampaign_discount_check" CHECK (
    ("kind" = 'SHIPPING_FREE' AND "discountType" IS NULL AND "fixedAmountVnd" IS NULL
      AND "percent" IS NULL AND "maxDiscountVnd" IS NULL)
    OR ("kind" = 'MERCHANDISE' AND (
      ("discountType" = 'FIXED_AMOUNT_VND' AND "fixedAmountVnd" BETWEEN 1 AND 100000000000
        AND "percent" IS NULL AND "maxDiscountVnd" IS NULL
        AND "minEligibleSubtotalVnd" IS NOT NULL AND "minEligibleSubtotalVnd" > "fixedAmountVnd")
      OR ("discountType" = 'PERCENTAGE' AND "percent" BETWEEN 1 AND 99 AND "fixedAmountVnd" IS NULL
        AND ("maxDiscountVnd" IS NULL OR "maxDiscountVnd" BETWEEN 1 AND 100000000000))
    ))
  ),
  CONSTRAINT "VoucherCampaign_scope_check" CHECK (
    ("scopeMode" = 'ALL_SHOP' AND cardinality("categoryKeys") = 0 AND cardinality("includeProductIds") = 0)
    OR ("scopeMode" = 'TARGETED' AND cardinality("categoryKeys") + cardinality("includeProductIds") > 0)
  ),
  CONSTRAINT "VoucherCampaign_quota_check" CHECK (
    ("maxUses" IS NULL OR "maxUses" BETWEEN 1 AND 100000000)
    AND ("maxBudgetVnd" IS NULL OR "maxBudgetVnd" BETWEEN 1 AND 1000000000000)
    AND "redeemedUses" >= 0 AND "redeemedVnd" >= 0 AND "reservedUses" >= 0 AND "reservedVnd" >= 0
    AND ("maxUses" IS NULL OR "redeemedUses" + "reservedUses" <= "maxUses")
    AND ("maxBudgetVnd" IS NULL OR "redeemedVnd" + "reservedVnd" <= "maxBudgetVnd")
  )
);
CREATE UNIQUE INDEX "VoucherCampaign_pancakeShopId_code_key" ON "VoucherCampaign"("pancakeShopId", "code");
CREATE INDEX "VoucherCampaign_pancakeShopId_isEnabled_kind_issuance_visib_idx"
  ON "VoucherCampaign"("pancakeShopId", "isEnabled", "kind", "issuance", "visibility");

-- ---------------------------------------------------------------------------------------------------
-- Hold: an absolute 10-minute entitlement, one live hold per attempt and kind.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "VoucherHold" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "campaignRevision" INTEGER NOT NULL,
  "pancakeShopId" INTEGER NOT NULL,
  "kind" "VoucherKind" NOT NULL,
  "attemptKey" TEXT NOT NULL,
  "quoteDigest" TEXT NOT NULL,
  "paidRevision" BIGINT NOT NULL,
  "heldDiscountVnd" BIGINT NOT NULL,
  "state" "VoucherHoldState" NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "releasedAt" TIMESTAMPTZ(3),
  "orderId" TEXT,
  CONSTRAINT "VoucherHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherHold_values_check" CHECK (
    "campaignRevision" > 0 AND "pancakeShopId" > 0 AND "paidRevision" >= 0
    AND "heldDiscountVnd" BETWEEN 1 AND 100000000000
    AND "attemptKey" ~ '^[0-9a-f]{64}$' AND "quoteDigest" ~ '^[0-9a-f]{64}$'
    AND "expiresAt" = "createdAt" + interval '10 minutes'
  ),
  CONSTRAINT "VoucherHold_state_check" CHECK (
    ("state" = 'HELD' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "orderId" IS NULL)
    OR ("state" = 'CONSUMED' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "orderId" IS NOT NULL)
    OR ("state" IN ('RELEASED', 'EXPIRED') AND "releasedAt" IS NOT NULL AND "consumedAt" IS NULL AND "orderId" IS NULL)
  )
);
CREATE INDEX "VoucherHold_campaignId_state_expiresAt_idx" ON "VoucherHold"("campaignId", "state", "expiresAt");
CREATE INDEX "VoucherHold_attemptKey_kind_state_idx" ON "VoucherHold"("attemptKey", "kind", "state");
CREATE UNIQUE INDEX "VoucherHold_live_attempt_kind_key" ON "VoucherHold"("attemptKey", "kind") WHERE "state" = 'HELD';
ALTER TABLE "VoucherHold" ADD CONSTRAINT "VoucherHold_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "VoucherCampaign"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "VoucherHold" ADD CONSTRAINT "VoucherHold_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------
-- Redemption (consumed voucher of an accepted order) and the website-accepted marker (ADR 0018 D-1).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "VoucherRedemption" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "campaignRevision" INTEGER NOT NULL,
  "kind" "VoucherKind" NOT NULL,
  "orderId" TEXT NOT NULL,
  "holdId" TEXT NOT NULL,
  "amountVnd" BIGINT NOT NULL,
  "websiteAcceptedAt" TIMESTAMPTZ(3) NOT NULL,
  "refundedAt" TIMESTAMPTZ(3),
  "refundReason" TEXT,
  "refundEvidence" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoucherRedemption_values_check" CHECK (
    "campaignRevision" > 0 AND "amountVnd" BETWEEN 1 AND 100000000000
    AND ("refundedAt" IS NULL OR "refundedAt" >= "websiteAcceptedAt")
    AND (
      ("refundedAt" IS NULL AND "refundReason" IS NULL AND "refundEvidence" IS NULL)
      OR ("refundedAt" IS NOT NULL AND "refundReason" IS NOT NULL AND "refundEvidence" IS NOT NULL
        AND length(btrim("refundReason")) BETWEEN 1 AND 200
        AND length(btrim("refundEvidence")) BETWEEN 1 AND 500)
    )
  )
);
CREATE UNIQUE INDEX "VoucherRedemption_holdId_key" ON "VoucherRedemption"("holdId");
CREATE UNIQUE INDEX "VoucherRedemption_orderId_kind_key" ON "VoucherRedemption"("orderId", "kind");
CREATE INDEX "VoucherRedemption_campaignId_refundedAt_idx" ON "VoucherRedemption"("campaignId", "refundedAt");
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "VoucherCampaign"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_holdId_fkey"
  FOREIGN KEY ("holdId") REFERENCES "VoucherHold"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "OrderAcceptance" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "quoteDigest" TEXT NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderAcceptance_values_check" CHECK ("quoteDigest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "OrderAcceptance_orderId_key" ON "OrderAcceptance"("orderId");
ALTER TABLE "OrderAcceptance" ADD CONSTRAINT "OrderAcceptance_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------
-- Cart-bound selection (ADR 0018 D-5): intent only. Voucher ids are deliberately not foreign keys.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "CartVoucherSelection" (
  "cartId" TEXT NOT NULL,
  "merchandiseMode" "VoucherSelectionMode" NOT NULL DEFAULT 'AUTO',
  "merchandiseVoucherId" TEXT,
  "shippingMode" "VoucherSelectionMode" NOT NULL DEFAULT 'AUTO',
  "shippingVoucherId" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "CartVoucherSelection_pkey" PRIMARY KEY ("cartId"),
  CONSTRAINT "CartVoucherSelection_values_check" CHECK (
    ("merchandiseMode" = 'MANUAL' OR "merchandiseVoucherId" IS NULL)
    AND ("shippingMode" = 'MANUAL' OR "shippingVoucherId" IS NULL)
    AND ("merchandiseVoucherId" IS NULL OR length("merchandiseVoucherId") BETWEEN 1 AND 64)
    AND ("shippingVoucherId" IS NULL OR length("shippingVoucherId") BETWEEN 1 AND 64)
    AND "expiresAt" > "createdAt"
  )
);
ALTER TABLE "CartVoucherSelection" ADD CONSTRAINT "CartVoucherSelection_cartId_fkey"
  FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------------

-- Hold: identity and expiry are frozen (no rolling TTL); a terminal state is final; a hold is consumed only
-- before its own expiry by the database clock (spec §5.1: the request, not a cleanup job, is the authority).
CREATE FUNCTION "voucher_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."state" IN ('HELD', 'CONSUMED') THEN
      RAISE EXCEPTION 'A live or consumed voucher hold cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."campaignId" <> OLD."campaignId" OR NEW."campaignRevision" <> OLD."campaignRevision"
     OR NEW."pancakeShopId" <> OLD."pancakeShopId" OR NEW."kind" <> OLD."kind"
     OR NEW."attemptKey" <> OLD."attemptKey" OR NEW."quoteDigest" <> OLD."quoteDigest"
     OR NEW."paidRevision" <> OLD."paidRevision" OR NEW."heldDiscountVnd" <> OLD."heldDiscountVnd"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A voucher hold keeps its identity, amount and expiry for its whole life';
  END IF;
  IF OLD."state" <> 'HELD' THEN
    IF ROW(NEW."state", NEW."consumedAt", NEW."releasedAt", NEW."orderId")
       IS DISTINCT FROM ROW(OLD."state", OLD."consumedAt", OLD."releasedAt", OLD."orderId") THEN
      RAISE EXCEPTION 'A settled voucher hold cannot change state';
    END IF;
  ELSIF NEW."state" = 'CONSUMED' AND clock_timestamp() >= OLD."expiresAt" THEN
    RAISE EXCEPTION 'An expired voucher hold cannot be consumed';
  ELSIF NEW."state" = 'EXPIRED' AND clock_timestamp() < OLD."expiresAt" THEN
    RAISE EXCEPTION 'A voucher hold cannot expire before its expiry';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherHold_guard" BEFORE UPDATE OR DELETE ON "VoucherHold"
FOR EACH ROW EXECUTE FUNCTION "voucher_hold_guard"();

-- Redemption: only a consumed hold of the same order/kind/campaign/amount on an accepted order can be
-- redeemed; afterwards only the one-way refund columns move, and a refund is final.
CREATE FUNCTION "voucher_redemption_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A voucher redemption is a ledger entry and cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT h."state", h."orderId", h."kind", h."campaignId", h."campaignRevision", h."heldDiscountVnd"
      INTO held FROM "VoucherHold" h WHERE h."id" = NEW."holdId";
    IF NOT FOUND OR held."state" <> 'CONSUMED' OR held."orderId" IS DISTINCT FROM NEW."orderId"
       OR held."kind" <> NEW."kind" OR held."campaignId" <> NEW."campaignId"
       OR held."campaignRevision" <> NEW."campaignRevision" OR held."heldDiscountVnd" <> NEW."amountVnd" THEN
      RAISE EXCEPTION 'A voucher redemption must match a consumed hold of the same order, kind, campaign and amount';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "OrderAcceptance" a WHERE a."orderId" = NEW."orderId") THEN
      RAISE EXCEPTION 'A voucher can be redeemed only by a website-accepted order';
    END IF;
    IF NEW."refundedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A voucher redemption cannot be created already refunded';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."campaignId" <> OLD."campaignId" OR NEW."campaignRevision" <> OLD."campaignRevision"
     OR NEW."kind" <> OLD."kind" OR NEW."orderId" <> OLD."orderId" OR NEW."holdId" <> OLD."holdId"
     OR NEW."amountVnd" <> OLD."amountVnd" OR NEW."websiteAcceptedAt" <> OLD."websiteAcceptedAt"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A voucher redemption keeps its identity and amount';
  END IF;
  IF OLD."refundedAt" IS NOT NULL
     AND ROW(NEW."refundedAt", NEW."refundReason", NEW."refundEvidence")
       IS DISTINCT FROM ROW(OLD."refundedAt", OLD."refundReason", OLD."refundEvidence") THEN
    RAISE EXCEPTION 'A voucher refund is final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VoucherRedemption_guard" BEFORE INSERT OR UPDATE OR DELETE ON "VoucherRedemption"
FOR EACH ROW EXECUTE FUNCTION "voucher_redemption_guard"();

-- Acceptance marker: insert-only, and only for an order whose immutable quote snapshot carries the same digest.
CREATE FUNCTION "voucher_acceptance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_digest TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An order acceptance marker is insert-only';
  END IF;
  SELECT s."quoteDigest" INTO snapshot_digest FROM "OrderQuoteSnapshot" s WHERE s."orderId" = NEW."orderId";
  IF snapshot_digest IS NULL OR snapshot_digest <> NEW."quoteDigest" THEN
    RAISE EXCEPTION 'An order can be accepted only with the digest of its own quote snapshot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderAcceptance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrderAcceptance"
FOR EACH ROW EXECUTE FUNCTION "voucher_acceptance_guard"();

-- ADR 0018 D-2: once an order is accepted, its money and its quote rows cannot be written again, whatever the
-- order state. State, Pancake identifiers and sync fields stay writable so the order can still move on.
CREATE FUNCTION "voucher_order_freeze_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_order TEXT;
BEGIN
  IF TG_TABLE_NAME = 'OrderMirror' THEN
    target_order := OLD."id";
  ELSIF TG_TABLE_NAME = 'OrderLineSnapshot' OR TG_TABLE_NAME = 'OrderQuoteSnapshot' THEN
    target_order := CASE WHEN TG_OP = 'DELETE' THEN OLD."orderId" ELSE NEW."orderId" END;
  ELSIF TG_TABLE_NAME = 'OrderQuoteLine' OR TG_TABLE_NAME = 'OrderQuoteEntitlement' THEN
    SELECT s."orderId" INTO target_order FROM "OrderQuoteSnapshot" s
      WHERE s."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END;
  ELSIF TG_TABLE_NAME = 'OrderQuoteDiscountStep' THEN
    SELECT s."orderId" INTO target_order
      FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId"
      WHERE l."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."lineRowId" ELSE NEW."lineRowId" END;
  ELSE
    RAISE EXCEPTION 'voucher_order_freeze_guard is not defined for %', TG_TABLE_NAME;
  END IF;
  IF target_order IS NOT NULL AND EXISTS (SELECT 1 FROM "OrderAcceptance" a WHERE a."orderId" = target_order) THEN
    RAISE EXCEPTION 'The money and quote of a website-accepted order are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "OrderMirror_acceptance_freeze" BEFORE UPDATE ON "OrderMirror"
FOR EACH ROW WHEN (
  OLD."merchandiseSubtotalVnd" IS DISTINCT FROM NEW."merchandiseSubtotalVnd"
  OR OLD."shippingFeeVnd" IS DISTINCT FROM NEW."shippingFeeVnd"
  OR OLD."totalVnd" IS DISTINCT FROM NEW."totalVnd"
  OR OLD."shippingBaseFeeVnd" IS DISTINCT FROM NEW."shippingBaseFeeVnd"
  OR OLD."shippingPromotionCampaignId" IS DISTINCT FROM NEW."shippingPromotionCampaignId"
  OR OLD."shippingPromotionRevision" IS DISTINCT FROM NEW."shippingPromotionRevision"
) EXECUTE FUNCTION "voucher_order_freeze_guard"();
CREATE TRIGGER "OrderLineSnapshot_acceptance_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "OrderLineSnapshot"
FOR EACH ROW EXECUTE FUNCTION "voucher_order_freeze_guard"();
CREATE TRIGGER "OrderQuoteSnapshot_acceptance_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteSnapshot"
FOR EACH ROW EXECUTE FUNCTION "voucher_order_freeze_guard"();
CREATE TRIGGER "OrderQuoteLine_acceptance_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteLine"
FOR EACH ROW EXECUTE FUNCTION "voucher_order_freeze_guard"();
CREATE TRIGGER "OrderQuoteEntitlement_acceptance_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteEntitlement"
FOR EACH ROW EXECUTE FUNCTION "voucher_order_freeze_guard"();
CREATE TRIGGER "OrderQuoteDiscountStep_acceptance_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteDiscountStep"
FOR EACH ROW EXECUTE FUNCTION "voucher_order_freeze_guard"();
