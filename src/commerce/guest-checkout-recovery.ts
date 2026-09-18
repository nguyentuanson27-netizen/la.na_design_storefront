import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const MAX_CART_ID_LENGTH = 128;

/**
 * How long a pre-submit `RESERVED` hold may keep counting before it is released (ADR 0014 §8).
 *
 * **Fifteen minutes, approved by the repository owner on 2026-09-18.** §8 assigns the window to I6a
 * and requires only that it be "long enough to cover a slow legitimate checkout"; the duration
 * itself was not a fact anywhere in the repository until that approval, and is recorded with its
 * provenance in the owner-approved facts authority.
 *
 * Deliberately the same shape as `DEFAULT_STALE_AFTER_MS` but a separate constant, because the two
 * answer different questions — how long a *hold* may count, versus how long an *order* may sit
 * mid-flight — and a future change to one must not silently move the other.
 *
 * Note for whoever revisits this: the anonymous cart lives for 30 days, far longer than this
 * window. That is not a conflict. An expired hold does not empty the basket; the buyer's next
 * submission re-reserves it, and either succeeds or gets a truthful capacity refusal. What expiry
 * ends is the *claim* on the units, not the cart.
 */
export const RESERVED_HOLD_WINDOW_MS: number | null = 15 * 60_000;

type RecoveryOptions = Readonly<{
  now?: Date;
  staleAfterMs?: number;
  cartId?: string;
  /**
   * The ADR 0014 §8 `RESERVED` expiry window. Omitted means **no hold is ever timer-released** —
   * which is today's production behaviour, because `RESERVED_HOLD_WINDOW_MS` is still pending.
   *
   * Required explicitly rather than defaulted so that no caller can acquire an expiry policy by
   * accident: releasing a buyer's held units on a clock is exactly the decision that needs an
   * owner's number behind it.
   */
  reservedHoldWindowMs?: number;
}>;

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Checkout recovery time must be valid");
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireCartId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CART_ID_LENGTH ||
    value.trim() !== value
  ) {
    throw new TypeError("Checkout recovery cart id must be a bounded non-empty string");
  }
  return value;
}

