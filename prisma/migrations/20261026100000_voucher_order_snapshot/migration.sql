-- Voucher v1 V13 (SPEC-VOUCHER-001, ADR 0018 D-3 step 3d). Additive only: one new table, one index, one function and
-- trigger. Nothing existing is altered, and nothing is read or written until voucher code is enabled.
--
-- Why this exists: the order must DECLARE its vouchers before it is submitted, so acceptance consumes exactly the
-- vouchers the checkout quoted and a voucher-priced order can never be accepted as a plain one. A HELD voucher hold
-- cannot carry the order id (VoucherHold_state_check), so the declaration lives on the order side as the frozen
-- voucher snapshot (V10 `VoucherOrderSnapshot`, versioned JSON). It follows the quote rows' own rule: it can be
-- written only while the order is a DRAFT, and from acceptance on it is protected with the rest of the order.
--
-- Rollback (nothing depends on it until the V13 code ships):
--   DROP TRIGGER "OrderVoucherSnapshot_guard" ON "OrderVoucherSnapshot";
--   DROP FUNCTION "voucher_snapshot_guard"();
--   DROP TABLE "OrderVoucherSnapshot";
--   DROP INDEX "VoucherHold_orderId_idx";

CREATE TABLE "OrderVoucherSnapshot" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderVoucherSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderVoucherSnapshot_shape_check" CHECK (jsonb_typeof("snapshot") = 'object' AND ("snapshot"->>'v')::INT = 1)
);
CREATE UNIQUE INDEX "OrderVoucherSnapshot_orderId_key" ON "OrderVoucherSnapshot"("orderId");
ALTER TABLE "OrderVoucherSnapshot" ADD CONSTRAINT "OrderVoucherSnapshot_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Settling (V13 consume, V14 release by order) looks holds up by order.
CREATE INDEX "VoucherHold_orderId_idx" ON "VoucherHold"("orderId");

-- Insert-only, and only while the order is still a DRAFT (the parent row is locked until commit, as for the quote
-- rows, so a state change cannot slip between this check and the write). Never updated; deletable only while the
-- order is a DRAFT and not accepted.
CREATE FUNCTION "voucher_snapshot_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state TEXT;
  target_order TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An order voucher snapshot is insert-only';
  END IF;
  target_order := CASE WHEN TG_OP = 'DELETE' THEN OLD."orderId" ELSE NEW."orderId" END;
  SELECT o."state"::TEXT INTO order_state FROM "OrderMirror" o WHERE o."id" = target_order FOR UPDATE;
  IF order_state IS DISTINCT FROM 'DRAFT' OR EXISTS (SELECT 1 FROM "OrderAcceptance" a WHERE a."orderId" = target_order) THEN
    RAISE EXCEPTION 'An order voucher snapshot cannot change once the order has left DRAFT';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "OrderVoucherSnapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrderVoucherSnapshot"
FOR EACH ROW EXECUTE FUNCTION "voucher_snapshot_guard"();
