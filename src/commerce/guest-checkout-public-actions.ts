import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";

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
  { cartSession, consumeAttempt, submitCheckout, readAttribution, isBankTransferEnabled }: GuestCheckoutPublicActionDependencies,
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
  }

  return result;
}
