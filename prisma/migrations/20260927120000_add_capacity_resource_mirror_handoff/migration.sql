-- Durable capacity handoff from a local reservation resource to the Pancake mirror (ADR 0014 §4.1).
--
-- Until now a COMMITTED resource stopped holding capacity when every read re-derived that the
-- variant's stock observation began after the commit. The handoff becomes a durable, auditable
-- event instead: a catalog sync stamps `mirroredAt` (when it handed the units to the mirror) and
-- `mirrorObservationStartedAt` (the observation that proved it) on each resource, once. Readers ask
-- only whether a COMMITTED resource has been handed off.

ALTER TABLE "CapacityReservationResource"
  ADD COLUMN "mirroredAt" TIMESTAMP(3),
  ADD COLUMN "mirrorObservationStartedAt" TIMESTAMP(3);

-- Both are written together or not at all, and the proof must predate the handoff it justifies.
ALTER TABLE "CapacityReservationResource"
  ADD CONSTRAINT "CapacityReservationResource_mirror_handoff_complete"
  CHECK (("mirroredAt" IS NULL) = ("mirrorObservationStartedAt" IS NULL));

ALTER TABLE "CapacityReservationResource"
  ADD CONSTRAINT "CapacityReservationResource_mirror_handoff_ordered"
  CHECK ("mirroredAt" IS NULL OR "mirrorObservationStartedAt" <= "mirroredAt");

CREATE INDEX "CapacityReservationResource_variant_mirrored_idx"
  ON "CapacityReservationResource"("variantId", "mirroredAt");

-- Backfill the handoffs the previous per-read rule already treated as done, so no retired hold
-- starts counting again after deploy. Exactly `reservationHoldsCapacity()`'s retirement test: a
-- COMMITTED line whose variant's earliest warehouse observation began strictly after the commit. A
-- variant with no stock rows has no observation and is not handed off. The deploy quiesces the app
-- and the catalog sync before this runs, so no writer moves either side meanwhile.
UPDATE "CapacityReservationResource" AS resource
SET "mirroredAt" = CURRENT_TIMESTAMP,
    "mirrorObservationStartedAt" = observation."observedFrom"
FROM "VariantCapacityReservation" AS reservation,
     (
       SELECT "variantId", MIN("syncedAt") AS "observedFrom"
       FROM "WarehouseStock"
       GROUP BY "variantId"
     ) AS observation
WHERE reservation."id" = resource."reservationId"
  AND observation."variantId" = resource."variantId"
  AND reservation."state" = 'COMMITTED'
  AND reservation."committedAt" IS NOT NULL
  AND observation."observedFrom" > reservation."committedAt"
  AND observation."observedFrom" <= CURRENT_TIMESTAMP;
