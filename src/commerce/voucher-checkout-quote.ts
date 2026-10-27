import type { Prisma } from "../generated/prisma/client.ts";

import type { readCartGiftState } from "./cart-gift-selection.ts";
import type { StackedGroup } from "./gift-quantity-stack.ts";
import { createVoucherHoldService } from "./voucher-hold-service.ts";
import { buildVoucherOrderSnapshot, type VoucherOrderSnapshot } from "./voucher-order-snapshot.ts";
import { readVoucherPreviewWithin } from "./voucher-preview.ts";
import type { VoucherQuote } from "./voucher-quote.ts";
import { applyAllocationToLines } from "./voucher-quote.ts";

/**
 * Voucher v1 (V18): what the vouchers a cart HOLDS do to its checkout quote.
 *
 * Checkout never applies a voucher the shopper merely picked; it applies exactly the live holds of this cart's own
 * attempt (V12), and only if the quote the holds promised is still the quote the server derives now. It reuses the
 * preview (so cart, picker, hold and checkout are one derivation) on the gift authority the checkout already read,
 * then expresses the result in the structures the benefit pipeline already proves, stores and sends to the POS:
 *
 *  - each line the merchandise voucher touched becomes up to two price segments, each carrying the line's earlier
 *    discount steps plus one final `VOUCHER` step (base -> ... -> price the buyer pays);
 *  - the gifts and entitlements are evaluated again on those post-voucher groups, with the very authority the cart
 *    uses (a voucher that drops the cart below a gift threshold shows up here, never as a silent change);
 *  - a shipping voucher is a named waiver of the fee the shipping engine decided, not a rewrite of that decision.
 *
 * Result kinds: `NONE` (no live hold: the cart is priced without vouchers), `STALE` (holds exist but the quote they
 * promised no longer holds: checkout must not apply them and the buyer must hold again) and `APPLIED`.
 */

/** A discount step of an ORDER line: the stack's own steps plus the voucher's, which is always last. */
export type CheckoutStep = Readonly<{
  campaignId: string;
  source: "LEGACY" | "QUANTITY_TIER" | "VOUCHER";
  kind: string;
  priority: number | null;
  inputPriceVnd: number;
  outputPriceVnd: number;
  appliedQuantity: number;
}>;

/** A paid group of the order: a stacked group re-priced by the voucher allocation. */
export type CheckoutGroup = Readonly<{
  groupKey: string;
  lineKey: string;
  pancakeVariationId: string;
  quantity: number;
  basePriceVnd: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  steps: readonly CheckoutStep[];
}>;

export type HeldVoucherCheckout =
  | Readonly<{ kind: "NONE" }>
  | Readonly<{ kind: "STALE"; reason: "PREVIEW_UNAVAILABLE" | "QUOTE_CHANGED" }>
  | Readonly<{
      kind: "APPLIED";
      quote: Extract<VoucherQuote, { ok: true }>;
      /** Post-voucher groups: what the order's paid lines are made from. */
      groups: readonly CheckoutGroup[];
      /** The gift authority's answer on those groups. */
      gift: ReturnType<Awaited<ReturnType<typeof readCartGiftState>>["evaluateGifts"]>;
      /** Whether the shipping engine must treat the cart as already promoted (a tier, a gift or a merchandise voucher). */
      shippingHasOtherPromotions: boolean;
      shippingWaivedVnd: number;
      /** Frozen onto the DRAFT order as its declaration of what it carries. */
      declaration: VoucherOrderSnapshot;
      /** Display only: the voucher cards by campaign id. */
      cardNames: ReadonlyMap<string, string>;
    }>;

const stripSegment = (lineId: string) => lineId.replace(/\|v\d+$/, "");

/**
 * What the gifts would be after the voucher a PREVIEW chose (nothing is held yet): the gift authority run on the cart's
 * groups re-priced by the preview's allocation, exactly like the held path below. Null when the preview carries no gift
 * authority or a line cannot be matched to its group (the caller treats that as "the quote changed").
 */
export function giftsAfterVoucher(preview: Readonly<{
  giftState: Awaited<ReturnType<typeof readCartGiftState>> | null;
  stackedGroups: readonly StackedGroup[];
  lines: Parameters<typeof applyAllocationToLines>[0];
  quote: Extract<VoucherQuote, { ok: true }>;
}>): ReturnType<Awaited<ReturnType<typeof readCartGiftState>>["evaluateGifts"]> | null {
  if (preview.giftState === null) return null;
  const groupByKey = new Map(preview.stackedGroups.map((group) => [group.groupKey, group]));
  const stackGroups: StackedGroup[] = [];
  for (const line of applyAllocationToLines(preview.lines, preview.quote.allocation)) {
    const source = groupByKey.get(stripSegment(line.lineId));
    if (source === undefined) return null;
    stackGroups.push({ ...source, groupKey: line.lineId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd, lineTotalVnd: line.quantity * line.unitPriceVnd });
  }
  return preview.giftState.evaluateGifts(stackGroups);
}

