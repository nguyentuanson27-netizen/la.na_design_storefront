/**
 * The durable mirror handoff (ADR 0014 §4.1).
 *
 * A `COMMITTED` reservation's units are owned by the local ledger until Pancake's decrement is
 * observably in mirrored stock, and by the mirror afterwards. That ownership change used to be
 * re-derived on every read by comparing the variant's stock-observation start with `committedAt`.
 * It is now an event: this module decides it once, inside the catalog sync transaction that wrote
 * the observation, and records it on each `CapacityReservationResource` as
 *
 * - `mirroredAt` — when the handoff was recorded, and
 * - `mirrorObservationStartedAt` — the observation that proved it,
 *
 * so every later read asks one durable fact (`resourceHoldsCapacity()`), and an operator can see
 * exactly when and on what evidence each unit left the ledger.
 *
 * **Why inside the sync transaction, and only for the variants that sync wrote.** The decision and
 * the stock it justifies must become visible together. The sync upserts every `VariantMirror` row it
 * observes, which row-locks exactly the rows `reserveOrderCapacity()` locks `FOR UPDATE` before
 * reading stock and holds. A reservation therefore sees either the old stock with the resource still
 * holding, or the new stock with the resource handed off — never new holds against old stock, which
 * would count the units nowhere.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { reservationHoldsCapacity } from "./capacity-policy.ts";
import { CATALOG_SYNC_TRANSACTION_TIMEOUT_MS } from "./catalog-sync-lock.ts";

const HANDOFF_BATCH_SIZE = 1_000;

/**
 * The instant the mirror's stock observation for a variant **began**.
 *
 * The **minimum** across the variant's warehouse rows, not the maximum, and that choice is load
 * bearing. Mirrored stock is the sum over warehouses, so it includes a Pancake decrement only if
 * *every* contributing row was observed after the commit. Taking the newest row would retire a
 * `COMMITTED` hold while some other warehouse's number still predates the order — the units would
 * then be counted by neither side, which is the oversell this ledger exists to prevent.
 *
 * `null` when the variant has no stock rows at all: no observation means no evidence, and
 * `reservationHoldsCapacity()` keeps holding on missing evidence.
 */
export function earliestObservationStart(stocks: readonly { syncedAt: Date }[]): Date | null {
  let earliest: Date | null = null;
  for (const stock of stocks) {
    if (earliest === null || stock.syncedAt.getTime() < earliest.getTime()) earliest = stock.syncedAt;
  }
  return earliest;
}

type HandoffClient = Pick<Prisma.TransactionClient, "capacityReservationResource" | "warehouseStock">;

/**
 * Hands every `COMMITTED` resource on `variantIds` whose stock observation began strictly after the
 * commit over to the mirror, and returns how many were handed off.
 *
 * Idempotent: only resources with no `mirroredAt` are considered, and each update is guarded on it
 * still being `null`, so re-running a sync — or two overlapping calls — can never hand off twice or
 * rewrite the recorded evidence. `COMMITTED` is terminal, so a handed-off resource never holds again.
 *
 * The retirement test is `reservationHoldsCapacity()` itself: ties, a missing commit time and a
 * variant with no observation all keep holding. An observation later than `handedOffAt` is not
 * accepted as evidence either — a proof cannot postdate the event it justifies.
 */
export async function handOffMirroredCapacity(
  tx: HandoffClient,
  { variantIds, handedOffAt }: Readonly<{ variantIds: readonly string[]; handedOffAt: Date }>,
): Promise<number> {
  const ids = [...new Set(variantIds)];
  let handedOff = 0;

  for (let start = 0; start < ids.length; start += HANDOFF_BATCH_SIZE) {
    const batch = ids.slice(start, start + HANDOFF_BATCH_SIZE);
    const candidates = await tx.capacityReservationResource.findMany({
      where: { variantId: { in: batch }, mirroredAt: null, reservation: { state: "COMMITTED" } },
      select: {
        id: true,
        variantId: true,
        reservation: { select: { state: true, committedAt: true } },
      },
    });
    if (candidates.length === 0) continue;

    const stocks = await tx.warehouseStock.findMany({
      where: { variantId: { in: [...new Set(candidates.map(({ variantId }) => variantId))] } },
      select: { variantId: true, syncedAt: true },
    });
    const stocksByVariantId = new Map<string, { syncedAt: Date }[]>();
    for (const stock of stocks) {
      const list = stocksByVariantId.get(stock.variantId) ?? [];
      list.push(stock);
      stocksByVariantId.set(stock.variantId, list);
    }

    const readyByVariantId = new Map<string, { observedFrom: Date; ids: string[] }>();
    for (const resource of candidates) {
      const observedFrom = earliestObservationStart(stocksByVariantId.get(resource.variantId) ?? []);
      if (observedFrom === null || observedFrom.getTime() > handedOffAt.getTime()) continue;
      const holds = reservationHoldsCapacity({
        state: resource.reservation.state,
        committedAt: resource.reservation.committedAt,
        stockObservationStartedAt: observedFrom,
      });
      if (holds) continue;
      const ready = readyByVariantId.get(resource.variantId) ?? { observedFrom, ids: [] };
      ready.ids.push(resource.id);
      readyByVariantId.set(resource.variantId, ready);
    }

    for (const { observedFrom, ids: resourceIds } of readyByVariantId.values()) {
      const moved = await tx.capacityReservationResource.updateMany({
        where: { id: { in: resourceIds }, mirroredAt: null },
        data: { mirroredAt: handedOffAt, mirrorObservationStartedAt: observedFrom },
      });
      handedOff += moved.count;
    }
  }

  return handedOff;
}

/**
 * Records every handoff the current mirror already proves, outside a catalog sync.
 *
 * The sync is where new evidence arrives, but it is not the only way `COMMITTED` resources can be
 * left without `mirroredAt` while the mirror already includes their decrement. The supported
 * rollback keeps the migrated schema, and a release from before the durable handoff retires holds by
 * its per-read rule without recording them; a roll-forward does not re-run the migration's backfill,
 * so the new code would count those units again until its first sync. `deploy.sh` runs this after
 * migrating and before any new writer or Caddy starts, so a release never serves with an unrecorded
 * handoff.
 *
 * The decision is the same `handOffMirroredCapacity()` makes, and it is valid at any time, not only
 * mid-sync: it compares the stored observation with the commit, and neither moves without a sync.
 * The variant rows are locked in id order first — the order `reserveOrderCapacity()` locks them in —
 * so a run that overlaps live traffic still cannot hand off against stock a checkout already read.
 * Idempotent: a second run finds nothing to do.
 */
export async function reconcileMirrorHandoffs(
  client: PrismaClient,
  { handedOffAt = new Date() }: Readonly<{ handedOffAt?: Date }> = {},
): Promise<number> {
  return client.$transaction(
    async (tx) => {
      const pending = await tx.capacityReservationResource.findMany({
        where: { mirroredAt: null, reservation: { state: "COMMITTED" } },
        distinct: ["variantId"],
        select: { variantId: true },
      });
      const variantIds = pending.map(({ variantId }) => variantId).sort();
      if (variantIds.length === 0) return 0;

      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "VariantMirror"
        WHERE "id" IN (${Prisma.join(variantIds)})
        ORDER BY "id"
        FOR UPDATE
      `);
      return handOffMirroredCapacity(tx, { variantIds, handedOffAt });
    },
    { timeout: CATALOG_SYNC_TRANSACTION_TIMEOUT_MS },
  );
}
