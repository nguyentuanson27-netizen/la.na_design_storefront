import type { FacebookPixelEventParameters } from "../components/analytics/facebook-pixel-client.ts";
import type { MetaPurchaseSnapshot } from "./meta-purchase-snapshot.ts";
import type { CommittedMetaEvent } from "./meta-event-reporting.ts";

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
  const parameters: FacebookPixelEventParameters = {
    content_ids: [input.slug],
    content_name: input.productName,
    content_type: "product",
    currency: "VND",
    ...(typeof input.committedUnitPriceVnd === "number"
      ? { value: input.committedUnitPriceVnd * (input.quantity ?? 1) }
      : {}),
    ...(input.quantity === undefined ? {} : {
      num_items: input.quantity,
      ...(typeof input.committedUnitPriceVnd === "number" ? {
        contents: [{ id: input.slug, quantity: input.quantity, item_price: input.committedUnitPriceVnd }],
      } : {}),
    }),
  };

  return Object.freeze(parameters);
}

/** A Meta twin for a positive committed delta; never reads rendered/browser facts. */
export function buildCommittedMetaAddToCart(snapshot: unknown, delta: number): CommittedMetaEvent | undefined {
  if (!Number.isSafeInteger(delta) || delta <= 0 || typeof snapshot !== "object" || snapshot === null) return undefined;
  const facts = snapshot as Record<string, unknown>;
  if (typeof facts.metaContentId !== "string" || !/^[a-z0-9-]{1,160}$/.test(facts.metaContentId)) return undefined;
  const price = facts.unitPriceVnd;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(price * delta)) return undefined;
  const name = typeof facts.metaContentName === "string" && facts.metaContentName.length <= 500
    ? facts.metaContentName : "";
  try {
    return Object.freeze({
      eventId: crypto.randomUUID(),
      parameters: buildMetaAddToCartPixelParameters({
        slug: facts.metaContentId, productName: name, committedUnitPriceVnd: price, quantity: delta,
      }),
    });
  } catch { return undefined; }
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
