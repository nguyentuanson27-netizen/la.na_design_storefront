-- Composite-aware capacity resources.
--
-- Owner-authorized 2026-09-25 as part of PR #77: FULL SET availability and checkout enforcement
-- must use the stock of the component variants the set actually consumes. Parent WarehouseStock
-- remains an unmodified Pancake mirror.
--
-- The existing VariantCapacityReservation stays line-oriented (one row per purchased variant), which
-- preserves order idempotency and READY/PREORDER history. This additive child table snapshots the
-- stock resources consumed by that line so a later composite graph sync cannot move a live hold.

CREATE TABLE "CapacityReservationResource" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "CapacityReservationResource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CapacityReservationResource_reservation_variant_key"
  ON "CapacityReservationResource"("reservationId", "variantId");

CREATE INDEX "CapacityReservationResource_variant_idx"
  ON "CapacityReservationResource"("variantId");

ALTER TABLE "CapacityReservationResource"
  ADD CONSTRAINT "CapacityReservationResource_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "CapacityReservationResource"
  ADD CONSTRAINT "CapacityReservationResource_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "VariantCapacityReservation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CapacityReservationResource"
  ADD CONSTRAINT "CapacityReservationResource_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "VariantMirror"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill every reservation that predates this migration from the best durable graph available at
-- migration time. The production deploy quiesces the old app before running this migration, so no
-- legacy writer can create a reservation after this snapshot and before the new app starts writing
-- resource rows. Standalone lines consume themselves; composite lines consume each component. Once
-- written, these rows do not follow later CompositeComponentMirror changes.
INSERT INTO "CapacityReservationResource" ("id", "reservationId", "variantId", "quantity")
SELECT
  r."id" || ':component:' || c."componentVariantId",
  r."id",
  c."componentVariantId",
  (r."quantity"::bigint * c."quantity"::bigint)::integer
FROM "VariantCapacityReservation" r
JOIN "CompositeComponentMirror" c
  ON c."parentVariantId" = r."variantId";

INSERT INTO "CapacityReservationResource" ("id", "reservationId", "variantId", "quantity")
SELECT
  r."id" || ':self:' || r."variantId",
  r."id",
  r."variantId",
  r."quantity"
FROM "VariantCapacityReservation" r
WHERE NOT EXISTS (
  SELECT 1
  FROM "CompositeComponentMirror" c
  WHERE c."parentVariantId" = r."variantId"
);
