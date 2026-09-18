-- I9 — the preorder availability cycle (ADR 0011, owner-approved 2026-09-18).
--
-- ADR 0011 accepted the availability mapping but blocked its `backorder` row: Google requires an
-- `availability_date` beside that value, and the repository had no truthful one. The owner approved
-- an automatic per-variant cycle on 2026-09-18, and this migration is its persistence.
--
-- Additive, and NO BACKFILL. A historical date cannot be inferred — nobody recorded when each
-- variant actually ran out — so every variant simply has no cycle until the website observes one.
-- Owner rule 3 covers that first observation explicitly: a variant already sold out on preorder
-- when the feature starts watching opens its cycle on the day it was first SEEN in that state.

-- CreateTable
CREATE TABLE "VariantAvailabilityCycle" (
    "variantId" TEXT NOT NULL,
    "cycleStartDate" DATE,
    "availabilityDate" DATE,
    "lastStockNonPositive" BOOLEAN NOT NULL,
    "lastPreorder" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantAvailabilityCycle_pkey" PRIMARY KEY ("variantId")
);

-- CreateIndex
CREATE INDEX "VariantAvailabilityCycle_availabilityDate_idx" ON "VariantAvailabilityCycle"("availabilityDate");

-- AddForeignKey
ALTER TABLE "VariantAvailabilityCycle" ADD CONSTRAINT "VariantAvailabilityCycle_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VariantMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Intra-row CHECK constraints.
--
-- An open cycle is defined by having BOTH dates, so a row carrying one without the other would be
-- a state no consumer knows how to read. The database can enforce that because it is intra-row.
ALTER TABLE "VariantAvailabilityCycle"
  ADD CONSTRAINT "VariantAvailabilityCycle_cycle_dates_paired"
  CHECK (("cycleStartDate" IS NULL) = ("availabilityDate" IS NULL));

-- The availability date is always after the day the cycle opened. This does not re-implement the
-- fifteen-day rule — that is application policy the owner may revise — but it does rule out a row
-- whose promise precedes its own start.
ALTER TABLE "VariantAvailabilityCycle"
  ADD CONSTRAINT "VariantAvailabilityCycle_availability_after_start"
  CHECK ("availabilityDate" IS NULL OR "availabilityDate" > "cycleStartDate");
