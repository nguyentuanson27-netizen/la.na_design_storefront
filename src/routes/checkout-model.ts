import type { RenderedCheckoutQuoteFacts } from "../commerce/checkout-quote.ts";
import type { StorefrontCartLine } from "../commerce/storefront-cart.ts";
import type { TrustedProductImage } from "../commerce/product-media.ts";

/**
 * Everything the checkout route decides, as one pure function.
 *
 * Separate from `checkout.ts` because that file reaches `next/server`, the cart runtime and the
 * auth secret behind the quote proof. What is left is what the page decided inline: which of the
 * three states it is in, how each ordered line reads, and what the Meta pixel is told the order
 * contains.
 */

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

/**
 * Why the page renders what it renders.
 *
 * - `empty`      — no cart, or a cart with no lines.
 * - `unquotable` — lines exist but could not be priced, or could not be proved. Both are the same
 *                  answer to the shopper (go back and fix the cart), and keeping them one state
 *                  stops the page inventing a difference it cannot explain.
 * - `ready`      — a quote and a proof over exactly the facts rendered below.
 */
export type CheckoutState = "empty" | "unquotable" | "ready";

export type CheckoutLineView = Readonly<{
  variantId: string;
  productName: string;
  primaryImage: TrustedProductImage | null;
  /** `Màu / Kích cỡ`, or the fallback when the line resolved to no option pair. */
  optionLabel: string;
  quantity: number;
  lineTotalText: string;
}>;

export type CheckoutTotalsView = Readonly<{
  subtotalText: string;
  /** "Miễn phí" where shipping costs nothing, so the page never re-decides that. */
  shippingText: string;
  totalText: string;
}>;

export type CheckoutViewModel = Readonly<{
  state: CheckoutState;
  /** Empty unless `state` is `ready`; the other two states render no order summary. */
  lines: readonly CheckoutLineView[];
  totals: CheckoutTotalsView | null;
  /** The token the form submits with. Present exactly when `state` is `ready`. */
  quoteProof: string | null;
}>;

/**
 * What the pixel is told this checkout contains.
 *
 * Every line gets an id, falling back to the variant when a product mirror has since gone: dropping
 * a line here while `value` and `num_items` still count it would report an item list that
 * contradicts its own totals.
 */
export function checkoutPixelContentIds(lines: readonly StorefrontCartLine[]): readonly string[] {
  return lines.map((line) => line.productSlug ?? line.variantId);
}

export function buildCheckoutViewModel(
  input: Readonly<{
    lines: readonly StorefrontCartLine[];
    totals: RenderedCheckoutQuoteFacts | null;
    quoteProof: string | null;
  }>,
): CheckoutViewModel {
  if (input.lines.length === 0) {
    return Object.freeze({ state: "empty", lines: Object.freeze([]), totals: null, quoteProof: null });
  }

  // A quote without a proof is unusable: submission would reject it and the shopper would loop
  // through a reconfirm no retry escapes. Both halves are required before checkout is offered.
  if (!input.totals || !input.quoteProof) {
    return Object.freeze({
      state: "unquotable",
      lines: Object.freeze([]),
      totals: null,
      quoteProof: null,
    });
  }

  const totals = input.totals;

  return Object.freeze({
    state: "ready",
    lines: Object.freeze(
      input.lines.map((line) =>
        Object.freeze({
          variantId: line.variantId,
          productName: line.productName ?? "Sản phẩm không còn trong catalog",
          primaryImage: line.media.primary,
          optionLabel: [line.color, line.size].filter(Boolean).join(" / ") || "Biến thể",
          quantity: line.quantity,
          // `ready` means every line priced, so the fallback is unreachable rather than lenient.
          lineTotalText: currency.format((line.price ?? 0) * line.quantity),
        }),
      ),
    ),
    totals: Object.freeze({
      subtotalText: currency.format(totals.merchandiseSubtotalVnd),
      shippingText:
        totals.shippingFeeVnd === 0 ? "Miễn phí" : currency.format(totals.shippingFeeVnd),
      totalText: currency.format(totals.totalVnd),
    }),
    quoteProof: input.quoteProof,
  });
}
