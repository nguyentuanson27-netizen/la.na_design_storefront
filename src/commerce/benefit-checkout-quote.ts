/**
 * The checkout quote of a cart that has quantity-tier segments or gifts (GQ17).
 *
 * One function decides, inside the caller's transaction, whether a cart is a *benefit cart* and, if it
 * is, what its quote is. The checkout render (which issues the proof) and the checkout DRAFT step
 * (which verifies it) both call it, so the two cannot derive different facts from the same cart. It
 * reads nothing the cart page does not already read: `readCartGiftState` is the very derivation the
 * cart's gift picker uses, which is what makes "the buyer saw it" and "the server prices it" the same
 * statement.
 *
 * It returns one of:
 *  - `LEGACY`    -- the gate is OFF, or nothing applies: no tier segment, no gift chosen and no gift
 *                   earned. The caller then runs the legacy checkout untouched, byte for byte.
 *  - `UNAVAILABLE` / `GIFT_SELECTION_INVALID` -- fail closed. The latter is a stored gift choice that
 *                   no longer holds (out of stock, campaign edited, no longer entitled). The choice is
 *                   left exactly as it is: the buyer is sent back to decide again, nothing is swapped.
 *  - `BENEFIT`   -- the facts to prove and to store.
 */

import type { Prisma } from "../generated/prisma/client.ts";
import { hasQuantityTierSegment } from "./benefit-tier-segment.ts";
import { withoutOrderHolds } from "./capacity-advisory.ts";
import { readCartGiftState } from "./cart-gift-selection.ts";
import { buildBenefitCheckoutQuoteFacts, type BenefitQuoteGift, type BenefitQuotePaidGroup } from "./checkout-quote.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import type { OrderQuoteSnapshotInput, DroppedBenefitInput } from "./order-quote-snapshot.ts";
import { DROPPED_BENEFIT_REASONS } from "./order-quote-snapshot.ts";
import { parseTrustedProductImageUrl } from "./product-media.ts";
import type { QuoteStructure } from "./order-quote-rules.ts";
import type { StorefrontCartLine } from "./storefront-cart.ts";

export type BenefitPaidRow = Readonly<{
  /** Internal `VariantMirror.id`; never leaves the server. */
  variantId: string;
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  /** What one unit costs before any promotion step. */
  baseUnitPriceVnd: number;
  /** The legacy campaign behind the first step, when there is one (its audit columns are kept). */
  legacyCampaignId: string | null;
}>;

export type BenefitGiftRow = Readonly<{
  variantId: string;
  pancakeVariationId: string;
  campaignId: string;
  quantity: number;
}>;

export type BenefitCheckoutResolution =
  | Readonly<{ kind: "LEGACY" }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "GIFT_SELECTION_INVALID" }>
  | Readonly<{
      kind: "BENEFIT";
      facts: QuoteStructure;
      paid: readonly BenefitPaidRow[];
      gifts: readonly BenefitGiftRow[];
      dropped: readonly DroppedBenefitInput[];
      /** Display only (GQ19): `Sản phẩm — Màu / Cỡ` of every chosen gift, by Pancake variation id. Never part of the proof. */
      giftLabels: ReadonlyMap<string, string>;
      /** Display only: each chosen gift's trusted product photo (or null), by Pancake variation id. Never part of the proof. */
      giftImages: ReadonlyMap<string, string | null>;
      /** Display only: the admin-given name of each quantity-tier campaign, by campaign id. Never part of the proof. */
      campaignNames: ReadonlyMap<string, string>;
    }>;

type Env = Readonly<Record<string, string | undefined>>;

