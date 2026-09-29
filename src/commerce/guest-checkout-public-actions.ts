import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";

type GuestCheckoutCartSession = {
  read(): string | null;
  clear(): void;
};

type SubmitCheckout = (input: {
  cartId: string;
  checkoutInput: unknown;
  quoteProof: unknown;
}) => Promise<GuestCheckoutSubmitResult>;

type ConsumeAttempt = (cartId: string) => Promise<boolean>;

export type GuestCheckoutPublicActionDependencies = {
  cartSession: GuestCheckoutCartSession;
  consumeAttempt: ConsumeAttempt;
  submitCheckout: SubmitCheckout;
};

function checkoutInputFromFormData(formData: FormData) {
  return {
    name: formData.get("name"),
    phone: formData.get("phone"),
    provinceRef: formData.get("provinceRef"),
    communeRef: formData.get("communeRef"),
    detail: formData.get("detail"),
    note: formData.get("note"),
  };
}

export async function submitGuestCheckoutPublicAction(
  { cartSession, consumeAttempt, submitCheckout }: GuestCheckoutPublicActionDependencies,
  formData: FormData,
): Promise<GuestCheckoutSubmitResult> {
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
    checkoutInput: checkoutInputFromFormData(formData),
    // Forwarded exactly as received. This is the one browser-supplied checkout field that is
    // allowed to matter, and it matters only by failing to verify — it is authenticated against the
    // server-read cart before it can say anything, and it never carries a price into the server.
    quoteProof: formData.get("quoteProof"),
  });

  if (result.ok) {
    cartSession.clear();
  }

  return result;
}
