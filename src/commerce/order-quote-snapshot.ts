/**
 * The order's benefit-aware quote, stored by `lineId` (GQ15).
 *
 * This module is the single writer and reader of `OrderQuoteSnapshot` and its rows. It validates the
 * quote it is handed -- bounded integer money, the shape of each role, the discount chain, the
 * entitlement arithmetic -- before anything reaches the database, and the migration re-checks the
 * same invariants (row checks, the DRAFT-only change rule, and the cross-row totals at commit), so
 * neither layer is the only thing standing between a wrong number and an order.
 *
 * It decides nothing about price, stock or entitlement. The caller (the checkout DRAFT step) hands
 * over the facts the server just recomputed and the buyer proved; a snapshot is a record of those
 * facts, never an input to a later quote.
 *
 * Legacy orders have no snapshot: `readOrderQuoteSnapshot` returns `null` for them and nothing is
 * fabricated.
 */

import type { Prisma } from "../generated/prisma/client.ts";

export const MAX_ORDER_QUOTE_LINES = 200;
export const MAX_ORDER_QUOTE_STEPS_PER_LINE = 8;
export const MAX_ORDER_QUOTE_ENTITLEMENTS = 20;
export const MAX_ORDER_QUOTE_GIFT_UNITS = 100;
const MAX_VND = Number.MAX_SAFE_INTEGER;
const LINE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const FORMAT_PATTERN = /^laq[0-9]{1,3}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type OrderQuoteDiscountStepInput = Readonly<{
  campaignId: string;
  source: "LEGACY" | "QUANTITY_TIER";
  campaignKind: string;
  priority: number | null;
  inputPriceVnd: number;
  outputPriceVnd: number;
  appliedQuantity: number;
}>;

export type OrderQuoteLineInput = Readonly<{
  lineId: string;
  role: "PAID" | "GIFT";
  /** Internal variant id, kept as history; never shown to a browser. */
  variantId: string;
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  /** Unit price before any promotion step; null when the line was not discounted (and for gifts). */
  baseUnitPriceVnd: number | null;
  fulfillmentState: "READY" | "PREORDER";
  /** GIFT lines: the campaign and revision the gift was granted under. PAID lines: null. */
  campaign: Readonly<{ id: string; revision: number }> | null;
  discountSteps: readonly OrderQuoteDiscountStepInput[];
}>;

export type OrderQuoteEntitlementInput = Readonly<{
  campaignId: string;
  campaignRevision: number;
  entitled: number;
  selected: number;
  skippedWhileAvailable: number;
  contendedForSharedStock: number;
  shortForStock: number;
}>;

export type OrderQuoteSnapshotInput = Readonly<{
  quoteFormat: string;
  /** SHA-256 hex of the canonical quote bytes the buyer proved. */
  quoteDigest: string;
  paidSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  lines: readonly OrderQuoteLineInput[];
  entitlements: readonly OrderQuoteEntitlementInput[];
  /** Present only when a signed acknowledgement of exactly this quote was verified. */
  acknowledgedAt: Date | null;
}>;

export type OrderQuoteSnapshotIssue =
  | "FORMAT_INVALID"
  | "DIGEST_INVALID"
  | "MONEY_INVALID"
  | "LINES_OUT_OF_BOUNDS"
  | "LINE_ID_INVALID"
  | "LINE_ID_DUPLICATE"
  | "LINE_FIELDS_INVALID"
  | "LINE_TOTAL_MISMATCH"
  | "PAID_LINE_INVALID"
  | "GIFT_LINE_INVALID"
  | "DISCOUNT_CHAIN_INVALID"
  | "PAID_SUBTOTAL_MISMATCH"
  | "TOTAL_MISMATCH"
  | "NO_PAID_LINES"
  | "GIFT_UNITS_OUT_OF_BOUNDS"
  | "ENTITLEMENT_INVALID"
  | "ENTITLEMENT_MISMATCH"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "ACKNOWLEDGEMENT_UNNEEDED";

const isUint = (value: unknown, max: number = MAX_VND): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const isPositive = (value: unknown, max: number = MAX_VND): value is number => isUint(value, max) && (value as number) >= 1;
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

type Totals = Readonly<{ paidQuantity: number; giftQuantity: number; unclaimedSlots: number }>;

