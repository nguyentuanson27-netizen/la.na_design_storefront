-- Gift & Quantity Promotions v1 (GQ15): the order's benefit-aware quote, stored by `lineId`.
--
-- Additive: one enum, four new tables and an OrderMirror state-transition guard. `OrderLineSnapshot`
-- (one row per variation, mutable while DRAFT) is untouched and keeps being the legacy record, so an
-- order priced before this migration, or priced with no gift and no quantity tier, has no row here and
-- is read exactly as before. NOTHING IS BACKFILLED: no campaign, entitlement or acknowledgement is
-- invented for an older order, and an application rollback is not blocked by a column older code never
-- writes. Nothing writes to these tables until the checkout DRAFT step (GQ17), itself behind
-- LA_GIFT_QUANTITY_PROMOTIONS_ENABLED.
--
-- Why a second record and not new columns on `OrderLineSnapshot`: that table is the per-variation
-- record the legacy checkout, the POS submit and the reconciliation read, and the new quote needs
-- several lines of one variation (EX-17/18: 2 x 100.001d + 1 x 90.001d, or a paid and a gift unit of one
-- variation) which a `(orderId, variationId)` reading would merge. Keeping them apart means legacy
-- readers cannot misread a segment as a whole line.
--
-- What the database guarantees, so it does not depend on every future caller remembering:
--   * the rows are changed only while the order is DRAFT (a re-quote replaces the whole set in one
--     transaction); the first state change freezes them, and deleting the order is RESTRICTed;
--   * lines carry integer money with `lineTotal = quantity x unitPrice`; a PAID line has a positive price
--     and no campaign, a GIFT line is a 0d READY line that names its campaign;
--   * at commit, the PAID lines add up to the stored merchandise subtotal, quantities and unclaimed slots
--     add up, every gift campaign has an entitlement and `selected` equals its gift lines, and slots not
--     taken require an acknowledgement.
-- The ordered discount ledger (`OrderQuoteDiscountStep`) is provenance; the chain base -> steps -> unit
-- price is validated by the single writer (`order-quote-snapshot.ts`), not re-derived here.
--
-- Rolling back (nothing else depends on it; no data in any older table is touched):
--   DROP TRIGGER "OrderQuoteDraftReentry_guard" ON "OrderMirror";
--   DROP TABLE "OrderQuoteDiscountStep", "OrderQuoteEntitlement", "OrderQuoteLine", "OrderQuoteSnapshot";
--   DROP TYPE "OrderQuoteLineRole";
--   DROP FUNCTION "order_quote_row_guard"(), "order_quote_verify_snapshot"(TEXT), "order_quote_verify_trigger"(), "order_quote_draft_reentry_guard"();

-- CreateEnum
CREATE TYPE "OrderQuoteLineRole" AS ENUM ('PAID', 'GIFT');

-- CreateTable
CREATE TABLE "OrderQuoteSnapshot" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "quoteFormat" TEXT NOT NULL,
    "quoteDigest" TEXT NOT NULL,
    "paidSubtotalVnd" BIGINT NOT NULL,
    "shippingFeeVnd" BIGINT NOT NULL,
    "totalVnd" BIGINT NOT NULL,
    "paidQuantity" INTEGER NOT NULL,
    "giftQuantity" INTEGER NOT NULL,
    "unclaimedSlots" INTEGER NOT NULL,
    "nonclaimAcknowledged" BOOLEAN NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "vendorProjectionHash" TEXT,
    "vendorProjection" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderQuoteSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderQuoteLine" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "role" "OrderQuoteLineRole" NOT NULL,
    "variantId" TEXT NOT NULL,
    "pancakeVariationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceVnd" BIGINT NOT NULL,
    "lineTotalVnd" BIGINT NOT NULL,
    "baseUnitPriceVnd" BIGINT,
    "fulfillmentState" "OrderPreorderLineState" NOT NULL,
    "campaignId" TEXT,
    "campaignRevision" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderQuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderQuoteDiscountStep" (
    "id" TEXT NOT NULL,
    "lineRowId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "campaignId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaignKind" TEXT NOT NULL,
    "priority" INTEGER,
    "inputPriceVnd" BIGINT NOT NULL,
    "outputPriceVnd" BIGINT NOT NULL,
    "appliedQuantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderQuoteDiscountStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderQuoteEntitlement" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignRevision" INTEGER NOT NULL,
    "entitled" INTEGER NOT NULL,
    "selected" INTEGER NOT NULL,
    "unclaimed" INTEGER NOT NULL,
    "skippedWhileAvailable" INTEGER NOT NULL,
    "contendedForSharedStock" INTEGER NOT NULL,
    "shortForStock" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderQuoteEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderQuoteSnapshot_orderId_key" ON "OrderQuoteSnapshot"("orderId");

