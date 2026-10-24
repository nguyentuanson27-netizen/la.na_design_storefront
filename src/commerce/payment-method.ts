/**
 * The payment method as the browser and the server both read it. Kept free of imports so the
 * checkout form can use it without pulling the server-only bank-transfer and QR code into its bundle.
 */

export type PaymentMethod = "COD" | "BANK_TRANSFER";

export function parsePaymentMethod(value: unknown): PaymentMethod | null {
  if (value === undefined || value === null || value === "" || value === "COD") return "COD";
  return value === "BANK_TRANSFER" ? "BANK_TRANSFER" : null;
}

/**
 * What the form should treat as the buyer's choice. A choice made while the method was on is void
 * once it is off: the radios are gone from the page, so the form posts nothing and the server reads
 * COD, and the button must say the same.
 */
export function effectivePaymentMethod(enabled: boolean, chosen: PaymentMethod): PaymentMethod {
  return enabled ? chosen : "COD";
}
