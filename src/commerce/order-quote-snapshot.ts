/**
 * The order's benefit-aware quote, stored by `lineId` (GQ15).
 *
 * This module is the single writer and reader of `OrderQuoteSnapshot` and its rows. It validates the
 * quote it is handed -- the canonical digest, bounded integer money, the shape of each role, the
 * discount chain, the entitlement arithmetic -- before anything reaches the database. The migration
 * re-checks row constraints, the DRAFT-only change rule, and the cross-row totals at commit, so
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
import { benefitQuoteDigest, BENEFIT_PROOF_FORMAT } from "./checkout-quote-proof.ts";
import {
  isQuoteText,
  MAX_QUOTE_ENTITLEMENTS,
  MAX_QUOTE_GIFT_UNITS,
  MAX_QUOTE_LINES,
  MAX_QUOTE_STEPS_PER_LINE,
  validateQuoteStructure,
  type QuoteDiscountStepFacts,
  type QuoteEntitlementFacts,
  type QuoteLineFacts,
  type QuoteStructureIssue,
  type QuoteTotals,
} from "./order-quote-rules.ts";

export const MAX_ORDER_QUOTE_LINES = MAX_QUOTE_LINES;
export const MAX_ORDER_QUOTE_STEPS_PER_LINE = MAX_QUOTE_STEPS_PER_LINE;
export const MAX_ORDER_QUOTE_ENTITLEMENTS = MAX_QUOTE_ENTITLEMENTS;
export const MAX_ORDER_QUOTE_GIFT_UNITS = MAX_QUOTE_GIFT_UNITS;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type OrderQuoteDiscountStepInput = QuoteDiscountStepFacts;

export type OrderQuoteLineInput = QuoteLineFacts & Readonly<{
  /** Internal variant id, kept as history; never shown to a browser. */
  variantId: string;
  /** Unit price before any promotion step; null when the line was not discounted (and for gifts). */
  baseUnitPriceVnd: number | null;
}>;

export type OrderQuoteEntitlementInput = QuoteEntitlementFacts;

/** Why a campaign is not part of the quote (audit only), from the stack's closed vocabulary. */
export const DROPPED_BENEFIT_REASONS = [
  "STACK_NOT_PERMITTED",
  "STACK_PRIORITY_CONFLICT",
  "TIER_PRICE_INVALID",
  "TIER_CONFIG_INVALID",
  "TIER_INPUT_INVALID",
] as const;
export const MAX_DROPPED_BENEFITS = 50;

export type DroppedBenefitInput = Readonly<{
  campaignId: string;
  reason: (typeof DROPPED_BENEFIT_REASONS)[number];
  otherCampaignId: string | null;
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
  /** Benefits the quote stepped aside from, with the reason (EX-21 keeps `TIER_PRICE_INVALID`). */
  droppedBenefits?: readonly DroppedBenefitInput[];
  /**
   * The Pancake projection of exactly these lines (ADR 0016 D-08, GQ20): a pure function of them, so
   * it is computed with the quote and frozen with it. Absent for a snapshot that was never meant to be
   * sent (tests of the record itself).
   */
  vendorProjection?: Readonly<{ hash: string; lines: readonly Readonly<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>[] }>;
}>;

export type OrderQuoteSnapshotIssue =
  | QuoteStructureIssue
  | "FORMAT_INVALID"
  | "DIGEST_INVALID"
  | "DIGEST_MISMATCH"
  | "DROPPED_BENEFITS_INVALID"
  | "VENDOR_PROJECTION_INVALID"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "ACKNOWLEDGEMENT_UNNEEDED";

