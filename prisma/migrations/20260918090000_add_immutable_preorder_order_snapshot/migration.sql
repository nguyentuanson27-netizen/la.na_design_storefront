-- Immutable preorder/order snapshot (I7, ADR 0014 §12).
--
-- Owner authorization: repository owner explicitly authorized a dedicated I7 migration for immutable
-- preorder/order history on 2026-09-18. Scope is ONLY this snapshot/history contract; it does not
-- authorize I8, I9, Merchant/JSON-LD, or unrelated schema changes.
--
-- Additive and NO BACKFILL. Existing orders do not receive fabricated preorder facts. Only an order
-- that reaches local CONFIRMED after this migration can create an I7 snapshot. Older orders therefore
-- remain without an I7 row rather than being rewritten from current policy/stock.
--
-- The snapshot is separate from OrderLineSnapshot because that table is intentionally mutable while
-- an order is DRAFT/repriced. I7 facts are created at the confirmation boundary and are database-
-- protected against UPDATE/DELETE so later policy or stock changes cannot rewrite history.

CREATE TYPE "OrderPreorderLineState" AS ENUM ('READY', 'PREORDER');

-- The reservation is the atomic capacity acceptance boundary. Persist the accepted READY/PREORDER
-- classification there so confirmation never re-derives historical order truth from mutable stock
-- or selling policy. Nullable is intentional for rolling compatibility and NO BACKFILL: reservations
-- created by an older application version carry no I7 authority and therefore cannot fabricate one.
ALTER TABLE "VariantCapacityReservation"
  ADD COLUMN "acceptedPreorderState" "OrderPreorderLineState";

CREATE TABLE "OrderPreorderSnapshot" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "preorderReadyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPreorderSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderPreorderLineSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "state" "OrderPreorderLineState" NOT NULL,
    "preorderReadyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPreorderLineSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPreorderSnapshot_orderId_key"
  ON "OrderPreorderSnapshot"("orderId");

CREATE INDEX "OrderPreorderSnapshot_preorderReadyAt_idx"
  ON "OrderPreorderSnapshot"("preorderReadyAt");

CREATE UNIQUE INDEX "OrderPreorderLineSnapshot_snapshotId_variantId_key"
  ON "OrderPreorderLineSnapshot"("snapshotId", "variantId");

CREATE INDEX "OrderPreorderLineSnapshot_variantId_idx"
  ON "OrderPreorderLineSnapshot"("variantId");

ALTER TABLE "OrderPreorderSnapshot"
  ADD CONSTRAINT "OrderPreorderSnapshot_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPreorderLineSnapshot"
  ADD CONSTRAINT "OrderPreorderLineSnapshot_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "OrderPreorderSnapshot"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPreorderLineSnapshot"
  ADD CONSTRAINT "OrderPreorderLineSnapshot_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "OrderPreorderLineSnapshot"
  ADD CONSTRAINT "OrderPreorderLineSnapshot_ready_state_has_no_eta"
  CHECK (
    ("state" = 'PREORDER' AND "preorderReadyAt" IS NOT NULL)
    OR
    ("state" = 'READY' AND "preorderReadyAt" IS NULL)
  );

-- Database-level immutability is intentional. Application code has no update/delete operation for
-- these rows, but the history contract must not depend on every future caller remembering that rule.
CREATE FUNCTION "raise_i7_order_preorder_snapshot_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'I7 order preorder snapshots are immutable';
END;
$$;

CREATE TRIGGER "OrderPreorderSnapshot_immutable"
BEFORE UPDATE OR DELETE ON "OrderPreorderSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "raise_i7_order_preorder_snapshot_immutable"();

CREATE TRIGGER "OrderPreorderLineSnapshot_immutable"
BEFORE UPDATE OR DELETE ON "OrderPreorderLineSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "raise_i7_order_preorder_snapshot_immutable"();