export async function resolveBenefitCheckoutQuote({
  tx,
  cartId,
  shopId,
  now,
  env = process.env,
  lines,
  excludeOrderHolds,
  giftState,
}: Readonly<{
  tx: Prisma.TransactionClient;
  cartId: string;
  shopId: number;
  now: Date;
  env?: Env;
  /**
   * The legacy-resolved lines of the cart: identity and fulfillment come from here, prices do not.
   * Omitted by the POS submit, which has no cart view of its own: the cart's own quote supplies them.
   */
  lines?: readonly StorefrontCartLine[];
  /** The POS submit re-derives the quote while the order's own stock hold exists; that hold must not count against it. */
  excludeOrderHolds?: string;
  /** Read-only hypothetical state from the same gift authority; never persisted to quote +1. */
  giftState?: Awaited<ReturnType<typeof readCartGiftState>>;
}>): Promise<BenefitCheckoutResolution> {
  // Gate OFF: not one statement beyond the legacy checkout's own.
  if (!isGiftQuantityPromotionsEnabled(env)) return { kind: "LEGACY" };

  let state: Awaited<ReturnType<typeof readCartGiftState>>;
  try {
    state = giftState ?? await readCartGiftState(excludeOrderHolds === undefined ? tx : withoutOrderHolds(tx, excludeOrderHolds), cartId, shopId, now, env);
  } catch {
    return { kind: "UNAVAILABLE" };
  }
  const benefits = state.quote.benefits;
  if (!benefits.enabled || !benefits.ok) return { kind: "UNAVAILABLE" };

  const hasTierSegment = hasQuantityTierSegment(benefits.groups);
  const earnsGift = state.entitlements.some((entry) => entry.entitled > 0);
  // EX-21: a tier whose runtime price became invalid is dropped whole. The cart is then an ordinary
  // one, but the buyer was promised that tier at render time, so the quote is still proven and stored
  // in the benefit format: the reason is kept for audit and the buyer reconfirms the new price.
  const droppedForInvalidPrice = benefits.dropped.some((entry) => entry.reason === "TIER_PRICE_INVALID");
  if (!hasTierSegment && state.selections.length === 0 && !earnsGift && !droppedForInvalidPrice) return { kind: "LEGACY" };

  // A stored gift choice that no longer validates is never repaired here.
  if (!state.validation.ok) return { kind: "GIFT_SELECTION_INVALID" };

  const lineByVariantId = new Map((lines ?? state.quote.lines).map((line) => [line.variantId, line]));
  const paidGroups: BenefitQuotePaidGroup[] = [];
  const paid: BenefitPaidRow[] = [];
  for (const group of benefits.groups) {
    const line = lineByVariantId.get(group.lineKey);
    if (line === undefined || !line.available || line.pancakeVariationId === null || line.pancakeVariationId !== group.pancakeVariationId) {
      return { kind: "UNAVAILABLE" };
    }
    paidGroups.push({
      groupKey: group.groupKey,
      pancakeVariationId: group.pancakeVariationId,
      quantity: group.quantity,
      unitPriceVnd: group.unitPriceVnd,
      steps: group.steps.map((step) => ({
        campaignId: step.campaignId,
        source: step.source,
        campaignKind: String(step.kind),
        priority: step.priority,
        inputPriceVnd: step.inputPriceVnd,
        outputPriceVnd: step.outputPriceVnd,
        appliedQuantity: step.appliedQuantity,
      })),
      fulfillmentState: line.isPreorderSale ? "PREORDER" : "READY",
    });
    paid.push({
      variantId: group.lineKey,
      pancakeVariationId: group.pancakeVariationId,
      quantity: group.quantity,
      unitPriceVnd: group.unitPriceVnd,
      lineTotalVnd: group.lineTotalVnd,
      baseUnitPriceVnd: group.basePriceVnd,
      legacyCampaignId: group.steps.find((step) => step.source === "LEGACY")?.campaignId ?? null,
    });
  }

  const giftVariantIds = [...new Set(state.selections.map((selection) => selection.variantId))];
  const giftVariants = giftVariantIds.length === 0
    ? []
    : await tx.variantMirror.findMany({ where: { id: { in: giftVariantIds } }, select: { id: true, pancakeVariationId: true } });
  const externalIdOf = new Map(giftVariants.map((variant) => [variant.id, variant.pancakeVariationId]));
  const preorderVariations = new Set(paidGroups.filter((group) => group.fulfillmentState === "PREORDER").map((group) => group.pancakeVariationId));
  const gifts: BenefitGiftRow[] = [];
  for (const selection of state.selections) {
    const pancakeVariationId = externalIdOf.get(selection.variantId);
    if (pancakeVariationId === undefined) return { kind: "GIFT_SELECTION_INVALID" };
    // A free gift is delivered from READY stock only (ADR 0016 D-04). When the same variation is also
    // bought on a waiting (PREORDER) basis the order has one readiness basis for it (§30), which would
    // make the gift wait too; that is refused rather than quietly promised.
    if (preorderVariations.has(pancakeVariationId)) return { kind: "GIFT_SELECTION_INVALID" };
    gifts.push({ variantId: selection.variantId, pancakeVariationId, campaignId: selection.campaignId, quantity: selection.quantity });
  }

  const quoteGifts: BenefitQuoteGift[] = state.selections.map((selection) => ({
    campaignId: selection.campaignId,
    campaignRevision: selection.campaignRevision,
    pancakeVariationId: externalIdOf.get(selection.variantId)!,
    quantity: selection.quantity,
  }));
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: paidGroups,
    gifts: quoteGifts,
    entitlements: state.validation.summaries.map((summary) => ({
      campaignId: summary.campaignId,
      campaignRevision: summary.revision,
      entitled: summary.entitled,
      selected: summary.selected,
      skippedWhileAvailable: summary.skippedWhileAvailable,
      contendedForSharedStock: summary.contendedForSharedStock,
      shortForStock: summary.shortForStock,
    })),
  });
  if (facts === null) return { kind: "UNAVAILABLE" };
  // The rows the order stores and the facts the buyer proves are two views of the same groups; if they
  // ever disagreed, nothing is written.
  if (paid.reduce((sum, row) => sum + row.lineTotalVnd, 0) !== facts.paidSubtotalVnd) return { kind: "UNAVAILABLE" };

  const droppedAll: DroppedBenefitInput[] = [];
  for (const entry of [...benefits.dropped, ...state.giftStackDropped]) {
    if ((DROPPED_BENEFIT_REASONS as readonly string[]).includes(entry.reason)) {
      droppedAll.push({ campaignId: entry.campaignId, reason: entry.reason as DroppedBenefitInput["reason"], otherCampaignId: entry.otherCampaignId ?? null });
    }
  }
  const labelOf = new Map(state.labels.map((label) => [label.variantId, label]));
  const giftLabels = new Map<string, string>();
  const giftImages = new Map<string, string | null>();
  for (const gift of gifts) {
    const label = labelOf.get(gift.variantId);
    giftLabels.set(gift.pancakeVariationId, label ? [label.productName, label.optionLabel].filter(Boolean).join(" — ") : "Quà tặng");
    giftImages.set(gift.pancakeVariationId, parseTrustedProductImageUrl(label?.imageUrl));
  }
  return { kind: "BENEFIT", facts, paid, gifts, dropped: droppedAll.slice(0, 50), giftLabels, giftImages, campaignNames: benefits.campaignNames };
}

