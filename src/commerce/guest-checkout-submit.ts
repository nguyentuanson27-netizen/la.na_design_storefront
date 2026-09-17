import type {
  RenderedQuoteProofFacts,
  RenderedQuoteProofRejection,
} from "./checkout-quote-proof.ts";
import type { ReservationState } from "./capacity-policy.ts";
import type { HeldReservation, ReservationOutcome } from "./capacity-reservation.ts";
import type { PancakeOrderSubmissionResult } from "./pancake-order-submit.ts";

type ActiveSnapshotState =
  | "DRAFT"
  | "VALIDATING"
  | "POS_SUBMITTING"
  | "CONFIRMED"
  | "SYNC_UNKNOWN";

type SnapshotFailureReason =
  | "INVALID_INPUT"
  | "CART_UNAVAILABLE"
  | "CART_EMPTY"
  | "CART_LINE_UNAVAILABLE"
  | "MONEY_UNSUPPORTED"
  | "PUBLIC_CODE_UNAVAILABLE";

type SnapshotResult =
  | {
      ok: true;
      order: {
        id: string;
        publicCode: string;
        state: ActiveSnapshotState;
        merchandiseSubtotalVnd: bigint;
        shippingFeeVnd: bigint;
        totalVnd: bigint;
        lines: readonly { variantId: string; quantity: number }[];
      };
    }
  | { ok: false; reason: SnapshotFailureReason }
  | {
      ok: false;
      reason: "QUOTE_UNPROVEN";
      quoteReason: RenderedQuoteProofRejection;
      refreshedQuote: RenderedQuoteProofFacts;
    };

type SnapshotService = {
  create(input: {
    cartId: string;
    shopId: number;
    publicCode: string;
    checkoutInput: unknown;
    now: Date;
  }): Promise<SnapshotResult>;
};


type OrderSubmissionService = {
  submit(input: { publicCode: string; shopId: number }): Promise<PancakeOrderSubmissionResult>;
};

/**
 * I6b — the ADR 0014 §6.2 reservation boundary, as this service needs it.
 *
 * Structural rather than the concrete repository so the submit service stays testable without a
 * database, matching how `snapshot` and `orderSubmission` are already injected here.
 */
type CapacityReservationService = {
  reserveOrderCapacity(input: {
    orderId: string;
    lines: readonly { variantId: string; quantity: number }[];
  }): Promise<ReservationOutcome>;
  transitionReservation(input: {
    id: string;
    from: ReservationState;
    to: ReservationState;
    at?: Date;
  }): Promise<boolean>;
};

export type GuestCheckoutBrowserReason =
  | "INVALID_INPUT"
  | "CART_UNAVAILABLE"
  | "CART_CHANGED"
  | "SERVICE_UNAVAILABLE"
  | "CHECKOUT_UNAVAILABLE";

/**
 * The refreshed money a buyer must explicitly accept before submission can continue.
 *
 * Display only, and deliberately *without* a proof. Handing the browser a fresh proof here would let
 * it authorise the next submission before the refreshed quote had actually been rendered — and the
 * proof binds line identities, quantities and per-line prices, not just this total, so a fast second
 * click could confirm a basket the buyer never saw. The refreshed server render is the only thing
 * that issues a proof, which keeps "a proof exists only alongside the render it attests" structural
 * rather than a convention the client has to honour.
 */
export type GuestCheckoutPriceChange = Readonly<{
  merchandiseSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
}>;

export type GuestCheckoutSubmitResult =
  | { ok: true; status: "CONFIRMED"; orderCode: string }
  | { ok: false; status: "PRICE_CHANGED"; priceChange: GuestCheckoutPriceChange }
  | {
      ok: false;
      status: "RETRYABLE";
      reason: GuestCheckoutBrowserReason;
      orderCode?: string;
    }
  | { ok: false; status: "PROCESSING"; orderCode: string }
  | { ok: false; status: "SYNC_UNKNOWN"; orderCode: string };

export type GuestCheckoutSubmitDependencies = {
  snapshot: SnapshotService;
  orderSubmission: OrderSubmissionService;
  generatePublicCode: () => string;
  onQuoteProofRejection?: (reason: RenderedQuoteProofRejection) => void;
  /**
   * I6b — optional so every existing caller keeps today's behaviour until it is wired. Absent means
   * no hold is taken, which is exactly the pre-I6b path; it is not a silent bypass, because the
   * runtime that builds the production service supplies it.
   */
  capacity?: CapacityReservationService;
  clock?: () => Date;
};

/**
 * States that mean the external write has already happened.
 *
 * The snapshot can hand back an order that is past the submit boundary — the recovery path finds an
 * active checkout rather than creating one, and a buyer who resubmits a confirmed order lands here.
 * Reserving for such an order is wrong twice over: its capacity was decided when it was first
 * submitted, and taking a fresh hold now would either double-count it or, for an order created
 * before this boundary existed, invent a hold for units Pancake has already consumed.
 *
 * So the boundary applies to orders that are about to be submitted. `VALIDATING` and
 * `POS_SUBMITTING` still reserve: they are mid-flight rather than done, and the §3 idempotency
 * branch answers a retry that already holds.
 */
