/**
 * The structural rules of a benefit-aware quote, shared by what is signed (GQ16) and what is stored
 * (GQ15).
 *
 * A quote is a set of lines keyed by `lineId` -- never by variation, so two PAID segments of one
 * variation at different prices (EX-17/18) and a PAID + GIFT pair of one variation stay separate --
 * plus the gift entitlements and the money. The proof module and the order snapshot must agree on
 * what a well-formed quote is, or a quote the buyer could prove might be one the order could not
 * store, or the reverse. Both therefore call this one function; neither carries a copy.
 *
 * Pure. It decides nothing about prices, stock or entitlements -- the engines do -- it only refuses
 * a quote whose numbers cannot all be true together.
 */

export const MAX_QUOTE_LINES = 200;
export const MAX_QUOTE_STEPS_PER_LINE = 8;
export const MAX_QUOTE_ENTITLEMENTS = 20;
export const MAX_QUOTE_GIFT_UNITS = 100;
export const QUOTE_LINE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

const MAX_VND = Number.MAX_SAFE_INTEGER;
const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;

export type QuoteDiscountStepFacts = Readonly<{
  campaignId: string;
  /** `VOUCHER` is the merchandise voucher segment (V18), always the last step of a line. */
  source: "LEGACY" | "QUANTITY_TIER" | "VOUCHER";
  campaignKind: string;
  priority: number | null;
  inputPriceVnd: number;
  outputPriceVnd: number;
  appliedQuantity: number;
}>;

export type QuoteLineFacts = Readonly<{
  lineId: string;
  role: "PAID" | "GIFT";
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  /**
   * Unit price before any promotion step. `undefined`: not carried (a signed quote derives it from
   * the first step). `null`: the line was not discounted and must have no steps.
   */
  baseUnitPriceVnd?: number | null;
  fulfillmentState: "READY" | "PREORDER";
  /** GIFT lines: the campaign and revision the gift was granted under. PAID lines: null. */
  campaign: Readonly<{ id: string; revision: number }> | null;
  discountSteps: readonly QuoteDiscountStepFacts[];
}>;

export type QuoteEntitlementFacts = Readonly<{
  campaignId: string;
  campaignRevision: number;
  entitled: number;
  selected: number;
  skippedWhileAvailable: number;
  contendedForSharedStock: number;
  shortForStock: number;
}>;

export type QuoteStructure = Readonly<{
  paidSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  lines: readonly QuoteLineFacts[];
  entitlements: readonly QuoteEntitlementFacts[];
}>;

export type QuoteStructureIssue =
  | "MONEY_INVALID"
  | "TOTAL_MISMATCH"
  | "LINES_OUT_OF_BOUNDS"
  | "LINE_ID_INVALID"
  | "LINE_ID_DUPLICATE"
  | "LINE_FIELDS_INVALID"
  | "LINE_TOTAL_MISMATCH"
  | "PAID_LINE_INVALID"
  | "GIFT_LINE_INVALID"
  | "DISCOUNT_CHAIN_INVALID"
  | "PAID_SUBTOTAL_MISMATCH"
  | "NO_PAID_LINES"
  | "GIFT_UNITS_OUT_OF_BOUNDS"
  | "ENTITLEMENT_INVALID"
  | "ENTITLEMENT_MISMATCH";

export type QuoteTotals = Readonly<{ paidQuantity: number; giftQuantity: number; unclaimedSlots: number }>;

export const isQuoteUint = (value: unknown, max: number = MAX_VND): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export const isQuotePositive = (value: unknown, max: number = MAX_VND): value is number =>
  isQuoteUint(value, max) && (value as number) >= 1;
export const isQuoteText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

function validateLine(line: QuoteLineFacts): QuoteStructureIssue | null {
  if (typeof line !== "object" || line === null) return "LINE_FIELDS_INVALID";
  if (!isQuoteText(line.lineId, 200) || !QUOTE_LINE_ID_PATTERN.test(line.lineId)) return "LINE_ID_INVALID";
  if (
    (line.role !== "PAID" && line.role !== "GIFT") ||
    (line.fulfillmentState !== "READY" && line.fulfillmentState !== "PREORDER") ||
    !isQuoteText(line.pancakeVariationId, 200) ||
    !isQuotePositive(line.quantity, MAX_INT) ||
    !isQuoteUint(line.unitPriceVnd) ||
    !isQuoteUint(line.lineTotalVnd) ||
    !Array.isArray(line.discountSteps) ||
    line.discountSteps.length > MAX_QUOTE_STEPS_PER_LINE
  ) {
    return "LINE_FIELDS_INVALID";
  }
  if (line.quantity * line.unitPriceVnd !== line.lineTotalVnd) return "LINE_TOTAL_MISMATCH";

  if (line.role === "GIFT") {
    if (
      line.unitPriceVnd !== 0 ||
      (line.baseUnitPriceVnd !== undefined && line.baseUnitPriceVnd !== null) ||
      line.fulfillmentState !== "READY" || // D-04: a free gift is never fulfilled from PREORDER/OVERSELL capacity
      line.quantity > MAX_QUOTE_GIFT_UNITS ||
      line.discountSteps.length !== 0 ||
      typeof line.campaign !== "object" || line.campaign === null ||
      !isQuoteText(line.campaign.id, 200) ||
      !isQuotePositive(line.campaign.revision, MAX_INT)
    ) {
      return "GIFT_LINE_INVALID";
    }
    return null;
  }

  if (line.unitPriceVnd < 1 || line.campaign !== null) return "PAID_LINE_INVALID";
  const steps = line.discountSteps;
  const base = line.baseUnitPriceVnd;
  if (base !== undefined && base !== null && (!isQuotePositive(base) || base < line.unitPriceVnd)) return "PAID_LINE_INVALID";
  // The ordered discount ledger must walk from the base price to the price the buyer pays.
  if (steps.length === 0) {
    return base !== undefined && base !== null && base !== line.unitPriceVnd ? "DISCOUNT_CHAIN_INVALID" : null;
  }
  if (base === null) return "DISCOUNT_CHAIN_INVALID";
  let running = base ?? steps[0]!.inputPriceVnd;
  for (const step of steps) {
    if (
      typeof step !== "object" ||
      step === null ||
      (step.source !== "LEGACY" && step.source !== "QUANTITY_TIER" && step.source !== "VOUCHER") ||
      !isQuoteText(step.campaignId, 200) ||
      !isQuoteText(step.campaignKind, 40) ||
      !(step.priority === null || (typeof step.priority === "number" && Number.isInteger(step.priority) && step.priority >= MIN_INT && step.priority <= MAX_INT)) ||
      !isQuotePositive(step.inputPriceVnd) ||
      !isQuotePositive(step.outputPriceVnd) ||
      !isQuotePositive(step.appliedQuantity, MAX_INT) ||
      step.outputPriceVnd > step.inputPriceVnd ||
      step.inputPriceVnd !== running
    ) {
      return "DISCOUNT_CHAIN_INVALID";
    }
    running = step.outputPriceVnd;
  }
  return running === line.unitPriceVnd ? null : "DISCOUNT_CHAIN_INVALID";
}

