/** SPEC-UPS-001: opportunity policy only. All prices/rungs still come from the canonical engine. */
import type { CartGiftState } from "./cart-gift-selection.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { buildScopeResolver } from "./gift-quantity-scope.ts";
import { orderValueTierInputSubtotal } from "./gift-quantity-stack.ts";
import { validateTierConfig } from "./gift-quantity-tier.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";

export function isPromotionUpsellEnabled(shopId: number, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.LA_PROMOTION_UPSELL_ENABLED === "true" && isGiftQuantityPromotionsEnabled(env)
    && readLineLevelPricingVerifiedShopIds(env).includes(shopId);
}

export type UpsellOpportunity = Readonly<{ campaignId: string; revision: number; kind: "GIFT_ITEM" | "QUANTITY_TIER"; threshold: number }>;
export function isNearMoney(current: number, next: number): boolean {
  return Number.isSafeInteger(current) && Number.isSafeInteger(next) && current >= 0 && next > current
    && BigInt(current) * BigInt(5) >= BigInt(next) * BigInt(4);
}

export function findUpsellOpportunities(state: CartGiftState): UpsellOpportunity[] {
  const benefits = state.quote.benefits;
  if (!benefits.enabled || !benefits.ok || !state.validation.ok || state.quote.lines.some((line) => !line.available)) return [];
  const dropped = new Set([...benefits.dropped, ...state.giftStackDropped].map((entry) => entry.campaignId));
  return state.campaignEntries.flatMap(({ campaign: c, scope, frozen }): UpsellOpportunity[] => {
    if (dropped.has(c.id)) return [];
    let threshold: number | undefined;
    let near = false;
    if (c.kind === "GIFT_ITEM") {
      const e = state.entitlements.find((entry) => entry.campaignId === c.id);
      if (!e?.shortfallToNext) return [];
      if (c.giftTrigger === "QUANTITY") {
        near = e.shortfallToNext.quantity === 1;
        threshold = e.eligibleQuantity + (e.shortfallToNext.quantity ?? 0);
      } else {
        threshold = e.eligibleSubtotalVnd + (e.shortfallToNext.subtotalVnd ?? 0);
        near = isNearMoney(e.eligibleSubtotalVnd, threshold);
      }
    } else {
      const config = { basis: c.tierBasis ?? "QUANTITY", unit: c.tierUnit!, discountedUnits: c.tierDiscountedUnits!, selectionPriority: c.tierSelectionPriority, tiers: c.tiers };
      if (validateTierConfig(config).length) return [];
      if (c.tierBasis === "ORDER_SUBTOTAL") {
        const progress = benefits.orderValueProgress.find((entry) => entry.campaignId === c.id);
        if (!progress) return [];
        const reached = c.tiers.find((step) => step.minQuantity === progress.reachedThresholdVnd);
        if (reached && progress.next.value <= reached.discountValue) return [];
        threshold = progress.next.thresholdVnd;
        near = isNearMoney(progress.currentVnd, threshold);
      } else {
        const resolve = buildScopeResolver(scope, frozen);
        const productOf = new Map(state.paidVariants.map((v) => [v.id, state.productFacts.find((p) => p.productId === v.productId)!]));
        const quantity = state.items.reduce((sum, item) => sum + (resolve(productOf.get(item.variantId)!) ? item.quantity : 0), 0);
        const reached = [...c.tiers].reverse().find((step) => step.minQuantity <= quantity);
        const next = c.tiers.find((step) => step.minQuantity > quantity);
        if (reached && next && next.discountValue <= reached.discountValue) return [];
        threshold = next?.minQuantity;
        near = threshold !== undefined && threshold - quantity === 1;
      }
    }
    return near && threshold !== undefined ? [{ campaignId: c.id, revision: c.revision, kind: c.kind, threshold }] : [];
  });
}

function savings(state: CartGiftState, campaignId: string, variantId?: string): number {
  const b = state.quote.benefits;
  if (!b.enabled || !b.ok) return 0;
  // A later tier can split a group while inherited audit steps keep their original appliedQuantity.
  // Each final segment carries the per-unit step on that segment's own units.
  return b.groups.filter((g) => variantId === undefined || g.lineKey === variantId).reduce((sum, g) => sum + g.steps
    .filter((s) => s.campaignId === campaignId)
    .reduce((n, s) => n + (s.inputPriceVnd - s.outputPriceVnd) * g.quantity, 0), 0);
}

/** Per-campaign preservation, including each old line's legacy/tier savings and every stored choice. */
export function preservesUpsellBenefits(before: CartGiftState, after: CartGiftState): boolean {
  const b = before.quote.benefits, a = after.quote.benefits;
  if (!b.enabled || !b.ok || !a.enabled || !a.ok || !after.validation.ok || after.quote.lines.some((line) => !line.available)
    || a.dropped.some((entry) => entry.reason === "TIER_PRICE_INVALID")) return false;
  for (const e of before.entitlements) {
    const next = after.entitlements.find((row) => row.campaignId === e.campaignId);
    if (!next || next.revision !== e.revision || next.entitled < e.entitled || next.grantable < e.grantable) return false;
  }
  for (const item of before.items) {
    const campaigns = new Set(b.groups.filter((g) => g.lineKey === item.variantId).flatMap((g) => g.steps.map((s) => s.campaignId)));
    for (const id of campaigns) if (savings(after, id, item.variantId) < savings(before, id, item.variantId)) return false;
  }
  return before.selections.every((row) => after.selections.some((next) => next.campaignId === row.campaignId && next.variantId === row.variantId && next.quantity === row.quantity && next.campaignRevision === row.campaignRevision));
}

export function unlocksUpsellOpportunity(before: CartGiftState, after: CartGiftState, opportunity: UpsellOpportunity): boolean {
  if (!preservesUpsellBenefits(before, after)) return false;
  if (opportunity.kind === "GIFT_ITEM") {
    const b = before.entitlements.find((e) => e.campaignId === opportunity.campaignId);
    const a = after.entitlements.find((e) => e.campaignId === opportunity.campaignId);
    return !!b && !!a && a.revision === opportunity.revision && a.entitled > b.entitled && a.grantable > b.grantable;
  }
  const b = after.quote.benefits;
  const campaign = after.campaignEntries.find((e) => e.campaign.id === opportunity.campaignId)?.campaign;
  if (!b.enabled || !b.ok || !campaign || campaign.revision !== opportunity.revision) return false;
  if (campaign.tierBasis === "ORDER_SUBTOTAL") {
    const current = orderValueTierInputSubtotal(b.groups, campaign.id, after.campaignEntries.filter((e) => e.campaign.kind === "QUANTITY_TIER" && e.campaign.tierBasis === "ORDER_SUBTOTAL").map((e) => ({ id: e.campaign.id, priority: e.campaign.stackPriority })));
    if (current < opportunity.threshold) return false;
  }
  return b.enabled && b.ok && !b.dropped.some((e) => e.campaignId === opportunity.campaignId)
    && savings(after, opportunity.campaignId) > savings(before, opportunity.campaignId);
}

export function compareUpsellCandidates(a: { deltaVnd: number; campaignId: string; productId: string; variantId: string }, b: { deltaVnd: number; campaignId: string; productId: string; variantId: string }): number {
  const text = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return a.deltaVnd - b.deltaVnd || text(a.campaignId, b.campaignId) || text(a.productId, b.productId) || text(a.variantId, b.variantId);
}
