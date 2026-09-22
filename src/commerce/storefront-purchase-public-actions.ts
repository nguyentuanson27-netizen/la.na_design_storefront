/**
 * The public boundary of the PDP "add one unit" action.
 *
 * Two jobs, both about what does *not* cross it.
 *
 * Inward: browser input is untrusted, so only `slug` and `variantId` are read and anything else in
 * the payload is discarded.
 *
 * Outward: the browser needs enough to build a truthful `add_to_cart` and nothing more. It gets the
 * committed quantity transition and a bounded non-PII item snapshot, rebuilt field by field here.
 * It does not get the cart identity — the anonymous cart id stays an HttpOnly server-side handle,
 * and exposing it to correlate an event would turn a confidential session key into browser data —
 * and it does not get the internal `VariantMirror.id`, the mirror row, or any part of the larger
 * cart object.
 *
 * `analyticsUnavailable` is how a successful mutation says "no canonical item". It is a signal to
 * emit no canonical event, never a signal to fall back to whatever the page was rendering: commerce
 * succeeded either way, and a stale browser price is not a substitute for the price that committed.
 *
 * `committedUnitPriceVnd` is carried separately and survives that failure. The existing direct Meta
 * integration reports on every accepted add and needs only a value; making its delivery depend on
 * the richer canonical item would change a success boundary this unit was not meant to touch. A
 * line whose mirrored name is blank is exactly that case: purchasable, priced, and unnameable.
 */

import type { CommerceVariantItemFacts } from "../tracking/commerce-events.ts";
import { toPublicCartAnalyticsItemFacts } from "./cart-analytics-facts.ts";

const MAX_PDP_QUANTITY = 99;

type StorefrontPurchaseInput = {
  slug: string;
  variantId: string;
  quantity: number;
};

export type StorefrontPurchaseTransition = Readonly<{
  previousQuantity: number;
  quantity: number;
  /** Requested quantity that committed in this PDP add. The event reports this delta, never the committed total. */
  addedQuantity: number;
}>;

export type StorefrontPublicPurchaseResult =
  | Readonly<{
      ok: true;
      transition: StorefrontPurchaseTransition;
      /** The server-committed unit price, when the mutation could state one. */
      committedUnitPriceVnd?: number;
      analyticsItem?: CommerceVariantItemFacts;
      analyticsUnavailable?: true;
    }>
  | Readonly<{
      ok: false;
      reason: "INVALID_SELECTION" | "VARIANT_UNAVAILABLE" | "PURCHASE_FAILED";
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCommittedQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readCommittedPrice(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readRequestedQuantity(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_PDP_QUANTITY
    ? value
    : null;
}

function toPublicPurchaseResult(result: unknown): StorefrontPublicPurchaseResult {
  if (!isRecord(result)) {
    return { ok: false, reason: "PURCHASE_FAILED" };
  }

  if (result.ok === true) {
    const previousQuantity = readCommittedQuantity(result.previousQuantity);
    const quantity = readCommittedQuantity(result.quantity);
    const addedQuantity = readRequestedQuantity(result.addedQuantity);
    // A success must state the exact committed delta. Never infer quantity from the final line total:
    // an existing cart line may already contain units, and analytics must report only this action.
    if (
      previousQuantity === null
      || quantity === null
      || addedQuantity === null
      || quantity !== previousQuantity + addedQuantity
    ) {
      return { ok: false, reason: "PURCHASE_FAILED" };
    }

    const transition: StorefrontPurchaseTransition = Object.freeze({
      previousQuantity,
      quantity,
      addedQuantity,
    });
    const snapshot = isRecord(result.snapshot) ? result.snapshot : {};
    const committedUnitPriceVnd = readCommittedPrice(snapshot.unitPriceVnd);
    // The canonical event reports the committed delta, never the line total after this add.
    const analyticsItem = toPublicCartAnalyticsItemFacts(snapshot.analyticsItem, addedQuantity);

    return Object.freeze({
      ok: true as const,
      transition,
      ...(committedUnitPriceVnd === null ? {} : { committedUnitPriceVnd }),
      ...(analyticsItem === null
        ? { analyticsUnavailable: true as const }
        : { analyticsItem }),
    });
  }

  if (result.ok === false && result.reason === "INVALID_SELECTION") {
    return { ok: false, reason: "INVALID_SELECTION" };
  }

  if (result.ok === false && result.reason === "VARIANT_UNAVAILABLE") {
    return { ok: false, reason: "VARIANT_UNAVAILABLE" };
  }

  return { ok: false, reason: "PURCHASE_FAILED" };
}

export function createStorefrontPurchasePublicActions({
  purchase,
}: {
  purchase(input: StorefrontPurchaseInput): Promise<unknown>;
}) {
  async function add(input: unknown): Promise<StorefrontPublicPurchaseResult> {
    if (
      !isRecord(input) ||
      typeof input.slug !== "string" ||
      typeof input.variantId !== "string"
    ) {
      return { ok: false, reason: "INVALID_SELECTION" };
    }

    const quantity = input.quantity === undefined ? 1 : readRequestedQuantity(input.quantity);
    if (quantity === null) {
      return { ok: false, reason: "INVALID_SELECTION" };
    }

    return toPublicPurchaseResult(
      await purchase({ slug: input.slug, variantId: input.variantId, quantity }),
    );
  }

  return { add };
}