const SETTLED_SUBMISSION_STATES: readonly ActiveSnapshotState[] = ["CONFIRMED", "SYNC_UNKNOWN"];

/**
 * Which reservation state a submission outcome moves the hold to (ADR 0014 §4, §8, §9).
 *
 * The mapping is the whole safety argument of I6b, so it is one function rather than branches
 * scattered through `submit`:
 *
 * - **committed** — Pancake accepted. The hold keeps counting until the mirror observably includes
 *   the decrement (§4.1); it is `reservationHoldsCapacity()` that retires it, not this.
 * - **released** — `REJECTED` is a refusal, so nothing landed remotely and the capacity is free.
 * - **unknown** — `SYNC_UNKNOWN` is the ambiguous write. It must **never** be released on a timer
 *   (§8); only reconciliation (§10) can resolve it, and a stuck `UNKNOWN` holding capacity is the
 *   safe failure — a variant that stops selling, not one that oversells.
 * - **null — stay `SUBMITTING`** for everything still in flight (`VALIDATING`, `POS_SUBMITTING`,
 *   `DRAFT`). §8 is explicit that `SUBMITTING` moves on the call's outcome or to `UNKNOWN`, and
 *   these outcomes are not an outcome yet. A `DRAFT` repriced by the P9b handshake is the clearest
 *   case: the buyer is about to reconfirm, and releasing the hold underneath them would let another
 *   checkout take the units they are mid-way through buying.
 */
function reservationStateForSubmission(
  result: PancakeOrderSubmissionResult,
): Extract<ReservationState, "COMMITTED" | "RELEASED" | "UNKNOWN"> | null {
  if (result.ok) return "COMMITTED";
  if (result.state === "SYNC_UNKNOWN") return "UNKNOWN";
  if (result.state === "REJECTED") return "RELEASED";
  return null;
}

function mapSnapshotFailure(reason: SnapshotFailureReason): GuestCheckoutSubmitResult {
  switch (reason) {
    case "INVALID_INPUT":
      return { ok: false, status: "RETRYABLE", reason: "INVALID_INPUT" };
    case "CART_UNAVAILABLE":
    case "CART_EMPTY":
    case "CART_LINE_UNAVAILABLE":
      return { ok: false, status: "RETRYABLE", reason: "CART_UNAVAILABLE" };
    case "MONEY_UNSUPPORTED":
    case "PUBLIC_CODE_UNAVAILABLE":
      return { ok: false, status: "RETRYABLE", reason: "CHECKOUT_UNAVAILABLE" };
  }
}

function isCartChangedReason(reason: string): boolean {
  return (
    reason === "VARIATION_UNAVAILABLE" ||
    reason === "PRICE_CHANGED" ||
    reason === "PRICE_UNAVAILABLE" ||
    reason === "STOCK_UNAVAILABLE"
  );
}

function mapSubmissionResult(
  orderCode: string,
  result: PancakeOrderSubmissionResult,
): GuestCheckoutSubmitResult {
  if (result.ok) {
    return { ok: true, status: "CONFIRMED", orderCode };
  }

  if (result.state === "SYNC_UNKNOWN") {
    return { ok: false, status: "SYNC_UNKNOWN", orderCode };
  }

  if (result.state === "VALIDATING" || result.state === "POS_SUBMITTING") {
    return { ok: false, status: "PROCESSING", orderCode };
  }

  if (result.state === "DRAFT") {
    // A DRAFT repriced against a fresher Pancake base is the P9b handshake, not a stuck order.
    // Falling through to PROCESSING would tell the buyer their order is being handled and to stop
    // resubmitting — the exact opposite of the explicit reconfirmation this outcome requires.
    if (result.reason === "PRICE_CHANGED" && "repricedQuote" in result) {
      return { ok: false, status: "PRICE_CHANGED", priceChange: result.repricedQuote };
    }
    if (result.reason === "VALIDATION_UNAVAILABLE") {
      return {
        ok: false,
        status: "RETRYABLE",
        reason: "SERVICE_UNAVAILABLE",
        orderCode,
      };
    }
    return { ok: false, status: "PROCESSING", orderCode };
  }

  if (result.state === "REJECTED") {
    return {
      ok: false,
      status: "RETRYABLE",
      reason: isCartChangedReason(result.reason) ? "CART_CHANGED" : "CHECKOUT_UNAVAILABLE",
      orderCode,
    };
  }

  return { ok: false, status: "PROCESSING", orderCode };
}

