import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";
import { normalizeVietnamPhone } from "./vietnam-phone.ts";

type GuestCheckoutCartSession = {
  read(): string | null;
  clear(): void;
};

type SubmitCheckout = (input: {
  cartId: string;
  checkoutInput: unknown;
  quoteProof: unknown;
  /** GQ19: explicit submit intent after the gift reminder. Only the literal transport value is accepted. */
  nonclaimAcknowledged: boolean;
}) => Promise<GuestCheckoutSubmitResult>;

type ConsumeAttempt = (cartId: string) => Promise<boolean>;

export type GuestCheckoutPublicActionDependencies = {
  cartSession: GuestCheckoutCartSession;
  consumeAttempt: ConsumeAttempt;
  submitCheckout: SubmitCheckout;
  /**
   * The `[UTM] …` note line for an order that came from an ad, read server-side from the shopper's
   * `la_utm` cookie. Never taken from the form: the shopper does not get to write the attribution.
   */
  readAttribution?: () => string | null;
  /** Whether bank transfer may be chosen right now. Absent means it is off. */
  isBankTransferEnabled?: () => boolean;
  /**
   * Daily per-phone order ceiling, taken as a reservation before the order is submitted so that
   * carts racing on one number cannot all pass a check made before any of them is counted.
   * `admit` reserves (or finds this cart's earlier reservation); `release` gives a reservation back
   * when the order is known not to exist. It is a protection added on top of the checkout, so a
   * failure in either never costs a shopper their order: an unreadable counter lets the order
   * through, and a reservation that cannot be released is a missed refund, not a refusal.
   */
  phoneOrderLimit?: {
    admit(phone: string, cartId: string): Promise<"ADMITTED" | "ALREADY_ADMITTED" | "REFUSED">;
    release(phone: string, cartId: string): Promise<void>;
  };
};

function checkoutInputFromFormData(formData: FormData, attribution: string | null) {
  return {
    name: formData.get("name"),
    phone: formData.get("phone"),
    provinceRef: formData.get("provinceRef"),
    communeRef: formData.get("communeRef"),
    detail: formData.get("detail"),
    note: formData.get("note"),
    paymentMethod: formData.get("paymentMethod"),
    ...(attribution === null ? {} : { attribution }),
  };
}

/** Attribution is a courtesy to the people working the order; it never costs the shopper their checkout. */
function readAttributionSafely(readAttribution: (() => string | null) | undefined): string | null {
  try {
    return readAttribution?.() ?? null;
  } catch {
    return null;
  }
}

export async function submitGuestCheckoutPublicAction(
  { cartSession, consumeAttempt, submitCheckout, readAttribution, isBankTransferEnabled, phoneOrderLimit }: GuestCheckoutPublicActionDependencies,
  formData: FormData,
): Promise<GuestCheckoutSubmitResult> {
  // A stale page or a hand-built request can still post BANK_TRANSFER after the owner turned it
  // off. Refuse it before it takes a rate-limit attempt or touches the cart.
  if (formData.get("paymentMethod") === "BANK_TRANSFER" && !(isBankTransferEnabled?.() ?? false)) {
    return { ok: false, status: "RETRYABLE", reason: "INVALID_INPUT" };
  }

  const cartId = cartSession.read();
  if (!cartId) {
    return {
      ok: false,
      status: "RETRYABLE",
      reason: "CART_UNAVAILABLE",
    };
  }

  let attemptAllowed = false;
  try {
    attemptAllowed = await consumeAttempt(cartId);
  } catch {
    return {
      ok: false,
      status: "RETRYABLE",
      reason: "CHECKOUT_UNAVAILABLE",
    };
  }

  if (!attemptAllowed) {
    return {
      ok: false,
      status: "RETRYABLE",
      reason: "CHECKOUT_UNAVAILABLE",
    };
  }

  // A malformed number takes no reservation: the submit below refuses it as INVALID_PHONE.
  const phone = normalizeVietnamPhone(formData.get("phone"));
  let reservedHere = false;
  if (phone !== null && phoneOrderLimit) {
    let admission: "ADMITTED" | "ALREADY_ADMITTED" | "REFUSED" = "ALREADY_ADMITTED";
    try {
      admission = await phoneOrderLimit.admit(phone, cartId);
    } catch {
      // The counter is unreadable: the order goes ahead, unprotected rather than refused.
    }
    if (admission === "REFUSED") {
      return { ok: false, status: "RETRYABLE", reason: "TOO_MANY_ORDERS" };
    }
    reservedHere = admission === "ADMITTED";
  }

  const result = await submitCheckout({
    cartId,
    checkoutInput: checkoutInputFromFormData(formData, readAttributionSafely(readAttribution)),
    // Forwarded exactly as received. This is the one browser-supplied checkout field that is
    // allowed to matter, and it matters only by failing to verify — it is authenticated against the
    // server-read cart before it can say anything, and it never carries a price into the server.
    quoteProof: formData.get("quoteProof"),
    // A claim, not a fact: the runtime honours it only after the quote proof has verified, and only by
    // minting the signed acknowledgement for the quote the server just recomputed.
    nonclaimAcknowledged: formData.get("nonclaimAcknowledged") === "yes",
  });

  if (result.ok) {
    cartSession.clear();
  } else if (reservedHere && phone !== null && phoneOrderLimit && orderCertainlyAbsent(result)) {
    try {
      await phoneOrderLimit.release(phone, cartId);
    } catch {
      // Best effort: an unreleased slot expires with its day.
    }
  }

  return result;
}

/**
 * Whether a refused submit left no order anywhere, so its reservation can be given back. A pending
 * or unknown order (`PROCESSING`, `SYNC_UNKNOWN`), or a refusal that still names an order code, may
 * exist outside this system and keeps its slot; a retry from the same cart finds the same
 * reservation and is not counted again. A submit that throws is treated the same way, and is left
 * to propagate.
 */
function orderCertainlyAbsent(result: GuestCheckoutSubmitResult): boolean {
  if (result.ok) return false;
  if (result.status === "PRICE_CHANGED") return true;
  return result.status === "RETRYABLE" && result.orderCode === undefined;
}
