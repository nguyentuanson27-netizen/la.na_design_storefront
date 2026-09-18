import type { PrismaClient } from "../generated/prisma/client.ts";

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const MAX_CART_ID_LENGTH = 128;

type RecoveryOptions = Readonly<{
  now?: Date;
  staleAfterMs?: number;
  cartId?: string;
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
): Promise<{ validatingRejected: number; submittingUnknown: number }> {
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

    return {
      validatingRejected: validating.count,
      submittingUnknown: submitting.count,
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
