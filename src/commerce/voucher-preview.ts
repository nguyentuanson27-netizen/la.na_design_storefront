import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { MAX_CATEGORY_MEMBERSHIPS } from "./category-taxonomy.ts";
import { readCartGiftState } from "./cart-gift-selection.ts";
import type { StackedGroup } from "./gift-quantity-stack.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { readGuestShippingPolicy } from "./guest-shipping-policy.ts";
import { createVoucherPosFeasibility } from "./pancake-voucher-projection.ts";
import { lockShippingCampaignRead } from "./shipping-campaign-lock.ts";
import { evaluateShippingCampaigns, MAX_SHIPPING_QUOTE_LINES } from "./shipping-campaign.ts";
import { readActiveShippingCampaigns } from "./shipping-campaign-repository.ts";
import { createStorefrontCartRepository, type StorefrontCartReadClient } from "./storefront-cart-repository.ts";
import type { VoucherPaidLine } from "./voucher-allocation.ts";
import { toVoucherCampaign, voucherCampaignSelection, type VoucherCampaign } from "./voucher-campaign.ts";
import { readPublicVoucherCandidates, readSelectedVouchers, toVoucherCard, type VoucherCard } from "./voucher-candidate-repository.ts";
import { canIssueNewVouchers } from "./voucher-gate.ts";
import type { GiftOutcome, VoucherSelectionIntent } from "./voucher-optimizer.ts";
import { buildVoucherQuote, type VoucherCardState, type VoucherQuote } from "./voucher-quote.ts";
import { buildVoucherQuoteFacts } from "./voucher-quote-facts.ts";
import { selectionIntentFromRow } from "./voucher-selection-service.ts";

/**
 * Voucher v1 (V08): reads one cart and answers "what do the vouchers do to it", read-only.
 *
 * It assembles the facts the pure `buildVoucherQuote` needs from the authorities that already own them -- the cart
 * and gift state (post-legacy, post-tier prices and the gift entitlements, ADR 0016 D-12 / TG-11 A), the shipping
 * campaigns (evaluated per candidate for TG-10 B), the shop's voucher candidates and the cart's saved selection --
 * inside ONE repeatable-read transaction, so price, campaigns and clock are one snapshot. It writes nothing: no
 * hold, no selection, no counter (spec §5.1). With the feature flag OFF it returns `{ enabled: false }` without
 * reading anything, and the cart/checkout stay exactly as they are.
 *
 * The result is a PREVIEW. A submit-capable, held quote is V12 and needs H1-V; this module cannot produce one.
 */

export type VoucherPreview =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; ok: false; reason: "CART_UNAVAILABLE" | "QUOTE_UNAVAILABLE" | "NO_VOUCHER_QUOTE" }>
  | Readonly<{
      enabled: true;
      ok: true;
      quote: Extract<VoucherQuote, { ok: true }>;
      /** Shopper-safe facts per campaign plus its state in this quote, in the order the picker lists them. */
      entries: readonly Readonly<{ card: VoucherCard; state: VoucherCardState }>[];
      selectionIntent: VoucherSelectionIntent;
      campaigns: readonly VoucherCampaign[];
      lines: readonly VoucherPaidLine[];
      /** The cart's monotonic paid-line version, for the proof (ABA guard). */
      paidRevision: bigint;
      /** Pancake variation of each paid line id, for the exact-money check before a hold (V12). */
      variationOfLine: ReadonlyMap<string, string>;
      /** Digest of this exact quote (what a buyer consents to and a hold stores); null if it cannot be expressed as proof facts. */
      quoteDigest: string | null;
    }>;

/** A live hold of THIS checkout attempt: its entitlement is its own, so it neither counts against nor is lost to the caps. */
export type OwnVoucherHold = Readonly<{ campaignId: string; campaignRevision: number; heldDiscountVnd: number }>;

const UNSET_LIMIT = 200;

function stripVoucherSuffix(lineId: string): string {
  return lineId.replace(/\|v\d+$/, "");
}

export async function readVoucherPreview(input: Readonly<{
  client: PrismaClient;
  cartId: string;
  shopId: number;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
  /** A draft the shopper is looking at in the picker: previewed as if chosen, never saved. */
  selectionOverride?: VoucherSelectionIntent;
  /** Live holds of this cart's own attempt (TG-05 A / AC-31 / AC-33): kept in play even if the campaign has since ended or filled. */
  ownHolds?: readonly OwnVoucherHold[];
}>): Promise<VoucherPreview> {
  const { client, cartId, shopId, now } = input;
  const env = input.env ?? process.env;
  if (!canIssueNewVouchers(env)) return { enabled: false };
  try {
    return await client.$transaction((tx) => readInTransaction(tx, { cartId, shopId, now, env, selectionOverride: input.selectionOverride, ownHolds: input.ownHolds ?? [] }), { isolationLevel: "RepeatableRead" });
  } catch {
    // A read that cannot complete is "unavailable", never "no voucher": the caller keeps the plain cart and says so.
    return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };
  }
}

