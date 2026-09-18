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

const MAX_CYCLE_WRITE_ATTEMPTS = 8;

function sameCycleState(
  previous: AvailabilityCycleState | null,
  next: AvailabilityCycleState,
): boolean {
  return (
    previous !== null &&
    previous.cycleStartDate === next.cycleStartDate &&
    previous.availabilityDate === next.availabilityDate &&
    previous.lastStockNonPositive === next.lastStockNonPositive &&
    previous.lastPreorder === next.lastPreorder
  );
}

function persistedFields(state: AvailabilityCycleState) {
  return {
    cycleStartDate: toStoredDate(state.cycleStartDate),
    availabilityDate: toStoredDate(state.availabilityDate),
    lastStockNonPositive: state.lastStockNonPositive,
    lastPreorder: state.lastPreorder,
  };
}

async function readCycleRow(
  client: CycleClient,
  variantId: string,
): Promise<PersistedCycleRow | null> {
  return client.variantAvailabilityCycle.findUnique({
    where: { variantId },
    select: {
      cycleStartDate: true,
      availabilityDate: true,
      lastStockNonPositive: true,
      lastPreorder: true,
    },
  });
}

/**
 * Persist one observation with optimistic concurrency control.
 *
 * A plain read-then-upsert lets two observers both derive a new cycle from stale `null` state and
 * lets the later upsert overwrite the earlier date. Here the first insert/update wins only if the
 * row still matches what this observer read. A loser re-reads the authoritative row, folds its
 * observation again, and normally discovers that the cycle is already open and therefore immutable.
 */
async function persistObservation(
  client: CycleClient,
  observation: VariantAvailabilityObservation,
  observedAt: Date,
  initialRow: PersistedCycleRow | null,
): Promise<VietnamCalendarDate | null> {
  let row = initialRow;

  for (let attempt = 0; attempt < MAX_CYCLE_WRITE_ATTEMPTS; attempt += 1) {
    const previous = toCycleState(row);
    const next = observeAvailabilityCycle(previous, {
      stockNonPositive: observation.stockNonPositive,
      isPreorder: observation.isPreorder,
      observedAt,
    });

    // Every ordinary STANDARD variant still avoids a row entirely.
    if (previous === null && next.cycleStartDate === null && !next.lastPreorder) {
      return null;
    }

    // Re-observing the same state is a true no-op, including updatedAt.
    if (sameCycleState(previous, next)) {
      return next.availabilityDate;
    }

    const persisted = persistedFields(next);

    if (previous === null) {
      // PostgreSQL backs skipDuplicates with ON CONFLICT DO NOTHING. Exactly one concurrent first
      // observer creates the row; every loser re-reads instead of overwriting the winner.
      const created = await client.variantAvailabilityCycle.createMany({
        data: [{ variantId: observation.variantId, ...persisted }],
        skipDuplicates: true,
      });
      if (created.count === 1) return next.availabilityDate;
    } else {
      // Compare the complete state we read. If any concurrent observer changed it, count is zero
      // and this stale writer must re-read before deciding anything.
      const updated = await client.variantAvailabilityCycle.updateMany({
        where: {
          variantId: observation.variantId,
          cycleStartDate: toStoredDate(previous.cycleStartDate),
          availabilityDate: toStoredDate(previous.availabilityDate),
          lastStockNonPositive: previous.lastStockNonPositive,
          lastPreorder: previous.lastPreorder,
        },
        data: persisted,
      });
      if (updated.count === 1) return next.availabilityDate;
    }

    row = await readCycleRow(client, observation.variantId);
  }

  throw new Error(
    `Availability cycle for variant ${observation.variantId} changed too many times concurrently`,
  );
}

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
    const availabilityDate = await persistObservation(
      client,
      observation,
      observedAt,
      byVariantId.get(observation.variantId) ?? null,
    );
    dates.set(observation.variantId, availabilityDate);
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
