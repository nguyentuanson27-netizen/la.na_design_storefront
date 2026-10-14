/**
 * Does the stored benefit quote of an order still equal what the server would quote now? (GQ20)
 *
 * The POS submission happens after the DRAFT was proven and stored, and the world can move in between:
 * a category membership removed by a catalog sync, a gift option withdrawn, a tier or legacy price
 * recomputed, a feature gate turned OFF. The submit therefore re-derives the quote with the same
 * resolver the checkout DRAFT used and compares it with the frozen rows here, instead of checking a
 * few ids. Any difference means the buyer did not prove what would now be sent.
 *
 * What is compared: every PAID and GIFT line (id, role, variation, quantity, unit price, campaign +
 * revision), the ordered discount ledger of each line, the totals, and per campaign what was entitled
 * and selected. What is not: the fulfillment state and the stock-derived shortfall counters. Those move
 * with the order's own stock hold (which exists by the time of submit but not at DRAFT time) and are
 * judged by the capacity gate and the live stock check, which are the authority on stock.
 */

import type { QuoteStructure } from "./order-quote-rules.ts";

export type StoredBenefitQuote = Readonly<{
  paidSubtotalVnd: bigint;
  shippingFeeVnd: bigint;
  totalVnd: bigint;
  lines: readonly Readonly<{
    lineId: string;
    role: string;
    pancakeVariationId: string;
    quantity: number;
    unitPriceVnd: bigint;
    campaignId: string | null;
    campaignRevision: number | null;
    discountSteps: readonly Readonly<{
      campaignId: string;
      source: string;
      campaignKind: string;
      priority: number | null;
      inputPriceVnd: bigint;
      outputPriceVnd: bigint;
      appliedQuantity: number;
    }>[];
  }>[];
  entitlements: readonly Readonly<{ campaignId: string; campaignRevision: number; entitled: number; selected: number }>[];
}>;

const text = (value: string | number | bigint | null): string => {
  const raw = value === null ? "-" : String(value);
  return `${raw.length}:${raw}`;
};

function fingerprint(parts: {
  paid: string;
  shipping: string;
  total: string;
  lines: readonly string[];
  entitlements: readonly string[];
}): string {
  return [parts.paid, parts.shipping, parts.total, ...[...parts.lines].sort(), "|E", ...[...parts.entitlements].sort()].join("\n");
}

export function benefitQuoteStillHolds(stored: StoredBenefitQuote, fresh: QuoteStructure): boolean {
  const storedPrint = fingerprint({
    paid: String(stored.paidSubtotalVnd),
    shipping: String(stored.shippingFeeVnd),
    total: String(stored.totalVnd),
    lines: stored.lines.map((line) =>
      [
        text(line.lineId), text(line.role), text(line.pancakeVariationId), text(line.quantity), text(line.unitPriceVnd),
        text(line.campaignId), text(line.campaignRevision),
        ...line.discountSteps.map((step) =>
          [text(step.campaignId), text(step.source), text(step.campaignKind), text(step.priority), text(step.inputPriceVnd), text(step.outputPriceVnd), text(step.appliedQuantity)].join(","),
        ),
      ].join(";"),
    ),
    entitlements: stored.entitlements
      .filter((entry) => entry.entitled > 0 || entry.selected > 0)
      .map((entry) => [text(entry.campaignId), text(entry.campaignRevision), text(entry.entitled), text(entry.selected)].join(",")),
  });
  const freshPrint = fingerprint({
    paid: String(fresh.paidSubtotalVnd),
    shipping: String(fresh.shippingFeeVnd),
    total: String(fresh.totalVnd),
    lines: fresh.lines.map((line) =>
      [
        text(line.lineId), text(line.role), text(line.pancakeVariationId), text(line.quantity), text(line.unitPriceVnd),
        text(line.campaign?.id ?? null), text(line.campaign?.revision ?? null),
        ...line.discountSteps.map((step) =>
          [text(step.campaignId), text(step.source), text(step.campaignKind), text(step.priority), text(step.inputPriceVnd), text(step.outputPriceVnd), text(step.appliedQuantity)].join(","),
        ),
      ].join(";"),
    ),
    entitlements: fresh.entitlements
      .filter((entry) => entry.entitled > 0 || entry.selected > 0)
      .map((entry) => [text(entry.campaignId), text(entry.campaignRevision), text(entry.entitled), text(entry.selected)].join(",")),
  });
  return storedPrint === freshPrint;
}