function validateLine(line: OrderQuoteLineInput): OrderQuoteSnapshotIssue | null {
  if (!isText(line.lineId, 200) || !LINE_ID_PATTERN.test(line.lineId)) return "LINE_ID_INVALID";
  if (
    (line.role !== "PAID" && line.role !== "GIFT") ||
    (line.fulfillmentState !== "READY" && line.fulfillmentState !== "PREORDER") ||
    !isText(line.variantId, 200) ||
    !isText(line.pancakeVariationId, 200) ||
    !isPositive(line.quantity, 2_147_483_647) ||
    !isUint(line.unitPriceVnd) ||
    !isUint(line.lineTotalVnd) ||
    !Array.isArray(line.discountSteps) ||
    line.discountSteps.length > MAX_ORDER_QUOTE_STEPS_PER_LINE
  ) {
    return "LINE_FIELDS_INVALID";
  }
  if (line.quantity * line.unitPriceVnd !== line.lineTotalVnd) return "LINE_TOTAL_MISMATCH";

  if (line.role === "GIFT") {
    if (
      line.unitPriceVnd !== 0 ||
      line.baseUnitPriceVnd !== null ||
      line.fulfillmentState !== "READY" || // D-04: a free gift is never fulfilled from PREORDER/OVERSELL capacity
      line.quantity > MAX_ORDER_QUOTE_GIFT_UNITS ||
      line.discountSteps.length !== 0 ||
      line.campaign === null ||
      !isText(line.campaign.id, 200) ||
      !isPositive(line.campaign.revision, 2_147_483_647)
    ) {
      return "GIFT_LINE_INVALID";
    }
    return null;
  }

  if (line.unitPriceVnd < 1 || line.campaign !== null) return "PAID_LINE_INVALID";
  if (line.baseUnitPriceVnd !== null && (!isPositive(line.baseUnitPriceVnd) || line.baseUnitPriceVnd < line.unitPriceVnd)) {
    return "PAID_LINE_INVALID";
  }
  // The ordered discount ledger must walk from the base price to the price the buyer pays.
  const steps = line.discountSteps;
  if (steps.length === 0) {
    return line.baseUnitPriceVnd !== null && line.baseUnitPriceVnd !== line.unitPriceVnd ? "DISCOUNT_CHAIN_INVALID" : null;
  }
  if (line.baseUnitPriceVnd === null) return "DISCOUNT_CHAIN_INVALID";
  let running = line.baseUnitPriceVnd;
  for (const step of steps) {
    if (
      (step.source !== "LEGACY" && step.source !== "QUANTITY_TIER") ||
      !isText(step.campaignId, 200) ||
      !isText(step.campaignKind, 40) ||
      !(step.priority === null || (typeof step.priority === "number" && Number.isSafeInteger(step.priority))) ||
      !isPositive(step.inputPriceVnd) ||
      !isPositive(step.outputPriceVnd) ||
      !isPositive(step.appliedQuantity, 2_147_483_647) ||
      step.outputPriceVnd > step.inputPriceVnd ||
      step.inputPriceVnd !== running
    ) {
      return "DISCOUNT_CHAIN_INVALID";
    }
    running = step.outputPriceVnd;
  }
  return running === line.unitPriceVnd ? null : "DISCOUNT_CHAIN_INVALID";
}