/**
 * The order snapshot input for a proven benefit quote. Pure: it only re-labels the facts the buyer
 * proved with the internal variant ids the server holds, so what is stored is exactly what was signed.
 */
export function toOrderQuoteSnapshotInput({
  facts,
  digest,
  paid,
  gifts,
  dropped,
  acknowledgedAt,
  vendorProjection,
}: Readonly<{
  facts: QuoteStructure;
  digest: string;
  paid: readonly BenefitPaidRow[];
  gifts: readonly BenefitGiftRow[];
  dropped: readonly DroppedBenefitInput[];
  acknowledgedAt: Date | null;
  vendorProjection?: OrderQuoteSnapshotInput["vendorProjection"];
}>): OrderQuoteSnapshotInput | null {
  const variantIdOf = new Map<string, string>();
  for (const row of [...paid, ...gifts]) {
    const known = variantIdOf.get(row.pancakeVariationId);
    if (known !== undefined && known !== row.variantId) return null;
    variantIdOf.set(row.pancakeVariationId, row.variantId);
  }
  const lines: OrderQuoteSnapshotInput["lines"][number][] = [];
  for (const line of facts.lines) {
    const variantId = variantIdOf.get(line.pancakeVariationId);
    if (variantId === undefined) return null;
    lines.push({
      ...line,
      variantId,
      baseUnitPriceVnd: line.role === "GIFT" || line.discountSteps.length === 0 ? null : line.discountSteps[0]!.inputPriceVnd,
    });
  }
  return {
    quoteFormat: "laq3",
    quoteDigest: digest,
    paidSubtotalVnd: facts.paidSubtotalVnd,
    shippingFeeVnd: facts.shippingFeeVnd,
    totalVnd: facts.totalVnd,
    lines,
    entitlements: facts.entitlements,
    acknowledgedAt,
    droppedBenefits: dropped,
    ...(vendorProjection === undefined ? {} : { vendorProjection }),
  };
}