/** Pure. Returns the first problem, or the derived totals the database will re-check at commit. */
export function validateOrderQuoteSnapshot(
  input: OrderQuoteSnapshotInput,
): Readonly<{ ok: true; totals: QuoteTotals }> | Readonly<{ ok: false; issue: OrderQuoteSnapshotIssue }> {
  const fail = (issue: OrderQuoteSnapshotIssue) => ({ ok: false as const, issue });
  if (typeof input !== "object" || input === null) return fail("MONEY_INVALID");
  if (input.quoteFormat !== BENEFIT_PROOF_FORMAT) return fail("FORMAT_INVALID");
  if (typeof input.quoteDigest !== "string" || !DIGEST_PATTERN.test(input.quoteDigest)) return fail("DIGEST_INVALID");

  const dropped = input.droppedBenefits ?? [];
  if (
    !Array.isArray(dropped) ||
    dropped.length > MAX_DROPPED_BENEFITS ||
    dropped.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !isQuoteText(entry.campaignId, 200) ||
        !(DROPPED_BENEFIT_REASONS as readonly string[]).includes(entry.reason) ||
        !(entry.otherCampaignId === null || isQuoteText(entry.otherCampaignId, 200)),
    )
  ) {
    return fail("DROPPED_BENEFITS_INVALID");
  }

  const projection = input.vendorProjection;
  if (
    projection !== undefined &&
    (typeof projection !== "object" ||
      projection === null ||
      !DIGEST_PATTERN.test(projection.hash) ||
      !Array.isArray(projection.lines) ||
      projection.lines.length === 0 ||
      projection.lines.length > 400 ||
      projection.lines.some(
        (line) =>
          typeof line !== "object" ||
          line === null ||
          !isQuoteText(line.pancakeVariationId, 200) ||
          !Number.isSafeInteger(line.quantity) ||
          line.quantity < 1 ||
          !Number.isSafeInteger(line.unitPriceVnd) ||
          line.unitPriceVnd < 1,
      ) ||
      projection.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0) !== input.paidSubtotalVnd)
  ) {
    // The vendor total must be the website total (D-08); anything else must never be stored as sendable.
    return fail("VENDOR_PROJECTION_INVALID");
  }

  const verdict = validateQuoteStructure(input);
  if (!verdict.ok) return verdict;
  // The stored line also keeps the internal variant id as history.
  for (const line of input.lines) if (!isQuoteText(line.variantId, 200)) return fail("LINE_FIELDS_INVALID");

  const acknowledged = input.acknowledgedAt !== null;
  if (acknowledged && !(input.acknowledgedAt instanceof Date && Number.isFinite(input.acknowledgedAt.getTime()))) return fail("ACKNOWLEDGEMENT_REQUIRED");
  if (verdict.totals.unclaimedSlots > 0 && !acknowledged) return fail("ACKNOWLEDGEMENT_REQUIRED");
  if (verdict.totals.unclaimedSlots === 0 && acknowledged) return fail("ACKNOWLEDGEMENT_UNNEEDED");
  if (input.quoteDigest !== benefitQuoteDigest(input)) return fail("DIGEST_MISMATCH");
  return verdict;
}

/**
 * Removes the order's quote (children before parents); returns whether there was one. Only a DRAFT
 * accepts it: the database refuses the removal once the order has left DRAFT.
 */
export async function clearOrderQuoteSnapshot(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  // Take the parent before touching quote rows, just as checkout state transitions do. This also
  // serializes two first writes/replacements before either reads the previous snapshot.
  await tx.$queryRaw`SELECT "id" FROM "OrderMirror" WHERE "id" = ${orderId} FOR UPDATE`;
  const previous = await tx.orderQuoteSnapshot.findUnique({ where: { orderId }, select: { id: true } });
  if (previous === null) return false;
  await tx.orderQuoteDiscountStep.deleteMany({ where: { line: { snapshotId: previous.id } } });
  await tx.orderQuoteLine.deleteMany({ where: { snapshotId: previous.id } });
  await tx.orderQuoteEntitlement.deleteMany({ where: { snapshotId: previous.id } });
  await tx.orderQuoteSnapshot.delete({ where: { id: previous.id } });
  return true;
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
  if (!isQuoteText(orderId, 200)) return { ok: false, reason: "SNAPSHOT_INVALID", issue: "LINES_OUT_OF_BOUNDS" };
  const verdict = validateOrderQuoteSnapshot(input);
  if (!verdict.ok) return { ok: false, reason: "SNAPSHOT_INVALID", issue: verdict.issue };

  await clearOrderQuoteSnapshot(tx, orderId);

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
      droppedBenefits: (input.droppedBenefits?.length ?? 0) === 0 ? undefined : input.droppedBenefits!.map((entry) => ({ ...entry })),
      vendorProjectionHash: input.vendorProjection?.hash,
      vendorProjection: input.vendorProjection === undefined ? undefined : input.vendorProjection.lines.map((line) => ({ ...line })),
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
  droppedBenefits: readonly DroppedBenefitInput[];
  vendorProjection: Readonly<{ hash: string; lines: readonly Readonly<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>[] }> | null;
}>;

type ReadClient = Pick<Prisma.TransactionClient, "orderQuoteSnapshot">;

/** The stored quote, lines in a stable order, or `null` for an order that has none (every legacy order). */
export async function readOrderQuoteSnapshot(client: ReadClient, orderId: string): Promise<StoredOrderQuoteSnapshot | null> {
  if (!isQuoteText(orderId, 200)) return null;
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
    vendorProjection:
      row.vendorProjectionHash !== null && Array.isArray(row.vendorProjection)
        ? { hash: row.vendorProjectionHash, lines: row.vendorProjection as unknown as { pancakeVariationId: string; quantity: number; unitPriceVnd: number }[] }
        : null,
    droppedBenefits: Array.isArray(row.droppedBenefits) ? (row.droppedBenefits as unknown as DroppedBenefitInput[]) : [],
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
