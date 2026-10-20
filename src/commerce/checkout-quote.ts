import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import {
  calculateGuestShippingFeeVnd,
  readGuestShippingPolicy,
  type GuestShippingPolicy,
} from "./guest-shipping-policy.ts";
import {
  MAX_QUOTE_LINES,
  validateQuoteStructure,
  type QuoteDiscountStepFacts,
  type QuoteEntitlementFacts,
  type QuoteLineFacts,
  type QuoteStructure,
} from "./order-quote-rules.ts";
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
  options?: Readonly<{ qualifyingSetQuantity?: number; shippingPolicy?: GuestShippingPolicy }>,
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

  const shippingFeeVnd = calculateGuestShippingFeeVnd(
    {
      subtotalVnd: merchandiseSubtotalVnd,
      totalQuantity,
      qualifyingSetQuantity: options?.qualifyingSetQuantity ?? 0,
    },
    options?.shippingPolicy ?? readGuestShippingPolicy(),
  );
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


// ---------------------------------------------------------------------------------------------------
// GQ16 -- the benefit-aware quote facts.
// ---------------------------------------------------------------------------------------------------

/** A paid segment as the stack resolved it: one group per variation per price. */
export type BenefitQuotePaidGroup = Readonly<{
  /** Orders segments that tie on everything else; internal, never part of a `lineId`. */
  groupKey: string;
  pancakeVariationId: string;
  quantity: number;
  /** Per-unit price after every discount step, whole VND >= 1. */
  unitPriceVnd: number;
  steps: readonly QuoteDiscountStepFacts[];
  fulfillmentState: "READY" | "PREORDER";
}>;

/** A gift the buyer chose, already validated against the entitlement engine. */
export type BenefitQuoteGift = Readonly<{
  campaignId: string;
  campaignRevision: number;
  pancakeVariationId: string;
  quantity: number;
}>;

/** Characters allowed in the parts a `lineId` is built from (a Pancake variation id, a campaign id). */
const LINE_ID_PART = /^[A-Za-z0-9_-]{1,100}$/;

function stepsFingerprint(steps: readonly QuoteDiscountStepFacts[]): string {
  return steps
    .map((step) => `${step.campaignId.length}:${step.campaignId}:${step.source}:${step.priority ?? "-"}:${step.inputPriceVnd}:${step.outputPriceVnd}:${step.appliedQuantity}`)
    .join(";");
}

/**
 * Canonical, non-PII facts of a quote that has gifts or quantity-tier segments, or `null` when they
 * cannot be made a consistent one (the checkout then refuses to quote rather than guessing).
 *
 * `lineId` is built here and nowhere else, from facts that are already public to the buyer: a PAID
 * segment is `P:<variation>:<n>` where `n` ranks the segments of one variation by price (highest
 * first), then discount ledger, then quantity; a GIFT line is `G:<campaign>:<variation>`. It is stable
 * between render and submit while the facts do not change, differs when they do, never contains the
 * cart id, a customer field or an internal `VariantMirror` id, and is never accepted from a browser.
 *
 * Money rules (FR-10/FR-11): a PAID unit costs a positive whole number of VND, a gift costs 0 and is a
 * line of its own, shipping is decided by the PAID quantity and PAID subtotal only (a gift never moves
 * an order across the free-shipping threshold), and slots the buyer is entitled to but does not take
 * are carried per campaign, because they change what the buyer must acknowledge.
 */
export function buildBenefitCheckoutQuoteFacts({
  paid,
  gifts,
  entitlements,
  qualifyingSetQuantity = 0,
  shippingPolicy,
}: Readonly<{
  paid: readonly BenefitQuotePaidGroup[];
  gifts: readonly BenefitQuoteGift[];
  entitlements: readonly QuoteEntitlementFacts[];
  qualifyingSetQuantity?: number;
  shippingPolicy?: GuestShippingPolicy;
}>): QuoteStructure | null {
  if (!Array.isArray(paid) || !Array.isArray(gifts) || !Array.isArray(entitlements)) return null;
  if (paid.length === 0 || paid.length + gifts.length > MAX_QUOTE_LINES) return null;

  const ordered = [...paid].sort((left, right) =>
    compareText(left.pancakeVariationId, right.pancakeVariationId) ||
    right.unitPriceVnd - left.unitPriceVnd ||
    compareText(stepsFingerprint(left.steps), stepsFingerprint(right.steps)) ||
    right.quantity - left.quantity ||
    compareText(left.groupKey, right.groupKey),
  );

  const lines: QuoteLineFacts[] = [];
  const ordinalByVariation = new Map<string, number>();
  let paidSubtotalVnd = 0;
  let paidQuantity = 0;
  for (const group of ordered) {
    if (!LINE_ID_PART.test(group.pancakeVariationId)) return null;
    const lineTotalVnd = checkedMultiplyVnd(group.unitPriceVnd, group.quantity);
    const nextSubtotal = lineTotalVnd === null ? null : checkedAddVnd(paidSubtotalVnd, lineTotalVnd);
    const nextQuantity = paidQuantity + group.quantity;
    if (lineTotalVnd === null || nextSubtotal === null || !Number.isSafeInteger(nextQuantity)) return null;
    const ordinal = ordinalByVariation.get(group.pancakeVariationId) ?? 0;
    ordinalByVariation.set(group.pancakeVariationId, ordinal + 1);
    lines.push(Object.freeze({
      lineId: `P:${group.pancakeVariationId}:${ordinal}`,
      role: "PAID" as const,
      pancakeVariationId: group.pancakeVariationId,
      quantity: group.quantity,
      unitPriceVnd: group.unitPriceVnd,
      lineTotalVnd,
      fulfillmentState: group.fulfillmentState,
      campaign: null,
      discountSteps: Object.freeze(group.steps.map((step: QuoteDiscountStepFacts) => Object.freeze({ ...step }))),
    }));
    paidSubtotalVnd = nextSubtotal;
    paidQuantity = nextQuantity;
  }

  for (const gift of gifts) {
    if (!LINE_ID_PART.test(gift.pancakeVariationId) || !LINE_ID_PART.test(gift.campaignId)) return null;
    lines.push(Object.freeze({
      lineId: `G:${gift.campaignId}:${gift.pancakeVariationId}`,
      role: "GIFT" as const,
      pancakeVariationId: gift.pancakeVariationId,
      quantity: gift.quantity,
      unitPriceVnd: 0,
      lineTotalVnd: 0,
      // A free gift is delivered from READY stock only (ADR 0016 D-04).
      fulfillmentState: "READY" as const,
      campaign: Object.freeze({ id: gift.campaignId, revision: gift.campaignRevision }),
      discountSteps: Object.freeze([]),
    }));
  }

  const shippingFeeVnd = calculateGuestShippingFeeVnd(
    { subtotalVnd: paidSubtotalVnd, totalQuantity: paidQuantity, qualifyingSetQuantity },
    shippingPolicy ?? readGuestShippingPolicy(),
  );
  const totalVnd = checkedAddVnd(paidSubtotalVnd, shippingFeeVnd);
  if (totalVnd === null) return null;

  const facts: QuoteStructure = Object.freeze({
    paidSubtotalVnd,
    shippingFeeVnd,
    totalVnd,
    lines: Object.freeze(lines),
    // A campaign that earned nothing and gave nothing says nothing about this order.
    entitlements: Object.freeze(entitlements.filter((entry: QuoteEntitlementFacts) => entry.entitled > 0 || entry.selected > 0).map((entry: QuoteEntitlementFacts) => Object.freeze({ ...entry }))),
  });
  return validateQuoteStructure(facts).ok ? facts : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