export async function resolveHeldVoucherCheckout(input: Readonly<{
  tx: Prisma.TransactionClient;
  cartId: string;
  shopId: number;
  now: Date;
  env: Readonly<Record<string, string | undefined>>;
  attemptSecret: string;
  giftState: Awaited<ReturnType<typeof readCartGiftState>>;
}>): Promise<HeldVoucherCheckout> {
  const { tx, cartId, shopId, now, env, giftState } = input;
  const holdService = createVoucherHoldService(tx as never, { attemptSecret: input.attemptSecret, env });
  const holds = await holdService.readOwnLiveHoldFactsIn(tx as never, cartId);
  if (holds.length === 0) return { kind: "NONE" };

  const heldOf = (kind: "MERCHANDISE" | "SHIPPING_FREE") => holds.find((hold) => hold.kind === kind) ?? null;
  const merchandise = heldOf("MERCHANDISE");
  const shipping = heldOf("SHIPPING_FREE");
  // Exactly the held vouchers: a group without a hold is an explicit NONE, never an AUTO that could add a voucher
  // the buyer was not shown.
  const selectionOverride = {
    merchandise: { mode: "MANUAL", voucherId: merchandise?.campaignId ?? null },
    shipping: { mode: "MANUAL", voucherId: shipping?.campaignId ?? null },
  } as const;
  const preview = await readVoucherPreviewWithin(tx, {
    cartId, shopId, now, env, selectionOverride, giftState,
    ownHolds: holds.map((hold) => ({ campaignId: hold.campaignId, campaignRevision: hold.campaignRevision, heldDiscountVnd: hold.heldDiscountVnd })),
  });
  if (!preview.enabled || !preview.ok || preview.quoteDigest === null || !preview.giftState) return { kind: "STALE", reason: "PREVIEW_UNAVAILABLE" };

  const quote = preview.quote;
  const campaign = new Map(preview.campaigns.map((entry) => [entry.id, entry]));
  const same =
    quote.selection.merchandiseId === (merchandise?.campaignId ?? null) &&
    quote.selection.shippingId === (shipping?.campaignId ?? null) &&
    quote.merchandiseDiscountVnd === (merchandise?.heldDiscountVnd ?? 0) &&
    quote.shippingDiscountVnd === (shipping?.heldDiscountVnd ?? 0) &&
    holds.every((hold) => hold.paidRevision === preview.paidRevision && hold.quoteDigest === preview.quoteDigest && campaign.get(hold.campaignId)?.revision === hold.campaignRevision);
  if (!same || (merchandise === null && shipping === null)) return { kind: "STALE", reason: "QUOTE_CHANGED" };

  // Post-voucher groups: the allocation's segments of each line, each keeping the line's earlier steps.
  const groupByKey = new Map(preview.stackedGroups.map((group) => [group.groupKey, group]));
  const groups: CheckoutGroup[] = [];
  const stackGroups: StackedGroup[] = [];
  for (const line of applyAllocationToLines(preview.lines, quote.allocation)) {
    const source = groupByKey.get(stripSegment(line.lineId));
    if (source === undefined) return { kind: "STALE", reason: "QUOTE_CHANGED" };
    const inherited: CheckoutStep[] = source.steps.map((step) => ({
      campaignId: step.campaignId, source: step.source, kind: String(step.kind), priority: step.priority,
      inputPriceVnd: step.inputPriceVnd, outputPriceVnd: step.outputPriceVnd, appliedQuantity: step.appliedQuantity,
    }));
    const voucherStep: CheckoutStep | null =
      merchandise === null || line.unitPriceVnd >= source.unitPriceVnd
        ? null
        : { campaignId: merchandise.campaignId, source: "VOUCHER", kind: "VOUCHER_MERCHANDISE", priority: null, inputPriceVnd: source.unitPriceVnd, outputPriceVnd: line.unitPriceVnd, appliedQuantity: line.quantity };
    groups.push({
      groupKey: line.lineId,
      lineKey: source.lineKey,
      pancakeVariationId: source.pancakeVariationId,
      quantity: line.quantity,
      basePriceVnd: source.basePriceVnd,
      unitPriceVnd: line.unitPriceVnd,
      lineTotalVnd: line.quantity * line.unitPriceVnd,
      steps: voucherStep === null ? inherited : [...inherited, voucherStep],
    });
    // The gift authority reads quantities and totals, not step provenance: it gets the same group re-priced.
    stackGroups.push({ ...source, groupKey: line.lineId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd, lineTotalVnd: line.quantity * line.unitPriceVnd });
  }
  const gift = giftState.evaluateGifts(stackGroups);

  const revisions = new Map(holds.map((hold) => [hold.campaignId, hold.campaignRevision]));
  let declaration: VoucherOrderSnapshot;
  try {
    declaration = buildVoucherOrderSnapshot({ quote, revisions });
  } catch {
    return { kind: "STALE", reason: "QUOTE_CHANGED" };
  }
  const existingOther =
    giftState.selections.length > 0 || giftState.quote.benefits.enabled && giftState.quote.benefits.ok && giftState.quote.benefits.groups.some((group) => group.steps.some((step) => step.outputPriceVnd < step.inputPriceVnd));
  return {
    kind: "APPLIED",
    quote,
    groups,
    gift,
    shippingHasOtherPromotions: existingOther || quote.merchandiseDiscountVnd > 0,
    shippingWaivedVnd: quote.shippingDiscountVnd,
    declaration,
    cardNames: new Map(preview.entries.map((entry) => [entry.card.id, entry.card.name])),
  };
}
