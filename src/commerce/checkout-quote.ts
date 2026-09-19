import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { calculateGuestShippingFeeVnd } from "./guest-shipping-policy.ts";
import type { StorefrontCartLine } from "./storefront-cart.ts";

export type RenderedCheckoutQuoteItem = Readonly<{
  variantExternalId: string;
  quantity: number;
  unitPriceVnd: number;
  /** §30 — whether this line was quoted as waiting for preparation. Signed with the money. */
  fulfillmentState: "READY" | "PREORDER";
}>;

export type RenderedCheckoutQuoteFacts = Readonly<{
  items: readonly RenderedCheckoutQuoteItem[];
  merchandiseSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  totalQuantity: number;
}>;

function checkedMultiplyVnd(unitPriceVnd: number, quantity: number): number | null {
  if (
    !Number.isSafeInteger(unitPriceVnd) ||
    unitPriceVnd <= 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    return null;
  }
  const total = unitPriceVnd * quantity;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function checkedAddVnd(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

/**
 * Canonical non-PII checkout facts that P9a can later authenticate.
 *
 * This is deliberately not a proof and carries no authority when posted back by a browser. It is a
 * bounded projection of the same server-resolved cart facts the checkout page already renders. The
 * raw anonymous-cart UUID, customer fields and internal VariantMirror ids never enter this shape.
 */
export function buildRenderedCheckoutQuoteFacts(
  lines: readonly StorefrontCartLine[],
): RenderedCheckoutQuoteFacts | null {
  if (lines.length === 0 || lines.length > ANONYMOUS_CART_MAX_DISTINCT_ITEMS) return null;

  const items: RenderedCheckoutQuoteItem[] = [];
  const seenVariationIds = new Set<string>();
  let merchandiseSubtotalVnd = 0;
  let totalQuantity = 0;

  for (const line of lines) {
    const variationId = line.pancakeVariationId;
    if (
      !line.available ||
      !variationId ||
      seenVariationIds.has(variationId) ||
      line.price === null
    ) {
      return null;
    }

    const lineTotalVnd = checkedMultiplyVnd(line.price, line.quantity);
    const nextSubtotal = lineTotalVnd === null
      ? null
      : checkedAddVnd(merchandiseSubtotalVnd, lineTotalVnd);
    const nextQuantity = totalQuantity + line.quantity;
    if (
      lineTotalVnd === null ||
      nextSubtotal === null ||
      !Number.isSafeInteger(nextQuantity) ||
      nextQuantity <= 0
    ) {
      return null;
    }

    seenVariationIds.add(variationId);
    items.push(Object.freeze({
      variantExternalId: variationId,
      quantity: line.quantity,
      unitPriceVnd: line.price,
      // The quantity-aware classification the cart line already carries — the same one the
      // reservation writes into history. Quoting it here is what lets P9a catch a basket whose
      // fulfillment state moved between the page the buyer read and the order they submitted.
      fulfillmentState: line.isPreorderSale ? ("PREORDER" as const) : ("READY" as const),
    }));
    merchandiseSubtotalVnd = nextSubtotal;
    totalQuantity = nextQuantity;
  }

  items.sort((left, right) =>
    left.variantExternalId < right.variantExternalId
      ? -1
      : left.variantExternalId > right.variantExternalId
        ? 1
        : 0,
  );

  const shippingFeeVnd = calculateGuestShippingFeeVnd({
    subtotalVnd: merchandiseSubtotalVnd,
    totalQuantity,
  });
  const totalVnd = checkedAddVnd(merchandiseSubtotalVnd, shippingFeeVnd);
  if (totalVnd === null) return null;

  return Object.freeze({
    items: Object.freeze(items),
    merchandiseSubtotalVnd,
    shippingFeeVnd,
    totalVnd,
    totalQuantity,
  });
}