/** Pure. Returns the first problem, or the derived totals the database will re-check at commit. */
export function validateOrderQuoteSnapshot(
  input: OrderQuoteSnapshotInput,
): Readonly<{ ok: true; totals: Totals }> | Readonly<{ ok: false; issue: OrderQuoteSnapshotIssue }> {
  const fail = (issue: OrderQuoteSnapshotIssue) => ({ ok: false as const, issue });
  if (typeof input !== "object" || input === null) return fail("MONEY_INVALID");
  if (typeof input.quoteFormat !== "string" || !FORMAT_PATTERN.test(input.quoteFormat)) return fail("FORMAT_INVALID");
  if (typeof input.quoteDigest !== "string" || !DIGEST_PATTERN.test(input.quoteDigest)) return fail("DIGEST_INVALID");
  if (!isPositive(input.paidSubtotalVnd) || !isUint(input.shippingFeeVnd) || !isPositive(input.totalVnd)) return fail("MONEY_INVALID");
  if (input.paidSubtotalVnd + input.shippingFeeVnd !== input.totalVnd) return fail("TOTAL_MISMATCH");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_ORDER_QUOTE_LINES) return fail("LINES_OUT_OF_BOUNDS");
  if (!Array.isArray(input.entitlements) || input.entitlements.length > MAX_ORDER_QUOTE_ENTITLEMENTS) return fail("ENTITLEMENT_INVALID");

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
      if (!Number.isSafeInteger(paidTotal) || !Number.isSafeInteger(paidQuantity)) return fail("MONEY_INVALID");
    } else {
      giftQuantity += line.quantity;
      const campaign = line.campaign!;
      const current = giftByCampaign.get(campaign.id);
      if (current !== undefined && current.revision !== campaign.revision) return fail("ENTITLEMENT_MISMATCH");
      giftByCampaign.set(campaign.id, { revision: campaign.revision, quantity: (current?.quantity ?? 0) + line.quantity });
    }
  }
  if (paidQuantity === 0) return fail("NO_PAID_LINES");
  if (giftQuantity > MAX_ORDER_QUOTE_GIFT_UNITS) return fail("GIFT_UNITS_OUT_OF_BOUNDS");
  if (paidTotal !== input.paidSubtotalVnd) return fail("PAID_SUBTOTAL_MISMATCH");

  const campaigns = new Set<string>();
  let unclaimedSlots = 0;
  for (const entitlement of input.entitlements) {
    if (
      !isText(entitlement?.campaignId, 200) ||
      campaigns.has(entitlement.campaignId) ||
      !isPositive(entitlement.campaignRevision, 2_147_483_647) ||
      !isUint(entitlement.entitled, MAX_ORDER_QUOTE_GIFT_UNITS) ||
      !isUint(entitlement.selected, MAX_ORDER_QUOTE_GIFT_UNITS) ||
      !isUint(entitlement.skippedWhileAvailable, MAX_ORDER_QUOTE_GIFT_UNITS) ||
      !isUint(entitlement.contendedForSharedStock, MAX_ORDER_QUOTE_GIFT_UNITS) ||
      !isUint(entitlement.shortForStock, MAX_ORDER_QUOTE_GIFT_UNITS) ||
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

  const acknowledged = input.acknowledgedAt !== null;
  if (acknowledged && !(input.acknowledgedAt instanceof Date && Number.isFinite(input.acknowledgedAt.getTime()))) return fail("ACKNOWLEDGEMENT_REQUIRED");
  if (unclaimedSlots > 0 && !acknowledged) return fail("ACKNOWLEDGEMENT_REQUIRED");
  if (unclaimedSlots === 0 && acknowledged) return fail("ACKNOWLEDGEMENT_UNNEEDED");
  return { ok: true, totals: { paidQuantity, giftQuantity, unclaimedSlots } };
}

export type OrderQuoteSnapshotWriteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "SNAPSHOT_INVALID"; issue: OrderQuoteSnapshotIssue }>;

/**
 * Replaces the order's quote with `input`, inside the caller's transaction.
 *
 * Every earlier row of the order is removed first (children before parents), so a re-quote of a DRAFT
 * leaves exactly one coherent set and a retry with the same facts leaves the same rows -- it never
 * adds a second snapshot or a second gift. Once the order has left DRAFT the database refuses both
 * the removal and the insert, which surfaces here as the driver's error; callers treat a frozen
 * order as a state gate, not as something to retry.
 */
export async function replaceOrderQuoteSnapshot(
  tx: Prisma.TransactionClient,
  orderId: string,
  input: OrderQuoteSnapshotInput,
): Promise<OrderQuoteSnapshotWriteResult> {
  if (!isText(orderId, 200)) return { ok: false, reason: "SNAPSHOT_INVALID", issue: "LINES_OUT_OF_BOUNDS" };
  const verdict = validateOrderQuoteSnapshot(input);
  if (!verdict.ok) return { ok: false, reason: "SNAPSHOT_INVALID", issue: verdict.issue };

  const previous = await tx.orderQuoteSnapshot.findUnique({ where: { orderId }, select: { id: true } });
  if (previous !== null) {
    await tx.orderQuoteDiscountStep.deleteMany({ where: { line: { snapshotId: previous.id } } });
    await tx.orderQuoteLine.deleteMany({ where: { snapshotId: previous.id } });
    await tx.orderQuoteEntitlement.deleteMany({ where: { snapshotId: previous.id } });
    await tx.orderQuoteSnapshot.delete({ where: { id: previous.id } });
  }

  const { totals } = verdict;
  await tx.orderQuoteSnapshot.create({
    data: {
      orderId,
      quoteFormat: input.quoteFormat,
      quoteDigest: input.quoteDigest,
      paidSubtotalVnd: BigInt(input.paidSubtotalVnd),
      shippingFeeVnd: BigInt(input.shippingFeeVnd),
      totalVnd: BigInt(input.totalVnd),
      paidQuantity: totals.paidQuantity,
      giftQuantity: totals.giftQuantity,
      unclaimedSlots: totals.unclaimedSlots,
      nonclaimAcknowledged: input.acknowledgedAt !== null,
      acknowledgedAt: input.acknowledgedAt,
      lines: {
        create: input.lines.map((line) => ({
          lineId: line.lineId,
          role: line.role,
          variantId: line.variantId,
          pancakeVariationId: line.pancakeVariationId,
          quantity: line.quantity,
          unitPriceVnd: BigInt(line.unitPriceVnd),
          lineTotalVnd: BigInt(line.lineTotalVnd),
          baseUnitPriceVnd: line.baseUnitPriceVnd === null ? null : BigInt(line.baseUnitPriceVnd),
          fulfillmentState: line.fulfillmentState,
          campaignId: line.campaign?.id ?? null,
          campaignRevision: line.campaign?.revision ?? null,
          discountSteps: {
            create: line.discountSteps.map((step, position) => ({
              position,
              campaignId: step.campaignId,
              source: step.source,
              campaignKind: step.campaignKind,
              priority: step.priority,
              inputPriceVnd: BigInt(step.inputPriceVnd),
              outputPriceVnd: BigInt(step.outputPriceVnd),
              appliedQuantity: step.appliedQuantity,
            })),
          },
        })),
      },
      entitlements: {
        create: input.entitlements.map((entry) => ({
          campaignId: entry.campaignId,
          campaignRevision: entry.campaignRevision,
          entitled: entry.entitled,
          selected: entry.selected,
          unclaimed: entry.entitled - entry.selected,
          skippedWhileAvailable: entry.skippedWhileAvailable,
          contendedForSharedStock: entry.contendedForSharedStock,
          shortForStock: entry.shortForStock,
        })),
      },
    },
    select: { id: true },
  });
  return { ok: true };
}