async function readInTransaction(
  tx: Prisma.TransactionClient,
  { cartId, shopId, now, env, selectionOverride, ownHolds }: Readonly<{ cartId: string; shopId: number; now: Date; env: Readonly<Record<string, string | undefined>>; selectionOverride: VoucherSelectionIntent | undefined; ownHolds: readonly OwnVoucherHold[] }>,
): Promise<VoucherPreview> {
  const cart = await tx.cart.findFirst({
    where: { id: cartId, userId: null, expiresAt: { gt: now } },
    select: { paidRevision: true, items: { select: { variantId: true, quantity: true, sourceProductSlug: true } } },
  });
  if (cart === null || cart.items.length === 0) return { enabled: true, ok: false, reason: "CART_UNAVAILABLE" };

  // 1. Post-legacy, post-tier paid prices (the base every voucher shares) and the gift authority.
  type Priced = { lineId: string; variantId: string; quantity: number; unitPriceVnd: number };
  const priced: Priced[] = [];
  let existingOtherPromotions: boolean;
  let giftOf: ((lines: readonly VoucherPaidLine[]) => GiftOutcome) | null = null;
  let stackedGroups: readonly StackedGroup[] = [];
  let giftState: Awaited<ReturnType<typeof readCartGiftState>> | null = null;

  if (isGiftQuantityPromotionsEnabled(env)) {
    giftState = await readCartGiftState(tx, cartId, shopId, now, env);
    const benefits = giftState.quote.benefits;
    if (!benefits.enabled || !benefits.ok) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };
    stackedGroups = benefits.groups;
    for (const group of benefits.groups) priced.push({ lineId: group.groupKey, variantId: group.lineKey, quantity: group.quantity, unitPriceVnd: group.unitPriceVnd });
    existingOtherPromotions =
      giftState.selections.length > 0 || benefits.groups.some((group) => group.steps.some((step) => step.outputPriceVnd < step.inputPriceVnd));
  } else {
    const lines = await createStorefrontCartRepository(tx as unknown as StorefrontCartReadClient).getLines({ shopId, items: cart.items, now });
    for (const line of lines) {
      if (!line.available || line.price === null || line.price < 1) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };
      priced.push({ lineId: line.variantId, variantId: line.variantId, quantity: line.quantity, unitPriceVnd: line.price });
    }
    existingOtherPromotions = lines.some((line) => line.basePrice !== undefined && line.price !== null && line.price < line.basePrice);
  }
  if (priced.length === 0 || priced.length > MAX_SHIPPING_QUOTE_LINES) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };

  // 2. Identity of each line's product and its category membership (bounded), for scope.
  const variantIds = [...new Set(priced.map((line) => line.variantId))];
  const variants = await tx.variantMirror.findMany({
    where: { id: { in: variantIds }, product: { pancakeShopId: shopId } },
    select: { id: true, productId: true, pancakeVariationId: true },
  });
  if (variants.length !== variantIds.length) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };
  const productIds = [...new Set(variants.map((variant) => variant.productId))];
  const membershipLimit = productIds.length * MAX_CATEGORY_MEMBERSHIPS;
  const membership = await tx.productCategoryMembership.findMany({ where: { productId: { in: productIds } }, select: { productId: true, categoryKey: true }, take: membershipLimit + 1 });
  if (membership.length > membershipLimit) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };
  const categories = new Map(productIds.map((id) => [id, [] as string[]]));
  for (const row of membership) categories.get(row.productId)?.push(row.categoryKey);
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const factsOf = (variantId: string) => {
    const variant = variantById.get(variantId)!;
    return { productId: variant.productId, shopId: String(shopId), categoryKeys: categories.get(variant.productId)! };
  };
  const lines: VoucherPaidLine[] = priced.map((line) => ({ lineId: line.lineId, product: factsOf(line.variantId), quantity: line.quantity, unitPriceVnd: line.unitPriceVnd }));

  // 3. Gifts after a voucher, from the same authority the cart used (only when gifts exist at all).
  if (giftState !== null) {
    const state = giftState;
    const groupByKey = new Map(stackedGroups.map((group) => [group.groupKey, group]));
    giftOf = (after) => {
      const groups: StackedGroup[] = after.map((line) => {
        const source = groupByKey.get(stripVoucherSuffix(line.lineId))!;
        return { ...source, groupKey: line.lineId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd, lineTotalVnd: line.quantity * line.unitPriceVnd };
      });
      const evaluated = state.evaluateGifts(groups);
      const entitled = new Map(evaluated.entitlements.map((entry) => [entry.campaignId, entry.entitled]));
      const selectedBy = new Map<string, number>();
      for (const choice of evaluated.active) selectedBy.set(choice.campaignId, (selectedBy.get(choice.campaignId) ?? 0) + choice.quantity);
      let retained = 0;
      for (const [campaignId, selected] of selectedBy) retained += Math.min(selected, entitled.get(campaignId) ?? 0);
      return { entitledSlots: evaluated.entitlements.reduce((sum, entry) => sum + entry.entitled, 0), retainedSelectedSlots: retained };
    };
  }

  // 4. Shipping: the campaign engine's fee per `hasOtherPromotions`, on this cart's paid lines.
  let policy: ReturnType<typeof readGuestShippingPolicy>;
  try { policy = readGuestShippingPolicy(env); } catch { return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" }; }
  await lockShippingCampaignRead(tx, shopId);
  const shippingCampaigns = await readActiveShippingCampaigns(tx, shopId, now);
  const shippingLines = priced.map((line) => ({ role: "PAID" as const, product: { productId: factsOf(line.variantId).productId, categoryKeys: factsOf(line.variantId).categoryKeys }, quantity: line.quantity }));
  const campaignShippingFeeVnd = (hasOtherPromotions: boolean) =>
    evaluateShippingCampaigns({ campaigns: shippingCampaigns, lines: shippingLines, policy, now, hasOtherPromotions }).feeVnd;

  // 5. Candidates (public + any saved manual choice, which may be a private one) and the saved intent.
  const saved = await tx.cartVoucherSelection.findUnique({ where: { cartId } });
  const selectionIntent = selectionOverride ?? selectionIntentFromRow(saved, now);
  const wantedIds = [selectionIntent.merchandise, selectionIntent.shipping].flatMap((group) => (group.mode === "MANUAL" && group.voucherId !== null ? [group.voucherId] : []));
  const [publicCampaigns, savedCampaigns] = await Promise.all([
    readPublicVoucherCandidates({ client: tx, shopId, now, env }),
    readSelectedVouchers({ client: tx, shopId, ids: wantedIds, now, env }),
  ]);
  const byId = new Map([...publicCampaigns, ...savedCampaigns].map((campaign) => [campaign.id, campaign]));
  if (ownHolds.length > 0) {
    // An entitlement this attempt already holds stays in play although the campaign has since ended, been
    // switched off or filled up (TG-05 A): load it whatever its lifecycle, and credit back the use and VND the
    // hold itself reserves so it is not counted against its own holder. A PRIVATE one is kept only while the
    // shopper's own manual choice still names it; an edited campaign (new revision) is not the held entitlement.
    const rows = await tx.voucherCampaign.findMany({ where: { id: { in: ownHolds.map((hold) => hold.campaignId) }, pancakeShopId: shopId }, select: voucherCampaignSelection });
    for (const row of rows) {
      const hold = ownHolds.find((candidate) => candidate.campaignId === row.id)!;
      let campaign = byId.get(row.id);
      if (campaign === undefined) {
        const chosen = [selectionIntent.merchandise, selectionIntent.shipping].some((group) => group.mode === "MANUAL" && group.voucherId === row.id);
        if (row.revision !== hold.campaignRevision || (row.visibility === "PRIVATE" && !chosen)) continue;
        try { campaign = toVoucherCampaign(row); } catch { continue; }
      }
      byId.set(row.id, { ...campaign, reservedUses: Math.max(0, campaign.reservedUses - 1), reservedVnd: Math.max(0, campaign.reservedVnd - hold.heldDiscountVnd) });
    }
  }
  const campaigns = [...byId.values()];
  if (campaigns.length > UNSET_LIMIT) return { enabled: true, ok: false, reason: "QUOTE_UNAVAILABLE" };

  const variationOfLine = new Map(priced.map((line) => [line.lineId, variantById.get(line.variantId)!.pancakeVariationId]));
  const quote = buildVoucherQuote({
    lines,
    campaigns,
    selection: selectionIntent,
    existingOtherPromotions,
    campaignShippingFeeVnd,
    giftOutcome: giftOf ?? (() => ({ entitledSlots: 0, retainedSelectedSlots: 0 })),
    // Representability only; the gift units' variations do not change whether the vendor can take the money.
    isFeasibleOnLines: createVoucherPosFeasibility({
      variationOfLine,
      giftsOf: (evaluation) => (evaluation.gifts.retainedSelectedSlots > 0 ? [{ pancakeVariationId: "gift-units", quantity: evaluation.gifts.retainedSelectedSlots }] : []),
    }),
  });
  if (!quote.ok) return { enabled: true, ok: false, reason: "NO_VOUCHER_QUOTE" };

  const cardById = new Map(campaigns.map((campaign) => [campaign.id, toVoucherCard(campaign)]));
  const entries = quote.cards.map((state) => ({ card: cardById.get(state.campaignId)!, state }));
  return {
    enabled: true, ok: true, quote, entries, selectionIntent, campaigns, lines, paidRevision: cart.paidRevision, variationOfLine,
    quoteDigest: buildVoucherQuoteFacts({ quote, campaigns, lines, variationOfLine, paidRevision: cart.paidRevision })?.digest ?? null,
  };
}
