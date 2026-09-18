/**
 * I9 — persisting the preorder availability cycle (ADR 0011, owner-approved 2026-09-18).
 *
 * This is the only writer of `VariantAvailabilityCycle`. Everything about *when* a cycle opens
 * lives in `availability-cycle.ts`; this module's whole job is to apply that pure decision to rows
 * without letting concurrency turn a fixed date into a moving one.
 *
 * Two properties matter more than anything else here, because both failure modes are silent:
 *
 *   - **a re-observation of the same state must not move the date.** The catalog syncs repeatedly
 *     all day, and a date that shifted on every run would be the rolling product fact ADR 0011
 *     rejected;
 *   - **two concurrent observers must not open two cycles.** The upsert is keyed by variant, so the
 *     database decides the winner and the loser re-reads rather than inserting a second opinion.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import {
  observeAvailabilityCycle,
  type AvailabilityCycleState,
  type VietnamCalendarDate,
} from "./availability-cycle.ts";

type CycleClient = PrismaClient | Prisma.TransactionClient;

/**
 * A `DATE` column round-trips through Prisma as a `Date` at UTC midnight, so the conversion is
 * pure formatting rather than a timezone shift. Going through one pair of helpers keeps the
 * Vietnamese calendar day the only notion of a date that ever reaches the domain.
 */
function toCalendarDate(value: Date | null): VietnamCalendarDate | null {
  if (value === null || Number.isNaN(value.getTime())) return null;
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toStoredDate(value: VietnamCalendarDate | null): Date | null {
  if (value === null) return null;
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;
  const stored = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(stored.getTime()) ? null : stored;
}

type PersistedCycleRow = Readonly<{
  cycleStartDate: Date | null;
  availabilityDate: Date | null;
  lastStockNonPositive: boolean;
  lastPreorder: boolean;
}>;

function toCycleState(row: PersistedCycleRow | null): AvailabilityCycleState | null {
  if (row === null) return null;
  return {
    cycleStartDate: toCalendarDate(row.cycleStartDate),
    availabilityDate: toCalendarDate(row.availabilityDate),
    lastStockNonPositive: row.lastStockNonPositive,
    lastPreorder: row.lastPreorder,
  };
}

export type VariantAvailabilityObservation = Readonly<{
  variantId: string;
  /** Ready stock is at or below zero, from mirrored catalog stock. */
  stockNonPositive: boolean;
  /** The variant's resolved selling mode is `PREORDER`. */
  isPreorder: boolean;
}>;

/**
 * Apply one batch of trusted observations, returning each variant's availability date.
 *
 * Batched rather than per-variant because its callers are a catalog sync over a whole shop and an
 * admin policy save over a whole product: a per-variant round trip would turn one observation into
 * N queries against the same rows the sync is already holding.
 *
 * Runs inside the caller's transaction when given one, so a sync that rolls back does not leave
 * cycles behind claiming a stock state that was never committed.
 */
export async function observeVariantAvailabilityCycles(
  client: CycleClient,
  observations: readonly VariantAvailabilityObservation[],
  observedAt: Date,
): Promise<Map<string, VietnamCalendarDate | null>> {
  const dates = new Map<string, VietnamCalendarDate | null>();
  if (observations.length === 0) return dates;

  const variantIds = observations.map(({ variantId }) => variantId);
  const existing = await client.variantAvailabilityCycle.findMany({
    where: { variantId: { in: variantIds } },
    select: {
      variantId: true,
      cycleStartDate: true,
      availabilityDate: true,
      lastStockNonPositive: true,
      lastPreorder: true,
    },
  });
  const byVariantId = new Map(existing.map((row) => [row.variantId, row]));

  for (const observation of observations) {
    const previous = toCycleState(byVariantId.get(observation.variantId) ?? null);
    const next = observeAvailabilityCycle(previous, {
      stockNonPositive: observation.stockNonPositive,
      isPreorder: observation.isPreorder,
      observedAt,
    });

    // Nothing to record and nothing recorded before: skip the write entirely rather than store a
    // row saying "this variant has never been on preorder", which is every variant in the catalog.
    if (previous === null && next.cycleStartDate === null && !next.lastPreorder) {
      dates.set(observation.variantId, null);
      continue;
    }

    const persisted = {
      cycleStartDate: toStoredDate(next.cycleStartDate),
      availabilityDate: toStoredDate(next.availabilityDate),
      lastStockNonPositive: next.lastStockNonPositive,
      lastPreorder: next.lastPreorder,
    };

    await client.variantAvailabilityCycle.upsert({
      where: { variantId: observation.variantId },
      create: { variantId: observation.variantId, ...persisted },
      update: persisted,
    });
    dates.set(observation.variantId, next.availabilityDate);
  }

  return dates;
}

/**
 * Read the persisted dates for a set of variants, without observing anything.
 *
 * The read path is deliberately separate and side-effect free. A page render or a feed run must
 * never be able to open, move or close a cycle — only a trusted catalog or admin observation may,
 * which is what keeps the date independent of who happens to be looking.
 */
export async function readVariantAvailabilityDates(
  client: CycleClient,
  variantIds: readonly string[],
): Promise<Map<string, VietnamCalendarDate | null>> {
  const dates = new Map<string, VietnamCalendarDate | null>();
  if (variantIds.length === 0) return dates;

  const rows = await client.variantAvailabilityCycle.findMany({
    where: { variantId: { in: [...variantIds] } },
    select: { variantId: true, availabilityDate: true },
  });
  for (const row of rows) dates.set(row.variantId, toCalendarDate(row.availabilityDate));
  return dates;
}