export function createGuestCheckoutSubmitService({
  snapshot,
  orderSubmission,
  generatePublicCode,
  onQuoteProofRejection,
  capacity,
  clock = () => new Date(),
}: GuestCheckoutSubmitDependencies) {
  /**
   * Move every hold this order owns to `SUBMITTING` before the external write (§4).
   *
   * Rows already `SUBMITTING` are left alone rather than re-transitioned: that is what a retry of an
   * in-flight submission looks like, and the guarded compare-and-set would refuse it anyway.
   *
   * Anything in a state that is neither `RESERVED` nor `SUBMITTING` fails the submission closed. A
   * `COMMITTED`, `RELEASED` or `UNKNOWN` hold means this order's capacity has already been decided
   * — by a previous submission or by reconciliation — and re-submitting against it is §10's
   * business, not the checkout's. Pushing on would either double-submit or write over an ambiguous
   * outcome, which is the one thing §8 forbids doing on anything but evidence.
   */
  async function beginSubmitting(reservations: readonly HeldReservation[]): Promise<boolean> {
    for (const reservation of reservations) {
      if (reservation.state === "SUBMITTING") continue;
      if (reservation.state !== "RESERVED") return false;
      const moved = await capacity!.transitionReservation({
        id: reservation.id,
        from: "RESERVED",
        to: "SUBMITTING",
      });
      // A lost compare-and-set means another worker moved this row first; its decision stands and
      // this submission must not proceed on a hold it no longer owns.
      if (!moved) return false;
    }
    return true;
  }

  /**
   * Settle the holds on the submission's outcome. Best effort by design: the buyer's result is
   * already decided by Pancake, and a failed transition here is a ledger row left `SUBMITTING`,
   * which §10 reconciliation is built to pick up. Refusing to report a confirmed order because a
   * bookkeeping update lost a race would be strictly worse.
   */
  async function settleReservations(
    reservations: readonly HeldReservation[],
    to: Extract<ReservationState, "COMMITTED" | "RELEASED" | "UNKNOWN">,
  ): Promise<void> {
    const at = clock();
    for (const reservation of reservations) {
      await capacity!.transitionReservation({ id: reservation.id, from: "SUBMITTING", to, at });
    }
  }

  async function submit({
    cartId,
    shopId,
    checkoutInput,
    now,
  }: {
    cartId: string;
    shopId: number;
    checkoutInput: unknown;
    now: Date;
  }): Promise<GuestCheckoutSubmitResult> {
    const proposedPublicCode = generatePublicCode();
    const snapshotResult = await snapshot.create({
      cartId,
      shopId,
      publicCode: proposedPublicCode,
      checkoutInput,
      now,
    });

    if (!snapshotResult.ok) {
      if (snapshotResult.reason === "QUOTE_UNPROVEN") {
        onQuoteProofRejection?.(snapshotResult.quoteReason);
        // Every unproven outcome — missing, oversized, malformed, forged, wrong-cart or simply
        // stale — converges here deliberately: the buyer is shown the current price and must accept
        // it again. Reporting *why* the proof failed would tell a probing client which of its
        // guesses was closer, and the buyer's next step is identical in every case.
        const { refreshedQuote } = snapshotResult;
        return {
          ok: false,
          status: "PRICE_CHANGED",
          priceChange: {
            merchandiseSubtotalVnd: refreshedQuote.merchandiseSubtotalVnd,
            shippingFeeVnd: refreshedQuote.shippingFeeVnd,
            totalVnd: refreshedQuote.totalVnd,
          },
        };
      }
      return mapSnapshotFailure(snapshotResult.reason);
    }

    const orderCode = snapshotResult.order.publicCode;

    // I6b — the capacity gate runs HERE: after the order exists and before any external write, which
    // is ADR 0014 §2's "server-side order commit boundary". Everything the cart and the PDP said was
    // advisory; this is the decision, and it is allowed to refuse what they offered.
    let reservations: readonly HeldReservation[] = [];
    const alreadySubmitted = SETTLED_SUBMISSION_STATES.includes(snapshotResult.order.state);
    if (capacity && !alreadySubmitted) {
      const reserved = await capacity.reserveOrderCapacity({
        orderId: snapshotResult.order.id,
        lines: snapshotResult.order.lines,
      });
      if (!reserved.ok) {
        // The basket cannot be held, so nothing is sent to Pancake. Reported as CART_CHANGED
        // because that is what the buyer has to act on — someone else took the units, or the
        // owner's allowance is spent — and §2 requires the refusal be surfaced honestly rather
        // than papered over.
        return { ok: false, status: "RETRYABLE", reason: "CART_CHANGED", orderCode };
      }
      reservations = reserved.reservations;

      if (!(await beginSubmitting(reservations))) {
        return { ok: false, status: "RETRYABLE", reason: "CHECKOUT_UNAVAILABLE", orderCode };
      }
    }

    const submissionResult = await orderSubmission.submit({ publicCode: orderCode, shopId });

    if (capacity && reservations.length > 0) {
      const settled = reservationStateForSubmission(submissionResult);
      // `null` means the submission has no outcome yet, so the holds stay SUBMITTING and keep
      // counting. That is deliberate, not an omission — see `reservationStateForSubmission`.
      if (settled !== null) await settleReservations(reservations, settled);
    }

    return mapSubmissionResult(orderCode, submissionResult);
  }

  return { submit };
}