export async function recoverStrandedGuestCheckouts(
  client: PrismaClient,
  options: RecoveryOptions = {},
): Promise<{
  validatingRejected: number;
  submittingUnknown: number;
  settledConverged: number;
  reservedExpired: number;
}> {
  const now = requireNow(options.now ?? new Date());
  const staleAfterMs = requirePositiveSafeInteger(
    options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    "Checkout recovery stale threshold",
  );
  const cutoffMs = now.getTime() - staleAfterMs;
  if (!Number.isSafeInteger(cutoffMs)) {
    throw new TypeError("Checkout recovery cutoff is outside the supported range");
  }
  const cutoff = new Date(cutoffMs);
  const cartId = options.cartId === undefined ? undefined : requireCartId(options.cartId);
  const sourceCartFilter = cartId === undefined ? { not: null } : cartId;

  const reservedHoldWindowMs =
    options.reservedHoldWindowMs ?? RESERVED_HOLD_WINDOW_MS ?? null;
  let reservedCutoff: Date | null = null;
  if (reservedHoldWindowMs !== null) {
    const windowMs = requirePositiveSafeInteger(
      reservedHoldWindowMs,
      "Reserved hold expiry window",
    );
    const reservedCutoffMs = now.getTime() - windowMs;
    if (!Number.isSafeInteger(reservedCutoffMs)) {
      throw new TypeError("Reserved hold expiry cutoff is outside the supported range");
    }
    reservedCutoff = new Date(reservedCutoffMs);
  }

  // The cart scope, as a SQL fragment because the recovery writes below are guarded compare-and-sets
  // rather than Prisma `updateMany` calls. See `retireStale`.
  const cartPredicate =
    cartId === undefined
      ? Prisma.sql`"sourceCartId" IS NOT NULL`
      : Prisma.sql`"sourceCartId" = ${cartId}`;

  return client.$transaction(async (tx) => {
    /**
     * Move every stale order in `from` to `to`, and return the ids this statement actually moved.
     *
     * One guarded statement, not a read followed by a write by id. The distinction is the whole
     * safety of this function: `READ COMMITTED` lets a live submission advance an order between a
     * candidate read and a later write, so writing by id alone would retire an order that had since
     * been claimed for submission — and then release its hold while the submitter went on to call
     * Pancake. The worst case is an order that exists remotely, is `REJECTED` locally, and holds no
     * capacity at all.
     *
     * Keeping the state and staleness predicates on the `UPDATE` itself makes that unrepresentable:
     * the row is locked and re-checked at write time, so a racing transition means this statement
     * matches nothing. `RETURNING` then reports exactly the rows this recovery won, which is what
     * the ledger updates below are scoped to — a hold is only ever moved for an order whose own
     * transition succeeded.
     */
    async function retireStale(
      from: "VALIDATING" | "POS_SUBMITTING",
      to: "REJECTED" | "SYNC_UNKNOWN",
      syncErrorCode: string,
    ): Promise<string[]> {
      const moved = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "OrderMirror"
           SET "state" = ${to}::"LocalOrderState",
               "syncErrorCode" = ${syncErrorCode},
               "updatedAt" = ${now}
         WHERE "state" = ${from}::"LocalOrderState"
           AND "updatedAt" <= ${cutoff}
           AND ${cartPredicate}
        RETURNING "id"
      `);
      return moved.map((row) => row.id);
    }

    const validatingIds = await retireStale("VALIDATING", "REJECTED", "VALIDATION_INTERRUPTED");

    // A `VALIDATING` order provably never wrote. `createOrder` is reached only after the
    // `VALIDATING -> POS_SUBMITTING` compare-and-set commits, so an order this statement found
    // still in `VALIDATING` — and moved — is one for which that claim never landed.
    //
    // `SUBMITTING` is included because the write-boundary hook moves a hold immediately before the
    // mirror claim it precedes; that hold belongs to a write that never began. Terminal and
    // ambiguous rows are excluded by the guarded state filter and are left to §10.
    if (validatingIds.length > 0) {
      await tx.variantCapacityReservation.updateMany({
        where: { orderId: { in: validatingIds }, state: { in: ["RESERVED", "SUBMITTING"] } },
        data: { state: "RELEASED", releasedAt: now },
      });
    }

    const submittingIds = await retireStale(
      "POS_SUBMITTING",
      "SYNC_UNKNOWN",
      "CREATE_OUTCOME_UNKNOWN",
    );

    // ADR 0014 §9, explicitly: after a restart a `SUBMITTING` reservation is ambiguous and must
    // become `UNKNOWN`. It must NOT be released — the write may have landed, and §8 allows only
    // §10 reconciliation to resolve it. A stuck `UNKNOWN` holding capacity is the safe failure: a
    // variant that stops selling, never one that oversells.
    //
    // Only from `SUBMITTING`. `RESERVED -> UNKNOWN` is not a legal edge, because an order cannot be
    // ambiguous about a write its hold never claimed.
    if (submittingIds.length > 0) {
      await tx.variantCapacityReservation.updateMany({
        where: { orderId: { in: submittingIds }, state: "SUBMITTING" },
        data: { state: "UNKNOWN" },
      });
    }

    /**
     * Converge holds whose order outcome was persisted but whose settlement never ran.
     *
     * Submission persists the order's outcome and then settles the ledger; a crash between those
     * two leaves a decided order with an in-flight hold — `CONFIRMED` with `SUBMITTING`, and the
     * same shape for the ambiguous and refused outcomes. Nothing swept those, because the order is
     * no longer in a state recovery looked at, so a confirmed order could keep a hold counting
     * forever even though its outcome was known locally all along.
     *
     * The order predicate lives inside each statement rather than in a prior read, for the same
     * reason `retireStale` is one statement: the outcome is re-checked under the row lock at write
     * time, so a settlement racing this recovery cannot have its decision overwritten. Both are
     * guarded compare-and-sets to the same target, so whichever wins, the result is identical.
     */
    async function convergeSettled(
      orderState: "CONFIRMED" | "SYNC_UNKNOWN" | "REJECTED",
      holdStates: readonly ("RESERVED" | "SUBMITTING")[],
      data: Prisma.VariantCapacityReservationUpdateManyMutationInput,
    ): Promise<number> {
      const { count } = await tx.variantCapacityReservation.updateMany({
        where: {
          state: { in: [...holdStates] },
          order: {
            state: orderState,
            updatedAt: { lte: cutoff },
            sourceCartId: cartId === undefined ? { not: null } : cartId,
          },
        },
        data,
      });
      return count;
    }

    const settledConverged =
      // Pancake accepted. §4.1 retires the hold by the mirror rule, not this — so it is committed,
      // not released. `committedAt` is the recovery instant rather than the true commit instant,
      // which is deliberately conservative: a later timestamp demands a fresher stock observation
      // before the hold retires, so the error is a hold that counts slightly too long rather than
      // one that stops counting while Pancake's decrement is still unobserved.
      (await convergeSettled("CONFIRMED", ["SUBMITTING"], {
        state: "COMMITTED",
        committedAt: now,
      })) +
      // The ambiguous write. §8 again: never released, only made ambiguous.
      (await convergeSettled("SYNC_UNKNOWN", ["SUBMITTING"], { state: "UNKNOWN" })) +
      // A refusal is evidence nothing landed, whether it came from local validation (the hold is
      // still `RESERVED`) or from Pancake (the boundary was crossed, so it is `SUBMITTING`).
      (await convergeSettled("REJECTED", ["RESERVED", "SUBMITTING"], {
        state: "RELEASED",
        releasedAt: now,
      }));

    // ADR 0014 §8 — the only hold a clock may ever free.
    //
    // `RESERVED` means the write was never claimed, so nothing was sent and releasing is safe. The
    // guard is the state filter itself: `SUBMITTING` is a write that may be in flight and
    // `UNKNOWN` is one that may have landed, and §8 forbids a timer touching either — a timer
    // cannot distinguish slow from landed, and guessing is the oversell G2 proved Pancake will not
    // prevent. `COMMITTED` retires by the §4.1 mirror rule, not by a clock.
    //
    // Inert until an owner-approved window exists; see `RESERVED_HOLD_WINDOW_MS`.
    const reserved =
      reservedCutoff === null
        ? { count: 0 }
        : await tx.variantCapacityReservation.updateMany({
            where: {
              state: "RESERVED",
              updatedAt: { lte: reservedCutoff },
              order: { sourceCartId: sourceCartFilter },
            },
            data: { state: "RELEASED", releasedAt: now },
          });

    return {
      validatingRejected: validatingIds.length,
      submittingUnknown: submittingIds.length,
      settledConverged,
      reservedExpired: reserved.count,
    };
  });
}

export async function recoverStrandedGuestCheckoutForCart(
  client: PrismaClient,
  cartId: string,
  now: Date = new Date(),
): Promise<void> {
  await recoverStrandedGuestCheckouts(client, { cartId, now });
}