-- CreateIndex
CREATE INDEX "OrderQuoteLine_snapshotId_pancakeVariationId_idx" ON "OrderQuoteLine"("snapshotId", "pancakeVariationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderQuoteLine_snapshotId_lineId_key" ON "OrderQuoteLine"("snapshotId", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderQuoteDiscountStep_lineRowId_position_key" ON "OrderQuoteDiscountStep"("lineRowId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "OrderQuoteEntitlement_snapshotId_campaignId_key" ON "OrderQuoteEntitlement"("snapshotId", "campaignId");

-- AddForeignKey
ALTER TABLE "OrderQuoteSnapshot" ADD CONSTRAINT "OrderQuoteSnapshot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderQuoteLine" ADD CONSTRAINT "OrderQuoteLine_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "OrderQuoteSnapshot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderQuoteDiscountStep" ADD CONSTRAINT "OrderQuoteDiscountStep_lineRowId_fkey" FOREIGN KEY ("lineRowId") REFERENCES "OrderQuoteLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderQuoteEntitlement" ADD CONSTRAINT "OrderQuoteEntitlement_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "OrderQuoteSnapshot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Bounds. Money is whole VND within the JavaScript safe-integer range the application reads it in.
ALTER TABLE "OrderQuoteSnapshot"
  ADD CONSTRAINT "OrderQuoteSnapshot_format_check" CHECK ("quoteFormat" = 'laq3'),
  ADD CONSTRAINT "OrderQuoteSnapshot_digest_check" CHECK ("quoteDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "OrderQuoteSnapshot_money_check" CHECK (
    "paidSubtotalVnd" BETWEEN 1 AND 9007199254740991
    AND "shippingFeeVnd" BETWEEN 0 AND 9007199254740991
    AND "totalVnd" = "paidSubtotalVnd" + "shippingFeeVnd"
    AND "totalVnd" <= 9007199254740991
  ),
  ADD CONSTRAINT "OrderQuoteSnapshot_quantity_check" CHECK (
    "paidQuantity" >= 1 AND "giftQuantity" BETWEEN 0 AND 100 AND "unclaimedSlots" >= 0
  ),
  -- FR-06: slots not taken need the buyer's explicit, signed acknowledgement.
  ADD CONSTRAINT "OrderQuoteSnapshot_acknowledgement_check" CHECK (
    ("unclaimedSlots" = 0 OR "nonclaimAcknowledged")
    AND ("nonclaimAcknowledged" = ("acknowledgedAt" IS NOT NULL))
  ),
  ADD CONSTRAINT "OrderQuoteSnapshot_vendor_projection_check" CHECK (
    ("vendorProjectionHash" IS NULL) = ("vendorProjection" IS NULL)
    AND ("vendorProjectionHash" IS NULL OR "vendorProjectionHash" ~ '^[0-9a-f]{64}$')
    AND ("vendorProjection" IS NULL OR (jsonb_typeof("vendorProjection") = 'array' AND pg_column_size("vendorProjection") <= 65536))
  );

ALTER TABLE "OrderQuoteLine"
  ADD CONSTRAINT "OrderQuoteLine_line_id_check" CHECK ("lineId" ~ '^[A-Za-z0-9:_-]{1,200}$'),
  ADD CONSTRAINT "OrderQuoteLine_identity_check" CHECK (
    char_length("variantId") BETWEEN 1 AND 200 AND char_length("pancakeVariationId") BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "OrderQuoteLine_quantity_check" CHECK ("quantity" >= 1),
  ADD CONSTRAINT "OrderQuoteLine_money_check" CHECK (
    "unitPriceVnd" BETWEEN 0 AND 9007199254740991
    AND "lineTotalVnd" = "quantity"::BIGINT * "unitPriceVnd"
    AND "lineTotalVnd" <= 9007199254740991
    AND ("baseUnitPriceVnd" IS NULL OR ("baseUnitPriceVnd" >= "unitPriceVnd" AND "baseUnitPriceVnd" <= 9007199254740991))
  ),
  -- Only the shape of each role is checked here; which gift is allowed is the entitlement engine's job.
  ADD CONSTRAINT "OrderQuoteLine_role_check" CHECK (
    ("role" = 'PAID'
      AND "unitPriceVnd" >= 1
      AND "campaignId" IS NULL AND "campaignRevision" IS NULL)
    OR
    ("role" = 'GIFT'
      AND "unitPriceVnd" = 0
      AND "baseUnitPriceVnd" IS NULL
      AND "fulfillmentState" = 'READY'
      AND "quantity" <= 100
      AND "campaignId" IS NOT NULL AND "campaignRevision" >= 1)
  );

ALTER TABLE "OrderQuoteDiscountStep"
  ADD CONSTRAINT "OrderQuoteDiscountStep_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "OrderQuoteDiscountStep_source_check" CHECK ("source" IN ('LEGACY', 'QUANTITY_TIER')),
  ADD CONSTRAINT "OrderQuoteDiscountStep_kind_check" CHECK (char_length("campaignKind") BETWEEN 1 AND 40 AND char_length("campaignId") BETWEEN 1 AND 200),
  ADD CONSTRAINT "OrderQuoteDiscountStep_price_check" CHECK (
    "inputPriceVnd" BETWEEN 1 AND 9007199254740991
    AND "outputPriceVnd" BETWEEN 1 AND "inputPriceVnd"
    AND "appliedQuantity" >= 1
  );

ALTER TABLE "OrderQuoteEntitlement"
  ADD CONSTRAINT "OrderQuoteEntitlement_campaign_check" CHECK (
    char_length("campaignId") BETWEEN 1 AND 200 AND "campaignRevision" >= 1
  ),
  ADD CONSTRAINT "OrderQuoteEntitlement_slots_check" CHECK (
    "entitled" BETWEEN 0 AND 100
    AND "selected" BETWEEN 0 AND "entitled"
    AND "unclaimed" = "entitled" - "selected"
    AND "skippedWhileAvailable" >= 0 AND "contendedForSharedStock" >= 0 AND "shortForStock" >= 0
    AND "skippedWhileAvailable" + "contendedForSharedStock" + "shortForStock" = "unclaimed"
  );

-- A quote-bearing order cannot re-enter editable DRAFT after its first exit. Legacy orders have no
-- quote snapshot, so their existing VALIDATING -> DRAFT reprice/outage retries remain unchanged.
-- UPDATE already locks OrderMirror, the same parent lock quote writers/row guards take. A changed
-- benefit quote after validation needs a new order; returning the old order to DRAFT must not unfreeze it.
CREATE FUNCTION "order_quote_draft_reentry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' AND NEW."state" = 'DRAFT'
    AND EXISTS (SELECT 1 FROM "OrderQuoteSnapshot" WHERE "orderId" = OLD."id") THEN
    RAISE EXCEPTION 'An order with a quote snapshot cannot return to DRAFT after its first exit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderQuoteDraftReentry_guard"
BEFORE UPDATE OF "state" ON "OrderMirror"
FOR EACH ROW EXECUTE FUNCTION "order_quote_draft_reentry_guard"();

-- Changes only while the order is DRAFT. The order is found through the row's own parent chain; a row
-- cannot be moved to another parent. Reading is unrestricted.
CREATE FUNCTION "order_quote_row_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_order TEXT;
  order_state TEXT;
BEGIN
  IF TG_TABLE_NAME = 'OrderQuoteSnapshot' THEN
    target_order := CASE WHEN TG_OP = 'DELETE' THEN OLD."orderId" ELSE NEW."orderId" END;
    IF TG_OP = 'UPDATE' THEN
      IF NEW."orderId" <> OLD."orderId" THEN
        RAISE EXCEPTION 'An order quote snapshot cannot be moved to another order';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'OrderQuoteLine' THEN
    SELECT s."orderId" INTO target_order FROM "OrderQuoteSnapshot" s
      WHERE s."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END;
    IF TG_OP = 'UPDATE' THEN
      IF NEW."snapshotId" <> OLD."snapshotId" THEN
        RAISE EXCEPTION 'An order quote line cannot be moved to another snapshot';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'OrderQuoteEntitlement' THEN
    SELECT s."orderId" INTO target_order FROM "OrderQuoteSnapshot" s
      WHERE s."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END;
    IF TG_OP = 'UPDATE' THEN
      IF NEW."snapshotId" <> OLD."snapshotId" THEN
        RAISE EXCEPTION 'An order quote entitlement cannot be moved to another snapshot';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'OrderQuoteDiscountStep' THEN
    SELECT s."orderId" INTO target_order
      FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId"
      WHERE l."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."lineRowId" ELSE NEW."lineRowId" END;
    IF TG_OP = 'UPDATE' THEN
      IF NEW."lineRowId" <> OLD."lineRowId" THEN
        RAISE EXCEPTION 'An order quote discount step cannot be moved to another line';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'order_quote_row_guard is not defined for %', TG_TABLE_NAME;
  END IF;

  -- Hold the parent until commit: a plain read (or FK KEY SHARE) lets a state UPDATE commit
  -- between this DRAFT check and the quote write. Recheck the current state after any wait.
  -- Application writers/state transitions lock OrderMirror before touching quote children.
  SELECT o."state"::TEXT INTO order_state FROM "OrderMirror" o WHERE o."id" = target_order FOR UPDATE;
  IF order_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Order quote rows are immutable once the order has left DRAFT';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "OrderQuoteSnapshot_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteSnapshot"
FOR EACH ROW EXECUTE FUNCTION "order_quote_row_guard"();

CREATE TRIGGER "OrderQuoteLine_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteLine"
FOR EACH ROW EXECUTE FUNCTION "order_quote_row_guard"();

CREATE TRIGGER "OrderQuoteEntitlement_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteEntitlement"
FOR EACH ROW EXECUTE FUNCTION "order_quote_row_guard"();

CREATE TRIGGER "OrderQuoteDiscountStep_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "OrderQuoteDiscountStep"
FOR EACH ROW EXECUTE FUNCTION "order_quote_row_guard"();

-- Cross-row consistency, checked once per transaction at COMMIT (the rows of one quote arrive together).
CREATE FUNCTION "order_quote_verify_snapshot"(target_snapshot TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  snap RECORD;
  paid_total NUMERIC;
  paid_units BIGINT;
  gift_units BIGINT;
  unclaimed_total BIGINT;
BEGIN
  SELECT * INTO snap FROM "OrderQuoteSnapshot" WHERE "id" = target_snapshot;
  IF NOT FOUND THEN
    RETURN; -- the whole quote was replaced or removed in this transaction
  END IF;

  SELECT COALESCE(SUM("lineTotalVnd"), 0), COALESCE(SUM("quantity"), 0) INTO paid_total, paid_units
    FROM "OrderQuoteLine" WHERE "snapshotId" = target_snapshot AND "role" = 'PAID';
  SELECT COALESCE(SUM("quantity"), 0) INTO gift_units
    FROM "OrderQuoteLine" WHERE "snapshotId" = target_snapshot AND "role" = 'GIFT';
  SELECT COALESCE(SUM("unclaimed"), 0) INTO unclaimed_total
    FROM "OrderQuoteEntitlement" WHERE "snapshotId" = target_snapshot;

  IF paid_total <> snap."paidSubtotalVnd" THEN
    RAISE EXCEPTION 'Order quote paid lines (%) do not add up to the paid subtotal (%)', paid_total, snap."paidSubtotalVnd";
  END IF;
  IF paid_units <> snap."paidQuantity" OR gift_units <> snap."giftQuantity" THEN
    RAISE EXCEPTION 'Order quote line quantities do not match the snapshot totals';
  END IF;
  IF unclaimed_total <> snap."unclaimedSlots" THEN
    RAISE EXCEPTION 'Order quote entitlements do not add up to the unclaimed slots';
  END IF;
  -- A gift needs an entitlement of its campaign, and the slots taken equal the gift lines of that campaign.
  IF EXISTS (
    SELECT 1 FROM "OrderQuoteLine" l
    WHERE l."snapshotId" = target_snapshot AND l."role" = 'GIFT'
      AND NOT EXISTS (
        SELECT 1 FROM "OrderQuoteEntitlement" e
        WHERE e."snapshotId" = target_snapshot AND e."campaignId" = l."campaignId" AND e."campaignRevision" = l."campaignRevision"
      )
  ) THEN
    RAISE EXCEPTION 'An order quote gift line has no entitlement of its campaign';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "OrderQuoteEntitlement" e
    WHERE e."snapshotId" = target_snapshot
      AND e."selected" <> COALESCE((
        SELECT SUM(l."quantity") FROM "OrderQuoteLine" l
        WHERE l."snapshotId" = target_snapshot AND l."role" = 'GIFT' AND l."campaignId" = e."campaignId"
      ), 0)
  ) THEN
    RAISE EXCEPTION 'An order quote entitlement does not match the gift lines of its campaign';
  END IF;
END;
$$;

CREATE FUNCTION "order_quote_verify_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'OrderQuoteSnapshot' THEN
    PERFORM "order_quote_verify_snapshot"(CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END);
  ELSE
    PERFORM "order_quote_verify_snapshot"(CASE WHEN TG_OP = 'DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "OrderQuoteSnapshot_verify"
AFTER INSERT OR UPDATE ON "OrderQuoteSnapshot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "order_quote_verify_trigger"();

CREATE CONSTRAINT TRIGGER "OrderQuoteLine_verify"
AFTER INSERT OR UPDATE OR DELETE ON "OrderQuoteLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "order_quote_verify_trigger"();

CREATE CONSTRAINT TRIGGER "OrderQuoteEntitlement_verify"
AFTER INSERT OR UPDATE OR DELETE ON "OrderQuoteEntitlement"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "order_quote_verify_trigger"();