export function validateQuoteStructure(
  input: QuoteStructure,
): Readonly<{ ok: true; totals: QuoteTotals }> | Readonly<{ ok: false; issue: QuoteStructureIssue }> {
  const fail = (issue: QuoteStructureIssue) => ({ ok: false as const, issue });
  if (typeof input !== "object" || input === null) return fail("MONEY_INVALID");
  if (!isQuotePositive(input.paidSubtotalVnd) || !isQuoteUint(input.shippingFeeVnd) || !isQuotePositive(input.totalVnd)) return fail("MONEY_INVALID");
  if (input.paidSubtotalVnd + input.shippingFeeVnd !== input.totalVnd) return fail("TOTAL_MISMATCH");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_QUOTE_LINES) return fail("LINES_OUT_OF_BOUNDS");
  if (!Array.isArray(input.entitlements) || input.entitlements.length > MAX_QUOTE_ENTITLEMENTS) return fail("ENTITLEMENT_INVALID");

  const seen = new Set<string>();
  let paidTotal = 0;
  let paidQuantity = 0;
  let giftQuantity = 0;
  const giftByCampaign = new Map<string, { revision: number; quantity: number }>();
  for (const line of input.lines) {
    const issue = validateLine(line);
    if (issue !== null) return fail(issue);
    if (seen.has(line.lineId)) return fail("LINE_ID_DUPLICATE");
    seen.add(line.lineId);
    if (line.role === "PAID") {
      paidTotal += line.lineTotalVnd;
      paidQuantity += line.quantity;
      if (!Number.isSafeInteger(paidTotal) || !isQuotePositive(paidQuantity, MAX_INT)) return fail("MONEY_INVALID");
    } else {
      giftQuantity += line.quantity;
      const campaign = line.campaign!;
      const current = giftByCampaign.get(campaign.id);
      if (current !== undefined && current.revision !== campaign.revision) return fail("ENTITLEMENT_MISMATCH");
      giftByCampaign.set(campaign.id, { revision: campaign.revision, quantity: (current?.quantity ?? 0) + line.quantity });
    }
  }
  if (paidQuantity === 0) return fail("NO_PAID_LINES");
  if (giftQuantity > MAX_QUOTE_GIFT_UNITS) return fail("GIFT_UNITS_OUT_OF_BOUNDS");
  if (paidTotal !== input.paidSubtotalVnd) return fail("PAID_SUBTOTAL_MISMATCH");

  const campaigns = new Set<string>();
  let unclaimedSlots = 0;
  for (const entitlement of input.entitlements) {
    if (
      !isQuoteText(entitlement?.campaignId, 200) ||
      campaigns.has(entitlement.campaignId) ||
      !isQuotePositive(entitlement.campaignRevision, MAX_INT) ||
      !isQuoteUint(entitlement.entitled, MAX_QUOTE_GIFT_UNITS) ||
      !isQuoteUint(entitlement.selected, MAX_QUOTE_GIFT_UNITS) ||
      !isQuoteUint(entitlement.skippedWhileAvailable, MAX_QUOTE_GIFT_UNITS) ||
      !isQuoteUint(entitlement.contendedForSharedStock, MAX_QUOTE_GIFT_UNITS) ||
      !isQuoteUint(entitlement.shortForStock, MAX_QUOTE_GIFT_UNITS) ||
      entitlement.selected > entitlement.entitled ||
      entitlement.skippedWhileAvailable + entitlement.contendedForSharedStock + entitlement.shortForStock !== entitlement.entitled - entitlement.selected
    ) {
      return fail("ENTITLEMENT_INVALID");
    }
    campaigns.add(entitlement.campaignId);
    const taken = giftByCampaign.get(entitlement.campaignId);
    if (entitlement.selected !== (taken?.quantity ?? 0)) return fail("ENTITLEMENT_MISMATCH");
    if (taken !== undefined && taken.revision !== entitlement.campaignRevision) return fail("ENTITLEMENT_MISMATCH");
    unclaimedSlots += entitlement.entitled - entitlement.selected;
  }
  // A gift of a campaign that has no entitlement row would be a gift out of thin air.
  for (const campaignId of giftByCampaign.keys()) if (!campaigns.has(campaignId)) return fail("ENTITLEMENT_MISMATCH");

  return { ok: true, totals: { paidQuantity, giftQuantity, unclaimedSlots } };
}
