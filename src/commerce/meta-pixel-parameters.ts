import type { FacebookPixelEventParameters } from "../components/analytics/facebook-pixel-client.ts";
import type { MetaPurchaseSnapshot } from "./meta-purchase-snapshot.ts";

/**
 * Direct Meta Pixel parameter builders.
 *
 * Production emitters (PDP AddToCart and Checkout Success Purchase) use these builders
 * rather than ad-hoc inline literals. This guarantees monetary and identity parity with
 * the central pricing resolver and ensures domain tests fail if the mapping drifts.
 */

export type MetaAddToCartParametersInput = Readonly<{
  slug: string;
  productName: string;
  committedUnitPriceVnd?: number | null;
  quantity?: number;
}>;

export function buildMetaAddToCartPixelParameters(
  input: MetaAddToCartParametersInput,
): FacebookPixelEventParameters {
  const quantity =
    typeof input.quantity === "number" && Number.isSafeInteger(input.quantity) && input.quantity > 0
      ? input.quantity
      : 1;
  const parameters: FacebookPixelEventParameters = {
    content_ids: [input.slug],
    content_name: input.productName,
    content_type: "product",
    currency: "VND",
    ...(typeof input.committedUnitPriceVnd === "number"
      ? { value: input.committedUnitPriceVnd * quantity }
      : {}),
  };

  return Object.freeze(parameters);
}

export function buildMetaPurchasePixelParameters(
  snapshot: MetaPurchaseSnapshot,
): FacebookPixelEventParameters {
  const parameters: FacebookPixelEventParameters = {
    content_ids: snapshot.contents.map((content) => content.id),
    content_type: "product",
    contents: snapshot.contents.map((content) => ({
      id: content.id,
      quantity: content.quantity,
      item_price: content.itemPrice,
    })),
    currency: "VND",
    value: snapshot.valueVnd,
  };

  return Object.freeze(parameters);
}
