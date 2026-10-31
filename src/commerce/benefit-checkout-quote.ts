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
import { readGuestShippingPolicy } from "./guest-shipping-policy.ts";
import { readShippingQuote } from "./shipping-campaign-repository.ts";
import type { ShippingQuote } from "./shipping-campaign.ts";
import type { OrderQuoteSnapshotInput, DroppedBenefitInput } from "./order-quote-snapshot.ts";
import { DROPPED_BENEFIT_REASONS } from "./order-quote-snapshot.ts";
import { parseTrustedProductImageUrl } from "./product-media.ts";
import type { QuoteStructure } from "./order-quote-rules.ts";
import type { StorefrontCartLine } from "./storefront-cart.ts";
import { createVoucherHoldService } from "./voucher-hold-service.ts";
import { resolveHeldVoucherCheckout, type CheckoutGroup, type HeldVoucherCheckout } from "./voucher-checkout-quote.ts";
import type { VoucherOrderSnapshot } from "./voucher-order-snapshot.ts";

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
  /** Description from the gift options resolved with this quote; not part of the money proof. */
  productName: string | null;
  color: string | null;
  size: string | null;
}>;

/** V18: the vouchers a BENEFIT quote carries (held, verified against the holds' promise, and expressed in the quote's own lines). */
export type BenefitVoucherPart = Readonly<{
  /** Frozen onto the DRAFT order as its declaration of what it carries. */
  declaration: VoucherOrderSnapshot;
  shippingWaivedVnd: number;
  /** Display only: voucher names by campaign id. */
  names: ReadonlyMap<string, string>;
}>;

export type BenefitCheckoutResolution =
  | Readonly<{ kind: "LEGACY"; shippingQuote: ShippingQuote; /** Live holds exist but no longer describe this cart: not applied. */ voucherStale?: true }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{ kind: "GIFT_SELECTION_INVALID" }>
  | Readonly<{
      kind: "BENEFIT";
      facts: QuoteStructure;
      paid: readonly BenefitPaidRow[];
      gifts: readonly BenefitGiftRow[];
      dropped: readonly DroppedBenefitInput[];
      shippingQuote: ShippingQuote;
      /** Display only (GQ19): `Sản phẩm — Màu / Cỡ` of every chosen gift, by Pancake variation id. Never part of the proof. */
      giftLabels: ReadonlyMap<string, string>;
      /** Display only: each chosen gift's trusted product photo (or null), by Pancake variation id. Never part of the proof. */
      giftImages: ReadonlyMap<string, string | null>;
      /** Display only: the admin-given name of each quantity-tier campaign, by campaign id. Never part of the proof. */
      campaignNames: ReadonlyMap<string, string>;
      /** Stored choices of a lower milestone this quote's higher one replaced. Not in the order; never part of the proof. */
      replacedGifts: readonly Readonly<{ campaignId: string; variantId: string }>[];
      /** Whether the shipping engine was asked with "other promotions apply"; the POS submit re-asks it the same way. */
      shippingHasOtherPromotions: boolean;
      /** Present exactly when held vouchers are part of this quote. */
      voucher: BenefitVoucherPart | null;
      voucherStale?: true;
    }>;

type Env = Readonly<Record<string, string | undefined>>;

type ResolveArgs = Readonly<{
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
  /**
   * V18: apply the vouchers this cart HOLDS. Absent, the quote is exactly what it was before vouchers existed. The
   * secret only derives the attempt key that finds this cart's own holds; it is never part of any quote.
   */
  voucher?: Readonly<{ attemptSecret: string }>;
  /**
   * Observation only. Called with the exception just before a data read (state, vouchers, shipping) is reported as
   * `UNAVAILABLE`, so a caller that must tell a transient infrastructure error from a cart that cannot be quoted can.
   * It never changes what is returned: checkout and the POS submit pass nothing and behave exactly as before.
   */
  onError?: (error: unknown) => void;
}>;

type ResolveOutcome = BenefitCheckoutResolution | Readonly<{ kind: "VOUCHER_STALE" }>;

/**
 * Holds that no longer describe the cart (a price, a selection, a campaign or the shipping decision moved) are never
 * applied: the cart is priced without them and the result says so, so the buyer is asked to hold again instead of
 * being charged for, or promised, a voucher that is gone.
 */
export async function resolveBenefitCheckoutQuote(args: ResolveArgs): Promise<BenefitCheckoutResolution> {
  const first = await resolveOnce(args, true);
  if (first.kind !== "VOUCHER_STALE") return first;
  const plain = await resolveOnce(args, false);
  if (plain.kind === "VOUCHER_STALE") return { kind: "UNAVAILABLE" };
  return plain.kind === "LEGACY" || plain.kind === "BENEFIT" ? { ...plain, voucherStale: true } : plain;
}

