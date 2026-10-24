import type { BankTransferInstructions, PaymentMethod } from "../commerce/bank-transfer.ts";
import type { HistoricalPreorderPresentation } from "../commerce/historical-preorder-presentation.ts";

/**
 * Everything the order-confirmation route decides, as pure functions.
 *
 * Separate from `checkout-success.ts` because that file reaches Prisma and the purchase snapshots.
 * What is left is what the page decided inline: whether the query string names an order code worth
 * looking up at all, and whether the confirmation is being shown.
 */

const MAX_PUBLIC_CODE_LENGTH = 128;

/**
 * The order code from the query string, or `null`.
 *
 * Deliberately strict about what reaches the lookup: a repeated `?order=` gives an array rather
 * than a string, and surrounding whitespace means the visitor did not follow a link this site
 * issued. Neither is normalized into a query, because guessing which of two codes was meant is how
 * one shopper gets shown another's confirmation.
 */
export function parseOrderCode(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PUBLIC_CODE_LENGTH) return null;
  if (value.trim() !== value) return null;
  return value;
}

export type CheckoutSuccessViewModel = Readonly<{
  /** True only for an order that exists and has reached CONFIRMED. */
  confirmed: boolean;
  /**
   * Shown to the shopper only when `confirmed`. Kept out of the view model otherwise so an
   * unconfirmed page cannot echo back a code someone typed into the address bar.
   */
  orderCode: string | null;
  /** Immutable I7 history. Null for ready-only, legacy/no-snapshot, or unconfirmed orders. */
  preorderHistory: HistoricalPreorderPresentation | null;
  /**
   * How the order was placed, whatever the settings say today. Never inferred from `bankTransfer`:
   * an order paid by transfer stays one after the account or flag changes.
   */
  paymentMethod: PaymentMethod;
  /** Present only for a confirmed bank-transfer order whose instructions can be stated in full now. */
  bankTransfer: BankTransferInstructions | null;
}>;

export function buildCheckoutSuccessViewModel(
  input: Readonly<{
    orderCode: string | null;
    confirmed: boolean;
    preorderHistory?: HistoricalPreorderPresentation | null;
    bankTransfer?: BankTransferInstructions | null;
    paymentMethod?: PaymentMethod;
  }>,
): CheckoutSuccessViewModel {
  const confirmed = input.confirmed && input.orderCode !== null;
  return Object.freeze({
    confirmed,
    orderCode: confirmed ? input.orderCode : null,
    preorderHistory: confirmed ? (input.preorderHistory ?? null) : null,
    paymentMethod: confirmed ? (input.paymentMethod ?? "COD") : "COD",
    bankTransfer: confirmed ? (input.bankTransfer ?? null) : null,
  });
}
