-- Atomic capacity persistence (ADR 0014 §13).
--
-- Owner-authorized 2026-09-17, recorded with provenance in
-- `docs/specs/la-na-design-owner-approved-facts-and-decisions.md` › Settled decisions. This is a
-- SEPARATE authorization from the 2026-09-16 five-model merchandising approval, which explicitly
-- did not cover these two tables.
--
-- Additive, and there is **NO BACKFILL**. Crucially, that is safe because of a resolver, not because
-- of the column defaults below: a default only fires when a row is inserted, and a product with no
-- `ProductSellingPolicy` row never has one applied. `resolveSellingPolicy()` in
-- `src/commerce/capacity-policy.ts` is the single producer of the missing-row answer — STANDARD at
-- −20, which is exactly today's behaviour — and every consumer goes through it.
--
-- What this migration does NOT do: it does not enforce the capacity arithmetic. No constraint can
-- express "mirrored stock minus active holds stays above a per-product limit" — that spans tables
-- and depends on the selling mode. ADR 0014 §6.2 enforces it at the transaction boundary, by locking
-- the always-present `VariantMirror` row before reading the ledger. The CHECKs below are intra-row
-- only, which is the narrow class the database genuinely can enforce.

-- CreateEnum
CREATE TYPE "SellingMode" AS ENUM ('STANDARD', 'OVERSELL', 'PREORDER');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('RESERVED', 'SUBMITTING', 'COMMITTED', 'RELEASED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ProductSellingPolicy" (
    "productId" TEXT NOT NULL,
    "sellingMode" "SellingMode" NOT NULL DEFAULT 'STANDARD',
    "negativeStockLimit" INTEGER NOT NULL DEFAULT -20,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSellingPolicy_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "VariantCapacityReservation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'RESERVED',
    "committedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantCapacityReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VariantCapacityReservation_variantId_state_idx" ON "VariantCapacityReservation"("variantId", "state");

-- CreateIndex
CREATE INDEX "VariantCapacityReservation_state_updatedAt_idx" ON "VariantCapacityReservation"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VariantCapacityReservation_orderId_variantId_key" ON "VariantCapacityReservation"("orderId", "variantId");

-- AddForeignKey
ALTER TABLE "ProductSellingPolicy" ADD CONSTRAINT "ProductSellingPolicy_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductMirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCapacityReservation" ADD CONSTRAINT "VariantCapacityReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderMirror"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCapacityReservation" ADD CONSTRAINT "VariantCapacityReservation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VariantMirror"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Intra-row CHECK constraints (ADR 0014 §13).
--
-- The implications are **biconditional**, not one-way. A one-way form still admits rows that are
-- plainly nonsense: `RESERVED` carrying a `committedAt`, or a row that claims both outcomes at once.
-- The reverse direction also stops a non-terminal row keeping a stale terminal timestamp that a
-- later reader could mistake for evidence of a commit that never happened.
--
-- These do NOT make the state machine safe. They are per-row predicates and say nothing about the
-- transition between two versions of a row, so `COMMITTED -> RESERVED` remains representable in SQL.
-- ADR 0014 §6.4 requires every transition to be a guarded compare-and-set asserting exactly one
-- affected row.

ALTER TABLE "VariantCapacityReservation"
  ADD CONSTRAINT "VariantCapacityReservation_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "VariantCapacityReservation"
  ADD CONSTRAINT "VariantCapacityReservation_committed_iff_committed_at"
  CHECK (("state" = 'COMMITTED') = ("committedAt" IS NOT NULL));

ALTER TABLE "VariantCapacityReservation"
  ADD CONSTRAINT "VariantCapacityReservation_released_iff_released_at"
  CHECK (("state" = 'RELEASED') = ("releasedAt" IS NOT NULL));

ALTER TABLE "VariantCapacityReservation"
  ADD CONSTRAINT "VariantCapacityReservation_not_both_outcomes"
  CHECK (NOT ("committedAt" IS NOT NULL AND "releasedAt" IS NOT NULL));

-- The limit is an oversell/preorder allowance, so a positive value is meaningless. `STANDARD` is
-- floored at 0 regardless of it (master spec §28), which `capacityFloorForMode()` enforces.
ALTER TABLE "ProductSellingPolicy"
  ADD CONSTRAINT "ProductSellingPolicy_negative_stock_limit_not_positive"
  CHECK ("negativeStockLimit" <= 0);
