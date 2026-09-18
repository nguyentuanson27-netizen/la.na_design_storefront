import type { PrismaClient } from "../generated/prisma/client.ts";

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const MAX_CART_ID_LENGTH = 128;

/**
 * How long a pre-submit `RESERVED` hold may keep counting before it is released (ADR 0014 §8).
 *
 * **Deliberately `null`: the duration is not an owner-approved fact yet.** §8 says only that the
 * window "belongs to I6a" and "must be long enough to cover a slow legitimate checkout" — it names
 * no number, and neither does the owner-approved facts authority. A number chosen here would be an
 * invented one governing when real buyers lose their held units: too short strips a slow checkout
 * mid-purchase, too long recreates the false hold this path exists to prevent. The facts authority
 * is explicit that a pending value is left unset rather than given a placeholder.
 *
 * The release path below is complete and tested; it is inert while this is `null`, and setting it
 * to an approved number is the only change needed to make expiry live.
 */
export const RESERVED_HOLD_WINDOW_MS: number | null = null;

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

  return client.$transaction(async (tx) => {
    // I6b — the capacity ledger is authoritative checkout state, so recovery has to move it with
    // the order. The ids are read first because the reservation rows are reached through them, and
    // once an order's state has changed the query that selected it no longer matches.
    const staleValidating = await tx.orderMirror.findMany({
      where: { sourceCartId: sourceCartFilter, state: "VALIDATING", updatedAt: { lte: cutoff } },
      select: { id: true },
    });
    const staleSubmitting = await tx.orderMirror.findMany({
      where: { sourceCartId: sourceCartFilter, state: "POS_SUBMITTING", updatedAt: { lte: cutoff } },
      select: { id: true },
    });
    const validatingIds = staleValidating.map(({ id }) => id);
    const submittingIds = staleSubmitting.map(({ id }) => id);

    const validating = await tx.orderMirror.updateMany({
      where: { id: { in: validatingIds } },
      data: {
        state: "REJECTED",
        syncErrorCode: "VALIDATION_INTERRUPTED",
      },
    });

    // A `VALIDATING` order provably never wrote. `createOrder` is reached only after the
    // `VALIDATING -> POS_SUBMITTING` compare-and-set commits, so an order still in `VALIDATING` is
    // one for which that claim never landed — whatever the crash interrupted, Pancake never saw it.
    // Retiring the order while its hold kept counting is the false hold this recovery would
    // otherwise create, so both pre-write states are freed.
    //
    // `SUBMITTING` is included because the write-boundary hook can have moved a hold just before
    // the mirror claim it precedes; that hold belongs to a write that never began. Terminal and
    // ambiguous rows are excluded by the guarded state filter and are left to §10.
    if (validatingIds.length > 0) {
      await tx.variantCapacityReservation.updateMany({
        where: { orderId: { in: validatingIds }, state: { in: ["RESERVED", "SUBMITTING"] } },
        data: { state: "RELEASED", releasedAt: now },
      });
    }

    const submitting = await tx.orderMirror.updateMany({
      where: { id: { in: submittingIds } },
      data: {
        state: "SYNC_UNKNOWN",
        syncErrorCode: "CREATE_OUTCOME_UNKNOWN",
      },
    });

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
      validatingRejected: validating.count,
      submittingUnknown: submitting.count,
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
