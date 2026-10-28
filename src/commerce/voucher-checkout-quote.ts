import type { Prisma } from "../generated/prisma/client.ts";

import type { readCartGiftState } from "./cart-gift-selection.ts";
import type { StackedGroup } from "./gift-quantity-stack.ts";
import { stripVoucherSegments, type VoucherPaidLine } from "./voucher-allocation.ts";
import { createVoucherHoldService } from "./voucher-hold-service.ts";
import { buildVoucherOrderSnapshot, type VoucherOrderSnapshot } from "./voucher-order-snapshot.ts";
import { readVoucherPreviewWithin } from "./voucher-preview.ts";
import type { VoucherQuote } from "./voucher-quote.ts";

/**
 * Voucher v1 (V18, several merchandise vouchers per ADR 0020): what the vouchers a cart HOLDS do to its checkout quote.
 *
 * Checkout never applies a voucher the shopper merely picked; it applies exactly the live holds of this cart's own
 * attempt (V12), and only if the quote the holds promised is still the quote the server derives now. It reuses the
 * preview (so cart, picker, hold and checkout are one derivation) on the gift authority the checkout already read,
 * then expresses the result in the structures the benefit pipeline already proves, stores and sends to the POS:
 *
 *  - each line the merchandise vouchers touched becomes price segments, each carrying the line's earlier discount steps
 *    plus one `VOUCHER` step per voucher that lowered it, in application order (base -> ... -> price the buyer pays);
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

const stripSegment = stripVoucherSegments;

/**
 * What the gifts would be after the voucher a PREVIEW chose (nothing is held yet): the gift authority run on the cart's
 * groups re-priced by the preview's allocation, exactly like the held path below. Null when the preview carries no gift
 * authority or a line cannot be matched to its group (the caller treats that as "the quote changed").
 */
export function giftsAfterVoucher(preview: Readonly<{
  giftState: Awaited<ReturnType<typeof readCartGiftState>> | null;
  stackedGroups: readonly StackedGroup[];
  quote: Extract<VoucherQuote, { ok: true }>;
}>): ReturnType<Awaited<ReturnType<typeof readCartGiftState>>["evaluateGifts"]> | null {
  if (preview.giftState === null) return null;
  const groupByKey = new Map(preview.stackedGroups.map((group) => [group.groupKey, group]));
  const stackGroups: StackedGroup[] = [];
  for (const line of preview.quote.linesAfter) {
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

  const merchandiseHolds = holds.filter((hold) => hold.kind === "MERCHANDISE");
  const shipping = holds.find((hold) => hold.kind === "SHIPPING_FREE") ?? null;
  // Exactly the held vouchers: a slot without a hold is an explicit NONE, never an AUTO that could add a voucher the
  // buyer was not shown (`unlistedMerchandise`), and shipping likewise.
  const selectionOverride = {
    merchandise: Object.fromEntries(merchandiseHolds.map((hold) => [hold.slot, { mode: "MANUAL" as const, voucherId: hold.campaignId }])),
    shipping: { mode: "MANUAL" as const, voucherId: shipping?.campaignId ?? null },
    unlistedMerchandise: "NONE" as const,
  };
  const preview = await readVoucherPreviewWithin(tx, {
    cartId, shopId, now, env, selectionOverride, giftState,
    ownHolds: holds.map((hold) => ({ campaignId: hold.campaignId, campaignRevision: hold.campaignRevision, heldDiscountVnd: hold.heldDiscountVnd })),
  });
  if (!preview.enabled || !preview.ok || preview.quoteDigest === null || !preview.giftState) return { kind: "STALE", reason: "PREVIEW_UNAVAILABLE" };

  const quote = preview.quote;
  const campaign = new Map(preview.campaigns.map((entry) => [entry.id, entry]));
  // The quote the server derives now must be exactly what was held: the same vouchers in the same order, at the same amounts.
  const sameMerchandise =
    quote.merchandise.length === merchandiseHolds.length &&
    quote.merchandise.every((line) => merchandiseHolds.some((hold) => hold.campaignId === line.campaignId && hold.slot === line.slot && hold.heldDiscountVnd === line.discountVnd));
  const same =
    sameMerchandise &&
    quote.selection.shippingId === (shipping?.campaignId ?? null) &&
    quote.shippingDiscountVnd === (shipping?.heldDiscountVnd ?? 0) &&
    holds.every((hold) => hold.paidRevision === preview.paidRevision && hold.quoteDigest === preview.quoteDigest && campaign.get(hold.campaignId)?.revision === hold.campaignRevision);
  if (!same || holds.length === 0) return { kind: "STALE", reason: "QUOTE_CHANGED" };

  // Post-voucher groups: walk the vouchers in application order; each line a voucher lowered becomes price segments, and each
  // segment keeps the line's earlier steps plus one VOUCHER step for this voucher.
  const groupByKey = new Map(preview.stackedGroups.map((group) => [group.groupKey, group]));
  type Tracked = VoucherPaidLine & { steps: readonly CheckoutStep[] };
  let current: Tracked[] = preview.lines.map((line) => ({ ...line, steps: [] }));
  for (const voucher of quote.merchandise) {
    const byLine = new Map(voucher.allocation.lines.map((entry) => [entry.lineId, entry]));
    const next: Tracked[] = [];
    for (const line of current) {
      const entry = byLine.get(line.lineId);
      if (entry === undefined || entry.deductionVnd === 0) {
        next.push(line);
        continue;
      }
      entry.segments.forEach((segment, index) => {
        const step: CheckoutStep | null =
          segment.unitPriceVnd >= line.unitPriceVnd
            ? null
            : { campaignId: voucher.campaignId, source: "VOUCHER", kind: "VOUCHER_MERCHANDISE", priority: null, inputPriceVnd: line.unitPriceVnd, outputPriceVnd: segment.unitPriceVnd, appliedQuantity: segment.quantity };
        next.push({ lineId: `${line.lineId}|v${index}`, product: line.product, quantity: segment.quantity, unitPriceVnd: segment.unitPriceVnd, steps: step === null ? line.steps : [...line.steps, step] });
      });
    }
    current = next;
  }
  const groups: CheckoutGroup[] = [];
  const stackGroups: StackedGroup[] = [];
  for (const line of current) {
    const source = groupByKey.get(stripSegment(line.lineId));
    if (source === undefined) return { kind: "STALE", reason: "QUOTE_CHANGED" };
    const inherited: CheckoutStep[] = source.steps.map((step) => ({
      campaignId: step.campaignId, source: step.source, kind: String(step.kind), priority: step.priority,
      inputPriceVnd: step.inputPriceVnd, outputPriceVnd: step.outputPriceVnd, appliedQuantity: step.appliedQuantity,
    }));
    groups.push({
      groupKey: line.lineId,
      lineKey: source.lineKey,
      pancakeVariationId: source.pancakeVariationId,
      quantity: line.quantity,
      basePriceVnd: source.basePriceVnd,
      unitPriceVnd: line.unitPriceVnd,
      lineTotalVnd: line.quantity * line.unitPriceVnd,
      steps: [...inherited, ...line.steps],
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