export type StoredOrderQuoteSnapshot = Readonly<{
  quoteFormat: string;
  quoteDigest: string;
  paidSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
  paidQuantity: number;
  giftQuantity: number;
  unclaimedSlots: number;
  nonclaimAcknowledged: boolean;
  acknowledgedAt: Date | null;
  lines: readonly OrderQuoteLineInput[];
  entitlements: readonly OrderQuoteEntitlementInput[];
}>;

type ReadClient = Pick<Prisma.TransactionClient, "orderQuoteSnapshot">;

/** The stored quote, lines in a stable order, or `null` for an order that has none (every legacy order). */
export async function readOrderQuoteSnapshot(client: ReadClient, orderId: string): Promise<StoredOrderQuoteSnapshot | null> {
  if (!isText(orderId, 200)) return null;
  const row = await client.orderQuoteSnapshot.findUnique({
    where: { orderId },
    include: {
      lines: { orderBy: [{ role: "asc" }, { lineId: "asc" }], include: { discountSteps: { orderBy: { position: "asc" } } } },
      entitlements: { orderBy: { campaignId: "asc" } },
    },
  });
  if (row === null) return null;
  return {
    quoteFormat: row.quoteFormat,
    quoteDigest: row.quoteDigest,
    paidSubtotalVnd: Number(row.paidSubtotalVnd),
    shippingFeeVnd: Number(row.shippingFeeVnd),
    totalVnd: Number(row.totalVnd),
    paidQuantity: row.paidQuantity,
    giftQuantity: row.giftQuantity,
    unclaimedSlots: row.unclaimedSlots,
    nonclaimAcknowledged: row.nonclaimAcknowledged,
    acknowledgedAt: row.acknowledgedAt,
    lines: row.lines.map((line) => ({
      lineId: line.lineId,
      role: line.role,
      variantId: line.variantId,
      pancakeVariationId: line.pancakeVariationId,
      quantity: line.quantity,
      unitPriceVnd: Number(line.unitPriceVnd),
      lineTotalVnd: Number(line.lineTotalVnd),
      baseUnitPriceVnd: line.baseUnitPriceVnd === null ? null : Number(line.baseUnitPriceVnd),
      fulfillmentState: line.fulfillmentState,
      campaign: line.campaignId === null || line.campaignRevision === null ? null : { id: line.campaignId, revision: line.campaignRevision },
      discountSteps: line.discountSteps.map((step) => ({
        campaignId: step.campaignId,
        source: step.source as "LEGACY" | "QUANTITY_TIER",
        campaignKind: step.campaignKind,
        priority: step.priority,
        inputPriceVnd: Number(step.inputPriceVnd),
        outputPriceVnd: Number(step.outputPriceVnd),
        appliedQuantity: step.appliedQuantity,
      })),
    })),
    entitlements: row.entitlements.map((entry) => ({
      campaignId: entry.campaignId,
      campaignRevision: entry.campaignRevision,
      entitled: entry.entitled,
      selected: entry.selected,
      skippedWhileAvailable: entry.skippedWhileAvailable,
      contendedForSharedStock: entry.contendedForSharedStock,
      shortForStock: entry.shortForStock,
    })),
  };
}