async function resolveOnce({
  tx,
  cartId,
  shopId,
  now,
  env = process.env,
  lines,
  excludeOrderHolds,
  giftState,
  voucher,
  onError,
}: ResolveArgs, applyVoucher: boolean): Promise<ResolveOutcome> {
  // Shipping has its own campaign authority; the gift/tier kill switch cannot enable or disable it.
  let shippingPolicy: ReturnType<typeof readGuestShippingPolicy>;
  try { shippingPolicy = readGuestShippingPolicy(env); } catch { return { kind: "UNAVAILABLE" }; }
  if (!isGiftQuantityPromotionsEnabled(env)) {
    if (lines === undefined) return { kind: "UNAVAILABLE" };
    // The benefit pipeline is what prices and sends a held voucher. With it off a live hold cannot be honoured here: the
    // cart is priced plainly AND the result says the holds were set aside, never a silent plain order (the shopper is told).
    if (applyVoucher && voucher !== undefined) {
      let attemptSecret: string | null = null;
      try { attemptSecret = voucher.attemptSecret; } catch { attemptSecret = null; }
      if (attemptSecret !== null) {
        try {
          const own = await createVoucherHoldService(tx as never, { attemptSecret, env }).readOwnLiveHoldFactsIn(tx as never, cartId);
          if (own.length > 0) return { kind: "VOUCHER_STALE" };
        } catch (error) { onError?.(error); return { kind: "UNAVAILABLE" }; }
      }
    }
    try {
      const shippingQuote = await readShippingQuote({ client: tx, shopId, now, paidItems: lines,
        policy: shippingPolicy, hasOtherPromotions: lines.some((line) => line.price !== null && line.basePrice !== undefined && line.price < line.basePrice) });
      return { kind: "LEGACY", shippingQuote };
    } catch (error) { onError?.(error); return { kind: "UNAVAILABLE" }; }
  }

  let state: Awaited<ReturnType<typeof readCartGiftState>>;
  try {
    state = giftState ?? await readCartGiftState(excludeOrderHolds === undefined ? tx : withoutOrderHolds(tx, excludeOrderHolds), cartId, shopId, now, env);
  } catch (error) {
    onError?.(error);
    return { kind: "UNAVAILABLE" };
  }
  const benefits = state.quote.benefits;
  if (!benefits.enabled || !benefits.ok) return { kind: "UNAVAILABLE" };

  // V18: the vouchers this cart holds, applied only while they still describe it (see `resolveBenefitCheckoutQuote`).
  let held: HeldVoucherCheckout = { kind: "NONE" };
  // A server without the secret cannot have granted a hold, so it has none to apply; that is not an outage.
  let attemptSecret: string | null = null;
  if (applyVoucher && voucher !== undefined) {
    try { attemptSecret = voucher.attemptSecret; } catch { attemptSecret = null; }
  }
  if (attemptSecret !== null) {
    try {
      held = await resolveHeldVoucherCheckout({ tx, cartId, shopId, now, env, attemptSecret, giftState: state });
    } catch (error) {
      onError?.(error);
      return { kind: "UNAVAILABLE" };
    }
    if (held.kind === "STALE") return { kind: "VOUCHER_STALE" };
  }
  const applied = held.kind === "APPLIED" ? held : null;
  const groups: readonly CheckoutGroup[] = applied !== null ? applied.groups : benefits.groups;
  // The gift authority's answer on the order's own paid groups: after a voucher it is the post-voucher evaluation.
  const effective = applied !== null
    ? { entitlements: applied.gift.entitlements, selections: applied.gift.active, replaced: applied.gift.replaced, validation: applied.gift.validation, stackDropped: applied.gift.stack.dropped }
    : { entitlements: state.entitlements, selections: state.selections, replaced: state.replacedSelections, validation: state.validation, stackDropped: state.giftStackDropped };

  const hasTierSegment = hasQuantityTierSegment(benefits.groups);
  const earnsGift = effective.entitlements.some((entry) => entry.entitled > 0);
  // EX-21: a tier whose runtime price became invalid is dropped whole. The cart is then an ordinary
  // one, but the buyer was promised that tier at render time, so the quote is still proven and stored
  // in the benefit format: the reason is kept for audit and the buyer reconfirms the new price.
  const droppedForInvalidPrice = benefits.dropped.some((entry) => entry.reason === "TIER_PRICE_INVALID");
  const hasMerchandiseBenefit = hasTierSegment || effective.selections.length > 0 || earnsGift || droppedForInvalidPrice || applied !== null;
  const shippingHasOtherPromotions = applied !== null
    ? applied.shippingHasOtherPromotions
    : state.selections.length > 0 || benefits.groups.some((group) => group.steps.some((step) => step.outputPriceVnd < step.inputPriceVnd));
  let shippingQuote: ShippingQuote;
  try {
    shippingQuote = await readShippingQuote({ client: tx, shopId, now, policy: shippingPolicy,
      paidItems: hasMerchandiseBenefit
        ? groups.map((group) => ({ variantId: group.lineKey, quantity: group.quantity }))
        : (lines ?? state.quote.lines),
      hasOtherPromotions: shippingHasOtherPromotions,
    });
  } catch (error) { onError?.(error); return { kind: "UNAVAILABLE" }; }
  // The holds promised a specific fee before the shipping waiver; if the shipping decision moved, they no longer apply.
  if (applied !== null && shippingQuote.feeVnd !== applied.quote.shippingFeeBeforeVoucherVnd) return { kind: "VOUCHER_STALE" };
  // Shipping alone stays in the ordinary proof format and does not require POS split-price capability.
  if (!hasMerchandiseBenefit) return { kind: "LEGACY", shippingQuote };

  // A stored gift choice that no longer validates is never repaired here.
  if (!effective.validation.ok) return { kind: "GIFT_SELECTION_INVALID" };

  const lineByVariantId = new Map((lines ?? state.quote.lines).map((line) => [line.variantId, line]));
  const paidGroups: BenefitQuotePaidGroup[] = [];
  const paid: BenefitPaidRow[] = [];
  for (const group of groups) {
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

  const giftVariantIds = [...new Set(effective.selections.map((selection) => selection.variantId))];
  const giftVariants = giftVariantIds.length === 0
    ? []
    : await tx.variantMirror.findMany({ where: { id: { in: giftVariantIds } }, select: { id: true, pancakeVariationId: true } });
  const externalIdOf = new Map(giftVariants.map((variant) => [variant.id, variant.pancakeVariationId]));
  const preorderVariations = new Set(paidGroups.filter((group) => group.fulfillmentState === "PREORDER").map((group) => group.pancakeVariationId));
  const gifts: BenefitGiftRow[] = [];
  const labelOf = new Map(state.labels.map((label) => [label.variantId, label]));
  for (const selection of effective.selections) {
    const pancakeVariationId = externalIdOf.get(selection.variantId);
    if (pancakeVariationId === undefined) return { kind: "GIFT_SELECTION_INVALID" };
    // A free gift is delivered from READY stock only (ADR 0016 D-04). When the same variation is also
    // bought on a waiting (PREORDER) basis the order has one readiness basis for it (§30), which would
    // make the gift wait too; that is refused rather than quietly promised.
    if (preorderVariations.has(pancakeVariationId)) return { kind: "GIFT_SELECTION_INVALID" };
    const label = labelOf.get(selection.variantId);
    gifts.push({ variantId: selection.variantId, pancakeVariationId, campaignId: selection.campaignId, quantity: selection.quantity,
      productName: label?.productName ?? null, color: label?.color ?? null, size: label?.size ?? null,
    });
  }

  const quoteGifts: BenefitQuoteGift[] = effective.selections.map((selection) => ({
    campaignId: selection.campaignId,
    campaignRevision: selection.campaignRevision,
    pancakeVariationId: externalIdOf.get(selection.variantId)!,
    quantity: selection.quantity,
  }));
  const facts = buildBenefitCheckoutQuoteFacts({
    paid: paidGroups,
    gifts: quoteGifts,
    shippingQuote,
    shippingPolicy,
    shippingWaivedVnd: applied?.shippingWaivedVnd ?? 0,
    entitlements: effective.validation.summaries.map((summary) => ({
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
  for (const entry of [...benefits.dropped, ...effective.stackDropped]) {
    if ((DROPPED_BENEFIT_REASONS as readonly string[]).includes(entry.reason)) {
      droppedAll.push({ campaignId: entry.campaignId, reason: entry.reason as DroppedBenefitInput["reason"], otherCampaignId: entry.otherCampaignId ?? null });
    }
  }
  const giftLabels = new Map<string, string>();
  const giftImages = new Map<string, string | null>();
  for (const gift of gifts) {
    const label = labelOf.get(gift.variantId);
    giftLabels.set(gift.pancakeVariationId, label ? [label.productName, label.optionLabel].filter(Boolean).join(" — ") : "Quà tặng");
    giftImages.set(gift.pancakeVariationId, parseTrustedProductImageUrl(label?.imageUrl));
  }
  return {
    kind: "BENEFIT",
    facts,
    paid,
    gifts,
    dropped: droppedAll.slice(0, 50),
    shippingQuote,
    giftLabels,
    giftImages,
    campaignNames: benefits.campaignNames,
    replacedGifts: effective.replaced.map(({ campaignId, variantId }) => ({ campaignId, variantId })),
    shippingHasOtherPromotions,
    voucher: applied === null ? null : { declaration: applied.declaration, shippingWaivedVnd: applied.shippingWaivedVnd, names: applied.cardNames },
  };
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
