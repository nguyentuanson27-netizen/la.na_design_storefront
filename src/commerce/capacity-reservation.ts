/**
 * I6a — the atomic capacity primitive (ADR 0014 §6.2, §6.4, §7).
 *
 * This is the module I1 deliberately did not ship. Reading a policy is safe outside a transaction;
 * *holding* capacity is not, and a naive write would have looked like the gate while enforcing
 * nothing.
 *
 * The one thing to understand before changing anything here is **why the lock target is
 * `VariantMirror` and not the ledger** (§6.1). `SELECT … FOR UPDATE` locks the rows it returns. A
 * variant nobody has reserved yet has no ledger rows, so locking the ledger returns zero rows and
 * locks nothing: two first-ever checkouts both succeed vacuously, both read
 * `activeReservedQuantity = 0`, and both insert. The lock is useless in exactly the state every
 * variant is in before its first sale. `VariantMirror` rows always exist for anything reservable —
 * `VariantCapacityReservation.variantId` references them with `onDelete: Restrict` — so locking the
 * variant row serializes the second caller even when the ledger is empty.
 *
 * `READ COMMITTED` is deliberate and sufficient. Correctness comes from the explicit lock, not the
 * isolation level, and at this level the blocked transaction's post-lock read takes a fresh snapshot
 * and therefore observes the winner's inserted holds. A higher level would take its snapshot before
 * blocking and abort with a serialization error instead — safe, but it would need a retry loop to be
 * usable, which is a cost with no benefit here.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import {
  canTransition,
  evaluateMultiLineReservation,
  reservationHoldsCapacity,
  resolveSellingPolicy,
  type CapacityDecisionReason,
  type ReservationState,
  type VariantCapacityInput,
} from "./capacity-policy.ts";

export type ReservationLineRequest = Readonly<{ variantId: string; quantity: number }>;

export type HeldReservation = Readonly<{
  id: string;
  variantId: string;
  quantity: number;
  state: ReservationState;
}>;

export type ReservationRefusalReason =
  | "empty-basket"
  | "invalid-quantity"
  | "variant-missing"
  /**
   * This order already has ledger rows, but they are not the basket being asked for: a different
   * quantity, a different set of variants, or a row that no longer holds capacity. Fail-closed on
   * purpose — see `reserveOrderCapacity`.
   */
  | "reservation-conflict"
  | CapacityDecisionReason;

export type ReservationOutcome =
  | Readonly<{
      ok: true;
      reservations: readonly HeldReservation[];
      /** True when this order already held these lines and nothing new was inserted (§3). */
      alreadyHeld: boolean;
    }>
  | Readonly<{
      ok: false;
      reason: ReservationRefusalReason;
      /** The variant whose line was refused, when one line is responsible. */
      refusedVariantId: string | null;
    }>;

/**
 * ADR §7's precondition, applied rather than assumed.
 *
 * Two lines for the same variant would each see the other excluded from `activeReservedQuantity` and
 * could jointly overshoot. Merging is also what keeps the `(orderId, variantId)` unique key from
 * rejecting a legitimate basket, so it happens here and not in a caller that might forget.
 */
