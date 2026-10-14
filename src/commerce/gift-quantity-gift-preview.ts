/**
 * Illustrative gift entitlement for the admin form (GQ13b).
 *
 * It runs the real entitlement engine (`evaluateGiftEntitlements`) on one synthetic, fully eligible
 * paid line, so the numbers an operator sees are the ones the cart would compute for that line --
 * no second formula. It is explicitly **not** a cart quote: scope, discounts applied before the
 * threshold, stock, stacking and the buyer's actual lines are decided by the server on every read.
 */

import { evaluateGiftEntitlements, MAX_GIFTS_PER_ORDER_TECHNICAL_CAP, type GiftCampaignFacts } from "./gift-quantity-entitlement.ts";

export type GiftPreviewRule = Readonly<{
  trigger: "QUANTITY" | "ORDER_SUBTOTAL";
  minimumQuantity: number | null;
  minimumSubtotalVnd: number | null;
  awardMode: "ONCE" | "REPEAT_PER_THRESHOLD" | null;
  maxGiftsPerOrder: number | null;
}>;

export type GiftPreviewRow = Readonly<{
  /** Paid units (quantity trigger) or paid subtotal in VND (subtotal trigger) that was evaluated. */
  sample: number;
  earned: number;
  entitled: number;
  cappedByMaximum: boolean;
  /** How much more reaches the next slot; null at the cap or when the trigger has no next slot. */
  shortfallToNext: number | null;
}>;

/** Upper bound of a sampled quantity: the engine itself refuses more paid groups, but not more units. */
const MAX_SAMPLE_QUANTITY = 1_000_000_000;
const MAX_SAMPLE_SUBTOTAL = 1_000_000_000_000;

const PREVIEW_PRODUCT = "sample";

function campaignFor(rule: GiftPreviewRule): GiftCampaignFacts {
  return {
    id: "preview",
    revision: 1,
    trigger: rule.trigger,
    minimumQuantity: rule.minimumQuantity,
    minimumSubtotalVnd: rule.minimumSubtotalVnd,
    // The arithmetic is the same for both subtotal scopes; naming the one sample product is the simplest valid scope.
    subtotalScope: rule.trigger === "ORDER_SUBTOTAL" ? "ELIGIBLE_PAID_LINES" : null,
    awardMode: rule.awardMode,
    maxGiftsPerOrder: rule.maxGiftsPerOrder,
    allowDuplicateGifts: true,
    scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: [], includeProductIds: [PREVIEW_PRODUCT], excludeProductIds: [] },
    frozen: null,
    options: [],
  };
}

/** One evaluated sample, or null when the rule or the sample is not something the engine accepts. */
export function previewGiftEntitlement(rule: GiftPreviewRule, sample: number): GiftPreviewRow | null {
  if (!Number.isSafeInteger(sample) || sample < 1) return null;
  const quantityTrigger = rule.trigger === "QUANTITY";
  if (sample > (quantityTrigger ? MAX_SAMPLE_QUANTITY : MAX_SAMPLE_SUBTOTAL)) return null;
  const evaluation = evaluateGiftEntitlements({
    campaigns: [campaignFor(rule)],
    paidGroups: [{
      groupKey: "sample",
      product: { productId: PREVIEW_PRODUCT, categoryKeys: [] },
      quantity: quantityTrigger ? sample : 1,
      unitPriceVnd: quantityTrigger ? 1 : sample,
    }],
  });
  if (!evaluation.ok) return null;
  const entitlement = evaluation.entitlements[0];
  if (entitlement === undefined) return null;
  return {
    sample,
    earned: entitlement.earned,
    entitled: entitlement.entitled,
    cappedByMaximum: entitlement.cappedByMaximum,
    shortfallToNext: entitlement.shortfallToNext === null
      ? null
      : quantityTrigger ? entitlement.shortfallToNext.quantity : entitlement.shortfallToNext.subtotalVnd,
  };
}

/**
 * The samples worth showing around a threshold: one short of it, exactly on it (the boundary is `>=`),
 * the next multiple and one past it, plus anything the operator asked to try. Sorted, unique, >= 1.
 */
export function previewSamples(threshold: number, extra: readonly number[] = []): readonly number[] {
  if (!Number.isSafeInteger(threshold) || threshold < 1) return [];
  const candidates = [threshold - 1, threshold, threshold * 2 - 1, threshold * 2, threshold * 2 + 1, threshold * 3, ...extra];
  return [...new Set(candidates.filter((value) => Number.isSafeInteger(value) && value >= 1))].sort((a, b) => a - b);
}

export { MAX_GIFTS_PER_ORDER_TECHNICAL_CAP as GIFT_PREVIEW_TECHNICAL_CAP };