export function mergeReservationLines(
  lines: readonly ReservationLineRequest[],
): ReservationLineRequest[] {
  const byVariantId = new Map<string, number>();
  for (const line of lines) {
    byVariantId.set(line.variantId, (byVariantId.get(line.variantId) ?? 0) + line.quantity);
  }
  return [...byVariantId].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * The instant the mirror's stock observation for this variant **began** (§4.1, §4.2).
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
function earliestObservationStart(stocks: readonly { syncedAt: Date }[]): Date | null {
  let earliest: Date | null = null;
  for (const stock of stocks) {
    if (earliest === null || stock.syncedAt.getTime() < earliest.getTime()) earliest = stock.syncedAt;
  }
  return earliest;
}

export function createCapacityReservationRepository(client: PrismaClient) {
  /**
   * Reserve capacity for one order, all lines or none (§31, §7).
   *
   * Idempotent on the order (§3): a retry that reuses the same `orderId` finds its own rows and
   * returns them rather than inserting a second set. That is why this order's own holds are excluded
   * from `activeReservedQuantity` below — counting them would make a retry refuse its own basket.
   */
  async function reserveOrderCapacity({
    orderId,
    lines,
  }: {
    orderId: string;
    lines: readonly ReservationLineRequest[];
  }): Promise<ReservationOutcome> {
    const merged = mergeReservationLines(lines);
    // An empty basket is not a successful reservation (§7).
    if (merged.length === 0) return { ok: false, reason: "empty-basket", refusedVariantId: null };
    for (const line of merged) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
        return { ok: false, reason: "invalid-quantity", refusedVariantId: line.variantId };
      }
    }

    const variantIds = merged.map((line) => line.variantId).sort();

    return client.$transaction(
      async (tx) => {
        // Step 2 — lock an identity that always exists. Ordered by id so every caller acquires the
        // same variants in the same sequence and no deadlock cycle can form.
        const locked = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM "VariantMirror" WHERE id IN (${Prisma.join(variantIds)}) ORDER BY id FOR UPDATE`,
        );

        // Step 3 — a missing variant is a fail-closed refusal, never a silently skipped lock.
        if (locked.length !== variantIds.length) {
          const found = new Set(locked.map((row) => row.id));
          const missing = variantIds.find((id) => !found.has(id)) ?? null;
          return { ok: false, reason: "variant-missing", refusedVariantId: missing } as const;
        }

        // Step 4 — read the facts *after* the lock is held. Recomputed here, never carried in from a
        // read taken before the transaction.
        const variants = await tx.variantMirror.findMany({
          where: { id: { in: variantIds } },
          select: {
            id: true,
            product: { select: { sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } } } },
            warehouseStocks: { select: { quantity: true, syncedAt: true } },
            compositeComponents: { select: { parentVariantId: true }, take: 1 },
          },
        });
        const observationByVariantId = new Map(
          variants.map((variant) => [variant.id, earliestObservationStart(variant.warehouseStocks)]),
        );

        // §3 idempotency, and it has to be **exact**, over the **whole order**.
        //
        // Two earlier versions got this wrong in opposite directions, and both were capacity bugs
        // rather than cosmetic ones:
        //
        // 1. Comparing only the row COUNT let the same order reserve A×1, retry as A×2, and be told
        //    it succeeded while the ledger held one unit — and a `RELEASED` row, which holds nothing
        //    at all, satisfied the count just as well. A caller treating `ok: true` as the capacity
        //    gate would have shipped past the owner's hard limit on a hold that did not exist.
        // 2. Scoping this query to the REQUESTED variants let an order holding A + B retry as A
        //    alone and be told it succeeded, because the query never returned B. B kept holding
        //    capacity for a basket that no longer contained it, and later legitimate sales would be
        //    refused against a hold nobody was going to use.
        //
        // Hence `where: { orderId }` with no variant filter: the comparison is the order's ENTIRE
        // reservation set against the merged basket. A retry succeeds only when they are the same
        // variants at the same quantities with every row still capacity-holding. Anything else is a
        // conflict the caller must resolve — a changed basket under a reused order id is a new
        // decision, not a repeat of an old one, and `(orderId, variantId)` leaves no room to hold
        // both.
        //
        // Rows outside `variantIds` are therefore read without holding their variant's lock. That is
        // sound because they can only produce a REFUSAL: the success branch requires the held set to
        // equal the requested set, so every row it accepts is one this transaction has locked.
        const own = await tx.variantCapacityReservation.findMany({
          where: { orderId },
          select: { id: true, variantId: true, quantity: true, state: true, committedAt: true },
        });
        if (own.length > 0) {
          const requestedByVariantId = new Map(merged.map((line) => [line.variantId, line.quantity]));
          // A row for a variant outside the basket has no requested quantity, so `undefined`
          // compares unequal and it lands here as a mismatch — which is exactly the A + B -> A case.
          const mismatch = own.find(
            (row) =>
              row.quantity !== requestedByVariantId.get(row.variantId) ||
              !reservationHoldsCapacity({
                state: row.state,
                committedAt: row.committedAt,
                stockObservationStartedAt: observationByVariantId.get(row.variantId) ?? null,
              }),
          );
          if (own.length !== variantIds.length || mismatch !== undefined) {
            return {
              ok: false,
              reason: "reservation-conflict",
              refusedVariantId: mismatch?.variantId ?? null,
            } as const;
          }
          return {
            ok: true,
            alreadyHeld: true,
            reservations: own.map(({ id, variantId, quantity, state }) =>
              Object.freeze({ id, variantId, quantity, state }),
            ),
          } as const;
        }

        const heldByVariantId = new Map<string, number>();
        const reservations = await tx.variantCapacityReservation.findMany({
          // This order's own rows are excluded: they are the retry's own hold, not a competitor's.
          // By this point it has none — the branch above answered every case where it did — but the
          // filter stays, because the reason it is right is the idempotency rule, not the ordering
          // of statements in this function.
          where: { variantId: { in: variantIds }, orderId: { not: orderId } },
          select: { variantId: true, quantity: true, state: true, committedAt: true },
        });
        for (const row of reservations) {
          const holds = reservationHoldsCapacity({
            state: row.state,
            committedAt: row.committedAt,
            stockObservationStartedAt: observationByVariantId.get(row.variantId) ?? null,
          });
          if (!holds) continue;
          heldByVariantId.set(row.variantId, (heldByVariantId.get(row.variantId) ?? 0) + row.quantity);
        }

        const inputByVariantId = new Map<string, VariantCapacityInput>(
          variants.map((variant) => {
            const policy = resolveSellingPolicy(variant.product.sellingPolicy);
            const mirroredStock = variant.warehouseStocks.reduce((sum, row) => sum + row.quantity, 0);
            return [
              variant.id,
              {
                mirroredStock,
                activeReservedQuantity: heldByVariantId.get(variant.id) ?? 0,
                sellingMode: policy.sellingMode,
                negativeStockLimit: policy.negativeStockLimit,
                isComposite: variant.compositeComponents.length > 0,
              },
            ];
          }),
        );

        // Step 5 — every line is evaluated, so one call explains the whole basket, and the order still
        // fails as a unit.
        const decision = evaluateMultiLineReservation(
          merged.map((line) => ({
            line,
            quantity: line.quantity,
            input: inputByVariantId.get(line.variantId)!,
          })),
        );
        if (!decision.allowed) {
          const refused = decision.decisions.find((entry) => !entry.decision.allowed);
          return {
            ok: false,
            reason: refused?.decision.reason ?? "invalid-quantity",
            refusedVariantId: decision.refusedLine?.variantId ?? null,
          } as const;
        }

        // Step 6 — all rows or none. The transaction is the atomicity; `createMany` is not relied on
        // for it beyond being a single statement.
        // No `skipDuplicates`: the branch above answered every case where this order already had a
        // row, so a duplicate here is an impossible state, and swallowing it would hide exactly the
        // quantity mismatch that branch exists to refuse.
        await tx.variantCapacityReservation.createMany({
          data: merged.map((line) => {
            const input = inputByVariantId.get(line.variantId)!;
            const readyStock = input.mirroredStock - input.activeReservedQuantity;
            return {
              orderId,
              variantId: line.variantId,
              quantity: line.quantity,
              // This is historical order authority, not a later sellability re-check. If any part
              // of an accepted PREORDER line exceeds ready stock, the line waits for preparation.
              acceptedPreorderState:
                input.sellingMode === "PREORDER" && readyStock < line.quantity
                  ? ("PREORDER" as const)
                  : ("READY" as const),
            };
          }),
        });
        const inserted = await tx.variantCapacityReservation.findMany({
          where: { orderId, variantId: { in: variantIds } },
          select: { id: true, variantId: true, quantity: true, state: true },
        });

        return {
          ok: true,
          alreadyHeld: false,
          reservations: inserted.map((row) => Object.freeze({ ...row })),
        } as const;
      },
      // Concurrent callers queue on the step-2 lock by design, so the wait budget has to allow for
      // a real queue rather than Prisma's 5s default, which would surface contention as a timeout.
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  /**
   * §6.4 — move one reservation, as a compare-and-set.
   *
   * The enum constrains a column's value and the §13 CHECKs are all intra-row, so nothing in SQL
   * stops an `UPDATE` moving a row `COMMITTED → RESERVED`. The state machine is only real if every
   * write carries its expected current state and asserts it moved exactly one row.
   *
   * Two different failures, deliberately reported differently, because conflating them is how a
   * retry loop spins forever:
   *
   * - **An illegal transition throws.** `COMMITTED → RESERVED` is not a race anybody can lose; it is
   *   a caller bug that no amount of re-reading will turn into a success. An earlier version of this
   *   function left legality to callers and guarded only staleness — which meant a caller passing
   *   `from: "COMMITTED"` resurrected a terminal row and the guard applied it happily. That is the
   *   same "reads as enforcement, does not constrain" shape §6.1 warns about, one layer up.
   * - **A lost compare-and-set returns `false`.** Another worker moved the row first: a real
   *   conflict, to re-read and decide again, never a no-op to ignore.
   *
   * So terminal really is terminal here: `RESERVATION_TRANSITIONS` gives terminal states no
   * outgoing edges, and every write goes through this function.
   */
  async function transitionReservation({
    id,
    from,
    to,
    at = new Date(),
  }: {
    id: string;
    from: ReservationState;
    to: ReservationState;
    at?: Date;
  }): Promise<boolean> {
    if (!canTransition(from, to)) {
      throw new Error(`Illegal reservation transition ${from} -> ${to}`);
    }

    // The §13 CHECKs are biconditional, so a terminal state must carry its timestamp and a
    // non-terminal one must not. Building the payload here keeps a caller from writing a row the
    // database will reject — or, worse, a stale `committedAt` surviving into a non-terminal row.
    const timestamps =
      to === "COMMITTED"
        ? { committedAt: at, releasedAt: null }
        : to === "RELEASED"
          ? { committedAt: null, releasedAt: at }
          : { committedAt: null, releasedAt: null };

    const moved = await client.variantCapacityReservation.updateMany({
      where: { id, state: from },
      data: { state: to, ...timestamps },
    });
    return moved.count === 1;
  }

  return { reserveOrderCapacity, transitionReservation };
}
