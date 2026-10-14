import type { PrismaClient } from "../generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../integrations/pancake/catalog-contract.ts";
import {
  buildPancakeCreateOrderRequest,
  parsePancakeCreateOrderResponse,
  type PancakeCreateOrderRequest,
} from "../integrations/pancake/order-create.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { calculateGuestShippingFeeVnd } from "./guest-shipping-policy.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import type {
  ApplicableCampaignLookup,
  PromotionCandidateReadClient,
} from "./promotion-candidate-repository.ts";
import {
  isUsableBasePriceVnd,
  resolvePromotionPricing,
  type PromotionCampaignKind,
} from "./promotion-pricing.ts";
import { createPreorderSnapshotAtConfirmation } from "./preorder-order-snapshot-repository.ts";
import { reportMetaPurchaseSafely } from "./meta-purchase-reporting.ts";
import {
  capacityFloorForMode,
  resolveSellingPolicy,
} from "./capacity-policy.ts";
import { PancakeHttpError } from "../integrations/pancake/client.ts";
import { readActiveGiftQuantityCampaigns, type GiftQuantityCandidateReadClient } from "./gift-quantity-candidate-repository.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";
import { compareOrderReadBack } from "./pancake-order-readback-check.ts";
import type { PancakeOrderReadBack } from "../integrations/pancake/order-readback.ts";
import { projectBenefitQuoteForVendor } from "./pancake-gift-projection.ts";

const MAX_PUBLIC_CODE_LENGTH = 128;

export type PancakeOrderSubmissionReason =
  | "ORDER_NOT_FOUND"
  | "SUBMISSION_ALREADY_CLAIMED"
  | "SUBMISSION_BUSY"
  | "LOCAL_ORDER_INVALID"
  | "SHOP_SCOPE_UNVERIFIED"
  | "VARIATION_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "PRICE_UNAVAILABLE"
  | "STOCK_UNAVAILABLE"
  | "VALIDATION_UNAVAILABLE"
  | "CREATE_OUTCOME_UNKNOWN"
  | "ORDER_REJECTED"
  | "COMPOSITE_SELLING_MODE_UNSUPPORTED"
  /**
   * GQ18 -- the order carries a benefit quote (gifts or quantity-tier segments). The legacy submission
   * would send the paid lines and silently drop the gifts, and the legacy reprice would rewrite prices
   * the quote has signed, so such an order is held at DRAFT with nothing sent until the line-level
   * Pancake projection (GQ20) exists. The reason is stable so that work can remove exactly this gate.
   */
  | "BENEFIT_SUBMISSION_UNAVAILABLE"
  /**
   * GQ20 -- a benefit order's fresh-base recheck found that the price story behind its quote (the live
   * Pancake base, a legacy campaign, or a gift / tier campaign's liveness or revision) no longer holds.
   * The order goes back to DRAFT with nothing written to Pancake; the buyer's next submit re-quotes.
   */
  | "BENEFIT_REQUOTE_REQUIRED";

type PancakeOrderValidationRejectionReason = Extract<
  PancakeOrderSubmissionReason,
  | "LOCAL_ORDER_INVALID"
  | "SHOP_SCOPE_UNVERIFIED"
  | "VARIATION_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "PRICE_UNAVAILABLE"
  | "STOCK_UNAVAILABLE"
  | "COMPOSITE_SELLING_MODE_UNSUPPORTED"
>;

export type PancakeOrderSubmissionEvent =
  | {
      name: "pancake_order.validation_started";
      correlationId: string;
      state: "VALIDATING";
    }
  | {
      name: "pancake_order.validation_rejected";
      correlationId: string;
      state: "REJECTED";
      reason: PancakeOrderValidationRejectionReason;
    }
  | {
      name: "pancake_order.create_rejected";
      correlationId: string;
      state: "REJECTED";
      reason: "ORDER_REJECTED";
    }
  | {
      name: "pancake_order.validation_unavailable";
      correlationId: string;
      state: "DRAFT";
      reason: "VALIDATION_UNAVAILABLE";
    }
  | {
      name: "pancake_order.benefit_submission_withheld";
      correlationId: string;
      state: "DRAFT";
      reason: "BENEFIT_SUBMISSION_UNAVAILABLE";
    }
  | {
      name: "pancake_order.benefit_readback_unconfirmed";
      correlationId: string;
      state: "SYNC_UNKNOWN";
      reason: "RECONCILE_DRIFT" | "READBACK_UNAVAILABLE";
    }
  | {
      name: "pancake_order.benefit_requote_required";
      correlationId: string;
      state: "DRAFT";
      reason: "BENEFIT_REQUOTE_REQUIRED";
    }
  | {
      name: "pancake_order.quote_repriced";
      correlationId: string;
      state: "DRAFT";
      reason: "PRICE_CHANGED";
    }
  | {
      name: "pancake_order.create_started";
      correlationId: string;
      state: "POS_SUBMITTING";
      dependency: "pancake";
      operation: "create_order";
    }
  | {
      name: "pancake_order.create_unknown";
      correlationId: string;
      state: "SYNC_UNKNOWN";
      reason: "CREATE_OUTCOME_UNKNOWN";
    }
  | {
      name: "pancake_order.confirmed";
      correlationId: string;
      state: "CONFIRMED";
    };

/**
 * The money a repriced DRAFT now carries.
 *
 * Returned so the buyer can be shown the new number and asked to confirm it. Display only: the next
 * submission recomputes the quote and re-checks the buyer's proof against that answer, exactly as
 * P9a requires, so nothing here is ever charged on the strength of having travelled through a
 * response body.
 */
export type PancakeOrderRepricedQuote = Readonly<{
  merchandiseSubtotalVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
}>;

export type PancakeOrderSubmissionResult =
  | { ok: true; state: "CONFIRMED"; pancakeOrderId: string }
  | {
      ok: false;
      state: "DRAFT";
      reason: "PRICE_CHANGED";
      repricedQuote: PancakeOrderRepricedQuote;
    }
  | {
      ok: false;
      state: "DRAFT" | "VALIDATING" | "POS_SUBMITTING" | "REJECTED" | "SYNC_UNKNOWN" | "CONFIRMED";
      reason: PancakeOrderSubmissionReason;
    };

export type PancakeOrderSubmissionGateway = {
  /**
   * The live Pancake rows for exactly these variation ids. An id Pancake no longer lists is simply
   * absent from the answer, as it would be from a full catalog read.
   */
  fetchVariations(
    shopId: number,
    variationIds: readonly string[],
  ): Promise<readonly PancakeCatalogVariation[]>;
  createOrder(request: PancakeCreateOrderRequest): Promise<unknown>;
  /**
   * The lines and total the POS stored for a created order (GQ21). Optional: a gateway without it can
   * still serve legacy orders, but a benefit order created through it is never confirmed on the
   * create response alone -- it stays `SYNC_UNKNOWN` until reconciliation can read it back.
   */
  readOrder?(shopId: number, orderId: string): Promise<PancakeOrderReadBack>;
  /**
   * Display names for a two-level (no district) address, which Pancake POS needs next to the ids to
   * show its "Địa chỉ mới" tab. A read, so a failure is retryable before anything is sent. A
   * gateway without it cannot submit a two-level order.
   */
  resolveTwoLevelAddressNames?(
    provinceRef: string,
    communeRef: string,
  ): Promise<{ provinceName: string; communeName: string }>;
};

export type PancakeOrderSubmissionOptions = {
  /**
   * Shops whose line-level pricing was accepted live (GQ01). Defaults to the operator-maintained
   * `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS`. A benefit order for any other shop is held at
   * DRAFT with nothing sent.
   */
  lineLevelPricingVerifiedShopIds?: readonly number[];
  /**
   * The environment the gift / quantity feature gate is read from (default `process.env`). With the
   * gate OFF no benefit campaign is in force, so a benefit order is sent back for a re-quote: the
   * kill switch (GQ24) stops new benefit orders from reaching the POS while leaving history alone.
   */
  env?: Readonly<Record<string, string | undefined>>;
  onEvent?: (event: PancakeOrderSubmissionEvent) => void;
  onConfirmed?: (publicCode: string) => Promise<void>;
  /**
   * The instant every campaign window is evaluated against for this submission.
   *
   * Injected rather than read inside the loop so one submission cannot straddle a campaign
   * boundary and price two lines of the same order against different instants.
   */
  now?: () => Date;
  /** Pancake POS order source ID stamped on every created order; omitted when not configured. */
  orderSourceId?: number;
};

function emitSafely(
  observer: PancakeOrderSubmissionOptions["onEvent"],
  event: PancakeOrderSubmissionEvent,
): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Observability must never change order submission semantics.
  }
}

function requirePublicCode(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PUBLIC_CODE_LENGTH ||
    value.trim() !== value
  ) {
    throw new TypeError("Order public code must be a normalized non-empty string");
  }
  return value;
}

function requireShopId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Pancake shop id must be a positive safe integer");
  }
  return value;
}

function isNormalizedNonEmptyString(value: string | null): value is string {
  return value !== null && value.length > 0 && value.trim() === value;
}

function isNormalizedOptionalString(value: string | null): boolean {
  return value === null || (value.length > 0 && value.trim() === value);
}

function isSupportedVndAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedMultiplyVnd(unitPriceVnd: number, quantity: number): number | null {
  if (!isSupportedVndAmount(unitPriceVnd) || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return null;
  }
  const result = unitPriceVnd * quantity;
  return isSupportedVndAmount(result) ? result : null;
}

function checkedAddVnd(left: number, right: number): number | null {
  const result = left + right;
  return isSupportedVndAmount(result) ? result : null;
}

function existingResult(order: {
  state: string;
  pancakeOrderId: string | null;
  syncErrorCode: string | null;
}): PancakeOrderSubmissionResult {
  if (order.state === "CONFIRMED" && order.pancakeOrderId) {
    return { ok: true, state: "CONFIRMED", pancakeOrderId: order.pancakeOrderId };
  }
  if (order.state === "SYNC_UNKNOWN") {
    return { ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" };
  }
  if (order.state === "REJECTED") {
    const reason = order.syncErrorCode;
    if (
      reason === "LOCAL_ORDER_INVALID" ||
      reason === "SHOP_SCOPE_UNVERIFIED" ||
      reason === "VARIATION_UNAVAILABLE" ||
      reason === "PRICE_CHANGED" ||
      reason === "PRICE_UNAVAILABLE" ||
      reason === "STOCK_UNAVAILABLE" ||
      reason === "COMPOSITE_SELLING_MODE_UNSUPPORTED"
    ) {
      return { ok: false, state: "REJECTED", reason };
    }
    return { ok: false, state: "REJECTED", reason: "ORDER_REJECTED" };
  }
  if (order.state === "POS_SUBMITTING") {
    return { ok: false, state: "POS_SUBMITTING", reason: "SUBMISSION_ALREADY_CLAIMED" };
  }
  if (order.state === "VALIDATING") {
    return { ok: false, state: "VALIDATING", reason: "SUBMISSION_ALREADY_CLAIMED" };
  }
  if (order.state === "DRAFT") {
    return { ok: false, state: "DRAFT", reason: "SUBMISSION_BUSY" };
  }
  return { ok: false, state: "CONFIRMED", reason: "LOCAL_ORDER_INVALID" };
}

export function createPancakeOrderSubmissionService(
  client: PrismaClient,
  gateway: PancakeOrderSubmissionGateway,
  options: PancakeOrderSubmissionOptions = {},
) {
  const readNow = options.now ?? (() => new Date());
  async function submit({
    publicCode,
    shopId,
    beforeExternalWrite,
  }: {
    publicCode: string;
    shopId: number;
    /**
     * The last precondition, evaluated at the write boundary.
     *
     * Everything this service does before calling it is local or read-only against Pancake: the
     * DRAFT claim, the live variation read, repricing, validation. Those can all end the submission
     * with nothing sent. Only past this point may an order exist in Pancake.
     *
     * So a caller holding a resource *for the write* — I6b's capacity hold (ADR 0014 §4) is the
     * one that exists today — claims it here rather than around the whole call, because here is
     * where "claimed" and "a write may be in flight" become the same instant. Returning `false`
     * aborts with nothing sent and the order returned to DRAFT.
     *
     * Per call rather than a service option: the resource belongs to this submission, not to the
     * service.
     */
    beforeExternalWrite?: () => Promise<boolean>;
  }): Promise<PancakeOrderSubmissionResult> {
    const safePublicCode = requirePublicCode(publicCode);
    const safeShopId = requireShopId(shopId);

    const claim = await client.orderMirror.updateMany({
      where: { publicCode: safePublicCode, state: "DRAFT" },
      data: { state: "VALIDATING", syncErrorCode: null },
    });

    if (claim.count !== 1) {
      const current = await client.orderMirror.findUnique({
        where: { publicCode: safePublicCode },
        select: { state: true, pancakeOrderId: true, syncErrorCode: true },
      });
      return current ? existingResult(current) : { ok: false, state: "DRAFT", reason: "ORDER_NOT_FOUND" };
    }

    const order = await client.orderMirror.findUniqueOrThrow({
      where: { publicCode: safePublicCode },
      include: {
        lines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        quoteSnapshot: {
          include: {
            lines: { orderBy: [{ role: "asc" }, { lineId: "asc" }], include: { discountSteps: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });
    const correlationId = order.id;
    emitSafely(options.onEvent, {
      name: "pancake_order.validation_started",
      correlationId,
      state: "VALIDATING",
    });

    async function reject(
      reason: PancakeOrderValidationRejectionReason,
    ): Promise<PancakeOrderSubmissionResult> {
      await client.orderMirror.updateMany({
        where: { id: order.id, state: "VALIDATING" },
        data: { state: "REJECTED", syncErrorCode: reason },
      });
      emitSafely(options.onEvent, {
        name: "pancake_order.validation_rejected",
        correlationId,
        state: "REJECTED",
        reason,
      });
      return { ok: false, state: "REJECTED", reason };
    }

    /**
     * The pricing provenance a finalized line must carry: what the base actually was, and which
     * campaign actually applied. Shared by both refresh paths so the reconfirmation write and the
     * provenance-only write cannot drift apart into two different notions of the audit.
     */
    function buildLineAudit(pricing: ReturnType<typeof resolvePromotionPricing>) {
      const promotion = pricing.promotion;
      return {
        baseUnitPriceVnd: pricing.basePriceVnd === null ? null : BigInt(pricing.basePriceVnd),
        promotionCampaignId: promotion?.id ?? null,
        promotionName: promotion?.name ?? null,
        promotionKind: promotion?.kind ?? null,
        promotionDiscountType: promotion?.discountType ?? null,
        promotionPercentageValue: promotion?.percentageValue ?? null,
        promotionFixedPriceVnd: promotion?.fixedPriceVnd ?? null,
      };
    }

    /**
     * Whether a finalized line would misreport how its price was reached.
     *
     * Deliberately separate from the money comparison. A fresher base behind a still-valid fixed
     * price, or one campaign handing over to another at the same final price, moves nothing the
     * buyer agreed to — so it must not trigger the reconfirmation handshake — but finalizing the
     * stale answer would write a base no upstream reported, or name a campaign that was already
     * over, into a snapshot the spec says is immutable and trustworthy.
     */
    function provenanceDiffers(
      line: (typeof order.lines)[number],
      audit: ReturnType<typeof buildLineAudit>,
    ): boolean {
      return (
        line.baseUnitPriceVnd !== audit.baseUnitPriceVnd ||
        line.promotionCampaignId !== audit.promotionCampaignId ||
        line.promotionName !== audit.promotionName ||
        line.promotionKind !== audit.promotionKind ||
        line.promotionDiscountType !== audit.promotionDiscountType ||
        line.promotionPercentageValue !== audit.promotionPercentageValue ||
        line.promotionFixedPriceVnd !== audit.promotionFixedPriceVnd
      );
    }

    /**
     * Hands a drifted order back to the buyer instead of killing it.
     *
     * `reject` is terminal: it is for orders that must not be placed at all. A price that moved
     * upstream is not that — the buyer simply has not agreed to the new number yet, and the correct
     * outcome is the same two-stage handshake P9a introduced. So this returns the order to `DRAFT`
     * carrying the refreshed quote, and the buyer must confirm it explicitly.
     *
     * The write is one transaction: line, audit and totals move together, because a half-refreshed
     * order is one whose stored totals disagree with its own lines. The guard on `VALIDATING`
     * ensures a submission that lost its claim cannot overwrite whatever took it.
     *
     * The fresher base is also written back to the mirror. Without that, the buyer's reconfirmation
     * re-derives the quote from stale mirrored data, submission finds the fresher base again, and the
     * handshake never terminates — the stale-mirror loop the spec names. Only the two price columns
     * are touched: `syncedAt` means "last reconciled by a catalog sync", which this is not.
     */
    async function repriceDraft(
      refreshed: ReadonlyArray<{
        id: string;
        variantId: string;
        quantity: number;
        freshBaseVnd: number;
        freshAfterDiscountVnd: number;
        pricing: ReturnType<typeof resolvePromotionPricing>;
      }>,
    ): Promise<PancakeOrderSubmissionResult> {
      let refreshedSubtotalVnd = 0;
      let refreshedQuantity = 0;
      const lineWrites: Array<{
        id: string;
        unitPriceVnd: bigint;
        lineTotalVnd: bigint;
        baseUnitPriceVnd: bigint | null;
        promotionCampaignId: string | null;
        promotionName: string | null;
        promotionKind: PromotionCampaignKind | null;
        promotionDiscountType: "PERCENTAGE" | "FIXED_PRICE" | null;
        promotionPercentageValue: number | null;
        promotionFixedPriceVnd: bigint | null;
      }> = [];

      for (const line of refreshed) {
        const unitPriceVnd = line.pricing.effectivePriceVnd;
        const basePriceVnd = line.pricing.basePriceVnd;
        if (unitPriceVnd === null || basePriceVnd === null) return reject("PRICE_UNAVAILABLE");

        const lineTotalVnd = checkedMultiplyVnd(unitPriceVnd, line.quantity);
        const nextSubtotal =
          lineTotalVnd === null ? null : checkedAddVnd(refreshedSubtotalVnd, lineTotalVnd);
        const nextQuantity = refreshedQuantity + line.quantity;
        if (
          lineTotalVnd === null ||
          nextSubtotal === null ||
          !Number.isSafeInteger(nextQuantity) ||
          nextQuantity <= 0
        ) {
          return reject("LOCAL_ORDER_INVALID");
        }
        refreshedSubtotalVnd = nextSubtotal;
        refreshedQuantity = nextQuantity;

        if (line.pricing.isDiscounted && line.pricing.promotion === null) {
          return reject("LOCAL_ORDER_INVALID");
        }

        lineWrites.push({
          id: line.id,
          unitPriceVnd: BigInt(unitPriceVnd),
          lineTotalVnd: BigInt(lineTotalVnd),
          ...buildLineAudit(line.pricing),
        });
      }

      const refreshedShippingVnd = calculateGuestShippingFeeVnd({
        subtotalVnd: refreshedSubtotalVnd,
        totalQuantity: refreshedQuantity,
      });
      const refreshedTotalVnd = checkedAddVnd(refreshedSubtotalVnd, refreshedShippingVnd);
      if (refreshedTotalVnd === null) return reject("LOCAL_ORDER_INVALID");

      const claimed = await client.$transaction(async (tx) => {
        const held = await tx.orderMirror.updateMany({
          where: { id: order.id, state: "VALIDATING" },
          data: {
            state: "DRAFT",
            syncErrorCode: "PRICE_CHANGED",
            merchandiseSubtotalVnd: BigInt(refreshedSubtotalVnd),
            shippingFeeVnd: BigInt(refreshedShippingVnd),
            totalVnd: BigInt(refreshedTotalVnd),
          },
        });
        if (held.count !== 1) return false;

        // `updateMany` rather than `update` throughout: a row that vanished under a concurrent
        // catalog sync should leave the rest of the refresh intact, not abort the transaction and
        // surface to the buyer as an outage.
        for (const write of lineWrites) {
          const { id, ...data } = write;
          await tx.orderLineSnapshot.updateMany({ where: { id }, data });
        }
        for (const line of refreshed) {
          await tx.variantMirror.updateMany({
            where: { id: line.variantId },
            // Both columns carry what Pancake actually reported. Copying the base into the
            // after-discount field would invent an observation: the central resolver ignores that
            // field, but the Merchant identity audit and the default equality-gated price rule both
            // read it, and they would be reading a value no upstream ever sent.
            data: {
              pancakeRetailPrice: line.freshBaseVnd,
              pancakeRetailPriceAfterDiscount: line.freshAfterDiscountVnd,
            },
          });
        }
        return true;
      });

      if (!claimed) {
        return { ok: false, state: "VALIDATING", reason: "SUBMISSION_ALREADY_CLAIMED" };
      }

      emitSafely(options.onEvent, {
        name: "pancake_order.quote_repriced",
        correlationId,
        state: "DRAFT",
        reason: "PRICE_CHANGED",
      });
      return {
        ok: false,
        state: "DRAFT",
        reason: "PRICE_CHANGED",
        repricedQuote: {
          merchandiseSubtotalVnd: refreshedSubtotalVnd,
          shippingFeeVnd: refreshedShippingVnd,
          totalVnd: refreshedTotalVnd,
        },
      };
    }

    /**
     * Corrects the finalized line's pricing provenance without asking the buyer anything.
     *
     * The counterpart to `repriceDraft`: that one exists because the buyer's money moved, this one
     * because it did not. Money columns are deliberately untouched here — `unitPriceVnd`,
     * `lineTotalVnd` and the order totals are exactly what the buyer confirmed, and rewriting them
     * would turn an audit correction into a silent repricing.
     *
     * The mirror is refreshed for the same reason as in the reconfirmation path: this submission
     * observed a fresher trusted base, and dropping it would leave the mirror knowingly stale.
     *
     * The guarded `updateMany` both proves the claim is still held and locks the row for the rest of
     * the transaction, so a submission that lost its claim cannot rewrite whatever took it.
     */
    async function refreshLineProvenance(
      refreshed: ReadonlyArray<{
        id: string;
        variantId: string;
        freshBaseVnd: number;
        freshAfterDiscountVnd: number;
        pricing: ReturnType<typeof resolvePromotionPricing>;
      }>,
    ): Promise<boolean> {
      return client.$transaction(async (tx) => {
        const held = await tx.orderMirror.updateMany({
          where: { id: order.id, state: "VALIDATING" },
          data: { syncErrorCode: null },
        });
        if (held.count !== 1) return false;

        for (const line of refreshed) {
          await tx.orderLineSnapshot.updateMany({
            where: { id: line.id },
            data: buildLineAudit(line.pricing),
          });
          await tx.variantMirror.updateMany({
            where: { id: line.variantId },
            data: {
              pancakeRetailPrice: line.freshBaseVnd,
              pancakeRetailPriceAfterDiscount: line.freshAfterDiscountVnd,
            },
          });
        }
        return true;
      });
    }

    async function resetValidation(): Promise<PancakeOrderSubmissionResult> {
      await client.orderMirror.updateMany({
        where: { id: order.id, state: "VALIDATING" },
        data: { state: "DRAFT", syncErrorCode: "VALIDATION_UNAVAILABLE" },
      });
      emitSafely(options.onEvent, {
        name: "pancake_order.validation_unavailable",
        correlationId,
        state: "DRAFT",
        reason: "VALIDATION_UNAVAILABLE",
      });
      return { ok: false, state: "DRAFT", reason: "VALIDATION_UNAVAILABLE" };
    }

    type LiveCapacityPlan = Readonly<{
      variantId: string;
      sellingMode: ReturnType<typeof resolveSellingPolicy>["sellingMode"];
      resources: readonly Readonly<{
        pancakeVariationId: string;
        units: number;
        floor: number;
      }>[];
    }>;
    type FinalizeInput = Readonly<{
      liveCapacityPlans: readonly LiveCapacityPlan[];
      liveByVariationId: ReadonlyMap<string, PancakeCatalogVariation | null>;
      drifted: boolean;
      freshLines: ReadonlyArray<{
        id: string;
        variantId: string;
        quantity: number;
        freshBaseVnd: number;
        freshAfterDiscountVnd: number;
        pricing: ReturnType<typeof resolvePromotionPricing>;
      }>;
      provenanceDrifted: boolean;
      subtotalVnd: number;
      totalQuantity: number;
      requestLines: ReadonlyArray<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>;
      /**
       * GQ21 -- present for a benefit order: after a definite create, read the order back and confirm it
       * only if the POS kept exactly the lines that were sent. Anything else leaves the order
       * `SYNC_UNKNOWN` (with the Pancake id recorded) for reconciliation and the operator; it is never
       * silently CONFIRMED.
       */
      verifyCreatedOrder?: (pancakeOrderId: string) => Promise<"MATCH" | "DRIFT" | "UNAVAILABLE">;
      /** The order's contact facts, already proven non-empty by the caller (a closure cannot carry that narrowing). */
      contact: Readonly<{
        persistedShopId: number;
        guestName: string;
        guestPhone: string;
        provinceRef: string;
        districtRef: string | null;
        communeRef: string;
        addressDetail: string;
      }>;
    }>;

    /**
     * Everything from the capacity close-out to the confirmed order. Shared by the legacy per-variation
     * path and the benefit path (GQ20), which differ only in how their lines, drift and request lines
     * are established; the write boundary, the create call, the unknown-outcome handling and the
     * confirmation are one implementation, so a benefit order cannot get a weaker one.
     */
    async function finalizeSubmission({
      liveCapacityPlans,
      liveByVariationId,
      drifted,
      freshLines,
      provenanceDrifted,
      subtotalVnd,
      totalQuantity,
      requestLines,
      verifyCreatedOrder,
      contact,
    }: FinalizeInput): Promise<PancakeOrderSubmissionResult> {
    // Close the shared-resource case with the same deterministic allocation order as reservation.
    const pendingByResource = new Map<string, number>();
    const orderedCapacityPlans = [...liveCapacityPlans].sort((left, right) => {
      const leftFlexible = left.sellingMode !== "STANDARD";
      const rightFlexible = right.sellingMode !== "STANDARD";
      if (leftFlexible !== rightFlexible) return leftFlexible ? 1 : -1;
      return left.variantId.localeCompare(right.variantId);
    });
    for (const plan of orderedCapacityPlans) {
      for (const resource of plan.resources) {
        const liveResource = liveByVariationId.get(resource.pancakeVariationId);
        const pending = pendingByResource.get(resource.pancakeVariationId) ?? 0;
        const total = pending + resource.units;
        if (
          !Number.isSafeInteger(total) ||
          !liveResource ||
          !Number.isFinite(liveResource.sellableStock) ||
          liveResource.sellableStock - total < resource.floor
        ) {
          return reject("STOCK_UNAVAILABLE");
        }
      }
      for (const resource of plan.resources) {
        pendingByResource.set(
          resource.pancakeVariationId,
          (pendingByResource.get(resource.pancakeVariationId) ?? 0) + resource.units,
        );
      }
    }

    // Before any totals assertion or outbound call: a drifted quote is not an invalid order, and
    // must not be judged against totals the buyer is about to be asked to replace.
    if (drifted) {
      return repriceDraft(freshLines);
    }

    const shippingFeeVnd = calculateGuestShippingFeeVnd({ subtotalVnd, totalQuantity });
    const totalVnd = checkedAddVnd(subtotalVnd, shippingFeeVnd);
    if (
      totalVnd === null ||
      order.merchandiseSubtotalVnd !== BigInt(subtotalVnd) ||
      order.shippingFeeVnd !== BigInt(shippingFeeVnd) ||
      order.totalVnd !== BigInt(totalVnd)
    ) {
      return reject("LOCAL_ORDER_INVALID");
    }

    // Money is settled and asserted; only the story behind it is stale. Corrected here, before the
    // outbound claim, so the finalized line is already truthful when it becomes immutable. Inside
    // the same pre-write recovery boundary as the reads above: nothing has been sent to Pancake yet,
    // so a transient failure is retryable rather than a stranded claim.
    if (provenanceDrifted) {
      let refreshed: boolean;
      try {
        refreshed = await refreshLineProvenance(freshLines);
      } catch {
        return resetValidation();
      }
      if (!refreshed) {
        const current = await client.orderMirror.findUniqueOrThrow({
          where: { id: order.id },
          select: { state: true, pancakeOrderId: true, syncErrorCode: true },
        });
        return existingResult(current);
      }
    }

    const orderMarker = `[ORDER:${order.publicCode}]`;
    const noteWithMarker = order.note ? `${order.note} ${orderMarker}` : orderMarker;
    const addressDetailWithMarker = `${contact.addressDetail} ${orderMarker}`;

    let geoNames: { provinceName: string; communeName: string } | undefined;
    if (contact.districtRef === null) {
      // Still before the write boundary: a geo outage is a retryable DRAFT, never a half-described
      // address that the POS would render with empty province and ward fields.
      try {
        if (!gateway.resolveTwoLevelAddressNames) return resetValidation();
        geoNames = await gateway.resolveTwoLevelAddressNames(contact.provinceRef, contact.communeRef);
      } catch {
        return resetValidation();
      }
    }

    const request = buildPancakeCreateOrderRequest({
      shopId: contact.persistedShopId,
      ...(geoNames ?? {}),
      ...(options.orderSourceId === undefined ? {} : { orderSourceId: options.orderSourceId }),
      guestName: contact.guestName,
      guestPhone: contact.guestPhone,
      provinceRef: contact.provinceRef,
      districtRef: contact.districtRef,
      communeRef: contact.communeRef,
      addressDetail: addressDetailWithMarker,
      note: noteWithMarker,
      shippingFeeVnd,
      lines: requestLines,
    });

    // The write boundary itself. The request above is pure, so nothing is committed to yet; the
    // update below is what declares a write may be in flight. A caller that cannot claim its
    // resource here gets the same answer as any other pre-write bailout — DRAFT, nothing sent.
    if (beforeExternalWrite && !(await beforeExternalWrite())) {
      return resetValidation();
    }

    const submitting = await client.orderMirror.updateMany({
      where: { id: order.id, state: "VALIDATING" },
      data: { state: "POS_SUBMITTING", syncErrorCode: null, purchaseOccurredAt: readNow() },
    });
    if (submitting.count !== 1) {
      const current = await client.orderMirror.findUniqueOrThrow({
        where: { id: order.id },
        select: { state: true, pancakeOrderId: true, syncErrorCode: true },
      });
      return existingResult(current);
    }

    emitSafely(options.onEvent, {
      name: "pancake_order.create_started",
      correlationId,
      state: "POS_SUBMITTING",
      dependency: "pancake",
      operation: "create_order",
    });

    let pancakeOrderId: string | null = null;
    try {
      const response = await gateway.createOrder(request);
      pancakeOrderId = parsePancakeCreateOrderResponse(response);
    } catch (error) {
      if (
        error instanceof PancakeHttpError &&
        (error.status === 400 ||
          error.status === 401 ||
          error.status === 403 ||
          error.status === 404 ||
          error.status === 422)
      ) {
        await client.orderMirror.updateMany({
          where: { id: order.id, state: "POS_SUBMITTING" },
          data: { state: "REJECTED", syncErrorCode: "ORDER_REJECTED" },
        });
        emitSafely(options.onEvent, {
          name: "pancake_order.create_rejected",
          correlationId,
          state: "REJECTED",
          reason: "ORDER_REJECTED",
        });
        return { ok: false, state: "REJECTED", reason: "ORDER_REJECTED" };
      }

      await client.orderMirror.updateMany({
        where: { id: order.id, state: "POS_SUBMITTING" },
        data: { state: "SYNC_UNKNOWN", syncErrorCode: "CREATE_OUTCOME_UNKNOWN" },
      });
      emitSafely(options.onEvent, {
        name: "pancake_order.create_unknown",
        correlationId,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      return { ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" };
    }

    if (verifyCreatedOrder !== undefined) {
      const verdict = await verifyCreatedOrder(pancakeOrderId);
      if (verdict !== "MATCH") {
        const syncErrorCode = verdict === "DRIFT" ? "RECONCILE_DRIFT" : "READBACK_UNAVAILABLE";
        try {
          await client.orderMirror.updateMany({
            where: { id: order.id, state: "POS_SUBMITTING" },
            data: { state: "SYNC_UNKNOWN", pancakeOrderId, syncErrorCode },
          });
        } catch {
          await client.orderMirror.updateMany({
            where: { id: order.id, state: "POS_SUBMITTING" },
            data: { state: "SYNC_UNKNOWN", syncErrorCode },
          });
        }
        emitSafely(options.onEvent, { name: "pancake_order.benefit_readback_unconfirmed", correlationId, state: "SYNC_UNKNOWN", reason: syncErrorCode });
        return { ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" };
      }
    }

    try {
      const confirmedAt = readNow();
      const confirmed = await client.$transaction(async (tx) => {
        const updated = await tx.orderMirror.updateMany({
          where: { id: order.id, state: "POS_SUBMITTING" },
          data: {
            state: "CONFIRMED",
            pancakeOrderId,
            syncErrorCode: null,
          },
        });
        if (updated.count !== 1) return false;

        // I7 is part of the local CONFIRMED transition. The remote order is already known to exist,
        // and complete I7 capacity metadata is copied into immutable history in this transaction.
        // Rolling/pre-I7 reservations intentionally produce no I7 row rather than re-deriving one
        // from mutable stock or policy after the Pancake write.
        await createPreorderSnapshotAtConfirmation(tx, order.id, confirmedAt);
        return true;
      });
      if (!confirmed) {
        const current = await client.orderMirror.findUniqueOrThrow({
          where: { id: order.id },
          select: { state: true, pancakeOrderId: true, syncErrorCode: true },
        });
        return existingResult(current);
      }
    } catch {
      await client.orderMirror.updateMany({
        where: { id: order.id, state: "POS_SUBMITTING" },
        data: { state: "SYNC_UNKNOWN", syncErrorCode: "CREATE_OUTCOME_UNKNOWN" },
      });
      emitSafely(options.onEvent, {
        name: "pancake_order.create_unknown",
        correlationId,
        state: "SYNC_UNKNOWN",
        reason: "CREATE_OUTCOME_UNKNOWN",
      });
      return { ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" };
    }

    emitSafely(options.onEvent, {
      name: "pancake_order.confirmed",
      correlationId,
      state: "CONFIRMED",
    });
    return { ok: true, state: "CONFIRMED", pancakeOrderId };
    }

    type BenefitSnapshot = NonNullable<typeof order.quoteSnapshot>;

    /** Back to DRAFT with nothing read from or sent to Pancake: the benefit path is closed for this order. */
    async function withholdBenefitOrder(): Promise<PancakeOrderSubmissionResult> {
      await client.orderMirror.updateMany({
        where: { id: order.id, state: "VALIDATING" },
        data: { state: "DRAFT", syncErrorCode: "BENEFIT_SUBMISSION_UNAVAILABLE" },
      });
      emitSafely(options.onEvent, {
        name: "pancake_order.benefit_submission_withheld",
        correlationId,
        state: "DRAFT",
        reason: "BENEFIT_SUBMISSION_UNAVAILABLE",
      });
      return { ok: false, state: "DRAFT", reason: "BENEFIT_SUBMISSION_UNAVAILABLE" };
    }

    /**
     * GQ20 -- the submission of an order that carries a benefit quote (gifts or quantity-tier segments).
     *
     * What differs from the legacy path, and nothing else:
     *  - it runs only for a shop whose line-level pricing was accepted live (GQ01);
     *  - the lines sent are the stored Pancake projection (ADR 0016 D-08), re-derived here from the
     *    signed lines and compared with what was frozen, so a tampered or stale projection is never sent;
     *  - stock is judged on the physical demand of the order: paid segments and gift units of one
     *    variant add up, and a variant that carries a gift is judged as READY stock only;
     *  - the fresh-base recheck compares the live Pancake base, the legacy campaign behind the first
     *    discount step and the liveness of every tier / gift campaign with what the quote recorded.
     *    Any difference sends the order back to DRAFT for a re-quote; nothing is repriced in place,
     *    because the quote rows are signed history, not working data.
     * The write boundary, the create call, the unknown-outcome handling and the confirmation are the
     * shared tail (`finalizeSubmission`).
     */
    async function submitBenefitOrder(
      snapshot: BenefitSnapshot,
      shopId: number,
    ): Promise<PancakeOrderSubmissionResult> {
      const verifiedShops = options.lineLevelPricingVerifiedShopIds ?? readLineLevelPricingVerifiedShopIds();
      if (!verifiedShops.includes(shopId)) return withholdBenefitOrder();

      // The projection is a pure function of the signed lines. Re-derive it and compare with the frozen
      // copy; the order totals must be the quote's, and the vendor total must be the website total.
      const projection = projectBenefitQuoteForVendor(
        snapshot.lines.map((line) => ({
          lineId: line.lineId,
          role: line.role,
          pancakeVariationId: line.pancakeVariationId,
          quantity: line.quantity,
          unitPriceVnd: Number(line.unitPriceVnd),
        })),
      );
      const stored = Array.isArray(snapshot.vendorProjection)
        ? (snapshot.vendorProjection as unknown as Array<{ pancakeVariationId: string; quantity: number; unitPriceVnd: number }>)
        : null;
      if (
        !projection.ok ||
        snapshot.vendorProjectionHash !== projection.hash ||
        stored === null ||
        stored.length !== projection.lines.length ||
        stored.some((line, index) => {
          const expected = projection.lines[index]!;
          return line.pancakeVariationId !== expected.pancakeVariationId || line.quantity !== expected.quantity || line.unitPriceVnd !== expected.unitPriceVnd;
        }) ||
        BigInt(projection.paidTotalVnd) !== snapshot.paidSubtotalVnd ||
        order.merchandiseSubtotalVnd !== snapshot.paidSubtotalVnd
      ) {
        return reject("LOCAL_ORDER_INVALID");
      }

      type Demand = { variantId: string; pancakeVariationId: string; paid: number; gift: number };
      const demandByVariant = new Map<string, Demand>();
      for (const line of snapshot.lines) {
        const demand = demandByVariant.get(line.variantId) ?? { variantId: line.variantId, pancakeVariationId: line.pancakeVariationId, paid: 0, gift: 0 };
        if (demand.pancakeVariationId !== line.pancakeVariationId) return reject("LOCAL_ORDER_INVALID");
        if (line.role === "GIFT") demand.gift += line.quantity;
        else demand.paid += line.quantity;
        demandByVariant.set(line.variantId, demand);
      }
      if (demandByVariant.size === 0 || demandByVariant.size > ANONYMOUS_CART_MAX_DISTINCT_ITEMS + 100) return reject("LOCAL_ORDER_INVALID");
      const demandVariantIds = [...demandByVariant.keys()];
      const paidVariantIds = [...demandByVariant.values()].filter((demand) => demand.paid > 0).map((demand) => demand.variantId);

      let campaignsByVariantId: ApplicableCampaignLookup["campaignsByVariantId"];
      let activeBenefitRevisions: ReadonlyMap<string, number>;
      let variantMetaById: Map<
        string,
        {
          policy: ReturnType<typeof resolveSellingPolicy>;
          isComposite: boolean;
          components: readonly Readonly<{ requiredQuantity: number; pancakeVariationId: string; isUsable: boolean }>[];
        }
      >;
      try {
        const [campaignsResult, variantsResult, activeBenefits] = await Promise.all([
          readApplicablePromotionCampaignsBatched({
            variantIds: paidVariantIds,
            client: client as unknown as PromotionCandidateReadClient,
          }),
          client.variantMirror.findMany({
            where: { id: { in: demandVariantIds } },
            select: {
              id: true,
              product: { select: { sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } } } },
              compositeComponents: {
                orderBy: [{ componentVariantId: "asc" }],
                select: {
                  quantity: true,
                  componentVariant: {
                    select: {
                      pancakeVariationId: true,
                      isPresent: true,
                      product: { select: { pancakeShopId: true, isPresent: true } },
                    },
                  },
                },
              },
            },
          }),
          // Every benefit campaign the quote relied on must still be in force. The listing is the same
          // bounded read the cart uses; scope is not re-evaluated, only liveness and revision.
          readActiveGiftQuantityCampaigns({
            now: readNow(),
            productIds: [],
            client: client as unknown as GiftQuantityCandidateReadClient,
            ...(options.env === undefined ? {} : { env: options.env }),
          }),
        ]);
        campaignsByVariantId = campaignsResult.campaignsByVariantId;
        activeBenefitRevisions = new Map(activeBenefits.campaigns.map((entry) => [entry.campaign.id, entry.campaign.revision]));
        variantMetaById = new Map(
          variantsResult.map((v) => [
            v.id,
            {
              policy: resolveSellingPolicy(v.product?.sellingPolicy),
              isComposite: v.compositeComponents.length > 0,
              components: v.compositeComponents.map((edge) => ({
                requiredQuantity: edge.quantity,
                pancakeVariationId: edge.componentVariant.pancakeVariationId,
                isUsable: edge.componentVariant.isPresent && edge.componentVariant.product.isPresent && edge.componentVariant.product.pancakeShopId === shopId,
              })),
            },
          ]),
        );
      } catch {
        return resetValidation();
      }

      const liveVariationIds = new Set<string>();
      for (const demand of demandByVariant.values()) liveVariationIds.add(demand.pancakeVariationId);
      for (const meta of variantMetaById.values()) for (const component of meta.components) liveVariationIds.add(component.pancakeVariationId);
      let liveVariations: readonly PancakeCatalogVariation[];
      try {
        liveVariations = await gateway.fetchVariations(shopId, [...liveVariationIds]);
      } catch {
        return resetValidation();
      }
      const now = readNow();
      const liveByVariationId = new Map<string, PancakeCatalogVariation | null>();
      for (const variation of liveVariations) {
        liveByVariationId.set(variation.id, liveByVariationId.has(variation.id) ? null : variation);
      }

      let requote = false;
      const mirrorRefresh: Array<{ variantId: string; freshBaseVnd: number; freshAfterDiscountVnd: number }> = [];
      const liveCapacityPlans: LiveCapacityPlan[] = [];
      for (const demand of demandByVariant.values()) {
        const live = liveByVariationId.get(demand.pancakeVariationId);
        if (!live) return reject("VARIATION_UNAVAILABLE");
        const meta = variantMetaById.get(demand.variantId) ?? { policy: resolveSellingPolicy(null), isComposite: false, components: [] };

        if (demand.paid > 0) {
          if (!isUsableBasePriceVnd(live.retailPrice)) return reject("PRICE_UNAVAILABLE");
          const paidLines = snapshot.lines.filter((line) => line.role === "PAID" && line.variantId === demand.variantId);
          const base = paidLines[0]!.baseUnitPriceVnd ?? paidLines[0]!.unitPriceVnd;
          const firstLegacy = paidLines[0]!.discountSteps.find((step) => step.source === "LEGACY") ?? null;
          const fresh = resolvePromotionPricing({ basePriceVnd: live.retailPrice, campaigns: campaignsByVariantId.get(demand.variantId) ?? [], now });
          const legacyHolds = firstLegacy === null
            ? !fresh.isDiscounted
            : fresh.promotion?.id === firstLegacy.campaignId && BigInt(fresh.effectivePriceVnd ?? -1) === firstLegacy.outputPriceVnd;
          if (BigInt(live.retailPrice) !== base || !legacyHolds) {
            requote = true;
            mirrorRefresh.push({ variantId: demand.variantId, freshBaseVnd: live.retailPrice, freshAfterDiscountVnd: live.retailPriceAfterDiscount });
          }
        }

        // A variant that also carries a gift is judged as READY stock only (ADR 0016 D-04): the paid
        // units may be flexible, the free ones may not. Otherwise the variant keeps its own policy.
        const floor = demand.gift > 0 ? 0 : capacityFloorForMode(meta.policy.sellingMode, meta.policy.negativeStockLimit);
        const units = demand.paid + demand.gift;
        const resources: Array<{ pancakeVariationId: string; units: number; floor: number }> = [];
        if (meta.isComposite) {
          if (demand.gift > 0) return reject("COMPOSITE_SELLING_MODE_UNSUPPORTED");
          for (const component of meta.components) {
            const componentUnits = units * component.requiredQuantity;
            const liveComponent = liveByVariationId.get(component.pancakeVariationId);
            if (
              !component.isUsable ||
              !Number.isSafeInteger(component.requiredQuantity) ||
              component.requiredQuantity <= 0 ||
              !Number.isSafeInteger(componentUnits) ||
              !liveComponent ||
              !Number.isFinite(liveComponent.sellableStock) ||
              liveComponent.sellableStock - componentUnits < floor
            ) {
              return reject("STOCK_UNAVAILABLE");
            }
            resources.push({ pancakeVariationId: component.pancakeVariationId, units: componentUnits, floor });
          }
        } else {
          if (!Number.isFinite(live.sellableStock) || live.sellableStock - units < floor) return reject("STOCK_UNAVAILABLE");
          resources.push({ pancakeVariationId: demand.pancakeVariationId, units, floor });
        }
        liveCapacityPlans.push({ variantId: demand.variantId, sellingMode: demand.gift > 0 ? "STANDARD" : meta.policy.sellingMode, resources });
      }

      // Liveness of the benefit campaigns behind the quote: a tier that ended, or a gift campaign that
      // ended or was edited (revision), makes the signed quote stale even when Pancake's prices did not move.
      for (const line of snapshot.lines) {
        if (line.role === "GIFT" && activeBenefitRevisions.get(line.campaignId ?? "") !== line.campaignRevision) requote = true;
        for (const step of line.discountSteps) if (step.source === "QUANTITY_TIER" && !activeBenefitRevisions.has(step.campaignId)) requote = true;
      }

      if (requote) {
        await client.$transaction(async (tx) => {
          const held = await tx.orderMirror.updateMany({
            where: { id: order.id, state: "VALIDATING" },
            data: { state: "DRAFT", syncErrorCode: "BENEFIT_REQUOTE_REQUIRED" },
          });
          if (held.count !== 1) return;
          // The fresher base is written back to the mirror, exactly as the legacy reprice does, so the
          // buyer's re-quote starts from what Pancake reported and the handshake terminates.
          for (const line of mirrorRefresh) {
            await tx.variantMirror.updateMany({
              where: { id: line.variantId },
              data: { pancakeRetailPrice: line.freshBaseVnd, pancakeRetailPriceAfterDiscount: line.freshAfterDiscountVnd },
            });
          }
        });
        emitSafely(options.onEvent, { name: "pancake_order.benefit_requote_required", correlationId, state: "DRAFT", reason: "BENEFIT_REQUOTE_REQUIRED" });
        return { ok: false, state: "DRAFT", reason: "BENEFIT_REQUOTE_REQUIRED" };
      }

      return finalizeSubmission({
        liveCapacityPlans,
        liveByVariationId,
        drifted: false,
        freshLines: [],
        provenanceDrifted: false,
        subtotalVnd: Number(snapshot.paidSubtotalVnd),
        totalQuantity: snapshot.paidQuantity,
        requestLines: projection.lines,
        verifyCreatedOrder: async (pancakeOrderId) => {
          if (!gateway.readOrder) return "UNAVAILABLE";
          try {
            return compareOrderReadBack(projection.lines, await gateway.readOrder(shopId, pancakeOrderId)).kind === "MATCH" ? "MATCH" : "DRIFT";
          } catch {
            return "UNAVAILABLE";
          }
        },
        contact: {
          persistedShopId: shopId,
          guestName: order.guestName as string,
          guestPhone: order.guestPhone as string,
          provinceRef: order.provinceRef as string,
          districtRef: order.districtRef,
          communeRef: order.communeRef as string,
          addressDetail: order.addressDetail as string,
        },
      });
    }

    if (order.pancakeShopId === null || order.pancakeShopId !== safeShopId) {
      return reject("SHOP_SCOPE_UNVERIFIED");
    }
    const persistedShopId = order.pancakeShopId;

    if (
      order.checkoutSnapshottedAt === null ||
      !isNormalizedNonEmptyString(order.guestName) ||
      !isNormalizedNonEmptyString(order.guestPhone) ||
      !isNormalizedNonEmptyString(order.provinceRef) ||
      // `null` is the two-level address; a legacy three-level draft still carries a district.
      !(order.districtRef === null || isNormalizedNonEmptyString(order.districtRef)) ||
      !isNormalizedNonEmptyString(order.communeRef) ||
      !isNormalizedNonEmptyString(order.addressDetail) ||
      !isNormalizedOptionalString(order.note) ||
      order.merchandiseSubtotalVnd === null ||
      order.shippingFeeVnd === null ||
      order.totalVnd === null ||
      order.lines.length === 0 ||
      // A benefit order stores one row per price segment, so its bound is the quote's, not the cart's.
      order.lines.length > (order.quoteSnapshot ? 200 : ANONYMOUS_CART_MAX_DISTINCT_ITEMS)
    ) {
      return reject("LOCAL_ORDER_INVALID");
    }

    if (order.quoteSnapshot) return submitBenefitOrder(order.quoteSnapshot, persistedShopId);

    // Inside the same pre-write recovery boundary as the live Pancake read below, and for the same
    // reason: the claim has moved the row to `VALIDATING`, but nothing has been sent to Pancake yet.
    // A transient failure resolving promotion candidates is therefore retryable, not fatal. Letting
    // it escape would leave the row `VALIDATING`, which the recovery sweep converts to a terminal
    // `REJECTED / VALIDATION_INTERRUPTED` fifteen minutes later — killing an order that only needed
    // to be tried again.
    let campaignsByVariantId: ApplicableCampaignLookup["campaignsByVariantId"];
    let variantMetaById: Map<
      string,
      {
        policy: ReturnType<typeof resolveSellingPolicy>;
        isComposite: boolean;
        components: readonly Readonly<{
          requiredQuantity: number;
          pancakeVariationId: string;
          isUsable: boolean;
        }>[];
      }
    >;
    try {
      const [campaignsResult, variantsResult] = await Promise.all([
        readApplicablePromotionCampaignsBatched({
          variantIds: order.lines.map(({ variantId }) => variantId),
          client: client as unknown as PromotionCandidateReadClient,
        }),
        client.variantMirror.findMany({
          where: { id: { in: order.lines.map(({ variantId }) => variantId) } },
          select: {
            id: true,
            product: {
              select: {
                sellingPolicy: {
                  select: {
                    sellingMode: true,
                    negativeStockLimit: true,
                  },
                },
              },
            },
            // ADR 0014: a STANDARD composite's capacity is its components' stock, never the
            // parent's own Pancake row. The edges name which live variations to read and how many
            // units of each one line consumes.
            compositeComponents: {
              orderBy: [{ componentVariantId: "asc" }],
              select: {
                quantity: true,
                componentVariant: {
                  select: {
                    pancakeVariationId: true,
                    isPresent: true,
                    product: { select: { pancakeShopId: true, isPresent: true } },
                  },
                },
              },
            },
          },
        }),
      ]);
      campaignsByVariantId = campaignsResult.campaignsByVariantId;
      variantMetaById = new Map(
        variantsResult.map((v) => [
          v.id,
          {
            policy: resolveSellingPolicy(v.product?.sellingPolicy),
            isComposite: v.compositeComponents.length > 0,
            components: v.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              pancakeVariationId: edge.componentVariant.pancakeVariationId,
              isUsable:
                edge.componentVariant.isPresent &&
                edge.componentVariant.product.isPresent &&
                edge.componentVariant.product.pancakeShopId === persistedShopId,
            })),
          },
        ]),
      );
    } catch {
      return resetValidation();
    }

    // Only the variations this order can consume: each line's own row, plus every component a
    // composite line draws on. Read after the local metadata because that is where the component
    // edges live. Same pre-write recovery boundary as the reads above — nothing has been sent yet.
    const liveVariationIds = new Set<string>();
    for (const line of order.lines) {
      if (isNormalizedNonEmptyString(line.pancakeVariationId)) {
        liveVariationIds.add(line.pancakeVariationId);
      }
    }
    for (const meta of variantMetaById.values()) {
      for (const component of meta.components) {
        if (isNormalizedNonEmptyString(component.pancakeVariationId)) {
          liveVariationIds.add(component.pancakeVariationId);
        }
      }
    }

    let liveVariations: readonly PancakeCatalogVariation[];
    try {
      liveVariations = await gateway.fetchVariations(persistedShopId, [...liveVariationIds]);
    } catch {
      return resetValidation();
    }

    // The fresher base is only half the answer. A website sale is `resolvePromotionPricing(base,
    // campaigns)`, so comparing a promoted DRAFT against raw Pancake retail would refuse every
    // correctly discounted order; and a percentage campaign against a moved base yields a different
    // number that the buyer has not agreed to. Both sides of the comparison therefore go through the
    // one resolver, at one instant.
    //
    // That instant is read only now, after the live Pancake answer is in: a campaign that ends while
    // the request is in flight must be priced as ended, not by a clock read before it went out.
    // Campaign *candidates* above are window-independent, so reading them earlier changes nothing.
    const now = readNow();

    const liveByVariationId = new Map<string, PancakeCatalogVariation | null>();
    for (const variation of liveVariations) {
      if (liveByVariationId.has(variation.id)) {
        liveByVariationId.set(variation.id, null);
      } else {
        liveByVariationId.set(variation.id, variation);
      }
    }

    const requestedVariationIds = new Set<string>();
    const requestLines: Array<{
      pancakeVariationId: string;
      quantity: number;
      unitPriceVnd: number;
    }> = [];
    const freshLines: Array<{
      id: string;
      variantId: string;
      quantity: number;
      freshBaseVnd: number;
      freshAfterDiscountVnd: number;
      pricing: ReturnType<typeof resolvePromotionPricing>;
    }> = [];
    let drifted = false;
    let provenanceDrifted = false;
    let subtotalVnd = 0;
    let totalQuantity = 0;
    // Preserve each line's policy while accumulating shared physical resources. STANDARD demand is
    // applied first, then flexible demand, matching reserveOrderCapacity(). Collapsing these to one
    // aggregate floor either rejects a valid flexible tail or lets STANDARD borrow negative headroom.
    const liveCapacityPlans: LiveCapacityPlan[] = [];

    for (const line of order.lines) {
      if (
        !isNormalizedNonEmptyString(line.pancakeVariationId) ||
        requestedVariationIds.has(line.pancakeVariationId) ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        return reject("LOCAL_ORDER_INVALID");
      }
      requestedVariationIds.add(line.pancakeVariationId);

      const live = liveByVariationId.get(line.pancakeVariationId);
      if (!live) {
        return reject("VARIATION_UNAVAILABLE");
      }

      const variantMeta = variantMetaById.get(line.variantId) ?? {
        policy: resolveSellingPolicy(null),
        isComposite: false,
        components: [],
      };

      // Composite products now support OVERSELL and PREORDER with component-aware accounting.

      // Deliberately `retailPrice` alone, matching the central authority: a lower Pancake
      // after-discount field is an order-level rule there, not a catalog price, so it neither sets
      // nor invalidates the website price.
      if (!isUsableBasePriceVnd(live.retailPrice)) {
        return reject("PRICE_UNAVAILABLE");
      }
      const freshPricing = resolvePromotionPricing({
        basePriceVnd: live.retailPrice,
        campaigns: campaignsByVariantId.get(line.variantId) ?? [],
        now,
      });
      const freshUnitPriceVnd = freshPricing.effectivePriceVnd;
      if (freshUnitPriceVnd === null || !isSupportedVndAmount(freshUnitPriceVnd)) {
        return reject("PRICE_UNAVAILABLE");
      }

      const floor = capacityFloorForMode(
        variantMeta.policy.sellingMode,
        variantMeta.policy.negativeStockLimit,
      );
      const lineResources: Array<{
        pancakeVariationId: string;
        units: number;
        floor: number;
      }> = [];
      if (variantMeta.isComposite) {
        // PR #81: a composite parent's own Pancake stock is not its capacity (a COMBO or an
        // inactive SET VÁY sibling is routinely 0 there while its pieces are stocked), so it is not
        // read. Each component must be a present, same-shop variation that is uniquely live now,
        // with enough units for this line under this composite product's resolved selling policy.
        for (const component of variantMeta.components) {
          const units = line.quantity * component.requiredQuantity;
          const liveComponent = liveByVariationId.get(component.pancakeVariationId);
          if (
            !component.isUsable ||
            !Number.isSafeInteger(component.requiredQuantity) ||
            component.requiredQuantity <= 0 ||
            !Number.isSafeInteger(units) ||
            !liveComponent ||
            !Number.isFinite(liveComponent.sellableStock) ||
            liveComponent.sellableStock - units < floor
          ) {
            return reject("STOCK_UNAVAILABLE");
          }
          lineResources.push({
            pancakeVariationId: component.pancakeVariationId,
            units,
            floor,
          });
        }
      } else {
        if (!Number.isFinite(live.sellableStock)) {
          return reject("STOCK_UNAVAILABLE");
        }
        if (live.sellableStock - line.quantity < floor) {
          return reject("STOCK_UNAVAILABLE");
        }
        lineResources.push({
          pancakeVariationId: line.pancakeVariationId,
          units: line.quantity,
          floor,
        });
      }
      liveCapacityPlans.push({
        variantId: line.variantId,
        sellingMode: variantMeta.policy.sellingMode,
        resources: lineResources,
      });
      if (line.unitPriceVnd !== BigInt(freshUnitPriceVnd)) {
        drifted = true;
      } else if (provenanceDiffers(line, buildLineAudit(freshPricing))) {
        // Same money, different story about how it was reached. Not a buyer-facing change, so it
        // must not trigger the handshake — but it is still wrong to finalize.
        provenanceDrifted = true;
      }
      freshLines.push({
        id: line.id,
        variantId: line.variantId,
        quantity: line.quantity,
        freshBaseVnd: live.retailPrice,
        freshAfterDiscountVnd: live.retailPriceAfterDiscount,
        pricing: freshPricing,
      });

      const lineTotalVnd = checkedMultiplyVnd(Number(line.unitPriceVnd), line.quantity);
      const nextSubtotal = lineTotalVnd === null ? null : checkedAddVnd(subtotalVnd, lineTotalVnd);
      const nextQuantity = totalQuantity + line.quantity;
      if (
        lineTotalVnd === null ||
        nextSubtotal === null ||
        !Number.isSafeInteger(nextQuantity) ||
        nextQuantity <= 0 ||
        line.lineTotalVnd !== BigInt(lineTotalVnd)
      ) {
        return reject("LOCAL_ORDER_INVALID");
      }

      subtotalVnd = nextSubtotal;
      totalQuantity = nextQuantity;
      requestLines.push({
        pancakeVariationId: line.pancakeVariationId,
        quantity: line.quantity,
        // The money the buyer confirmed, which the drift check above has just established equals the
        // fresh effective quote. Sending the live base here instead would charge full price for a
        // line the website sold at a discount.
        unitPriceVnd: Number(line.unitPriceVnd),
      });
    }

    return finalizeSubmission({
      liveCapacityPlans,
      liveByVariationId,
      drifted,
      freshLines,
      provenanceDrifted,
      subtotalVnd,
      totalQuantity,
      requestLines,
      contact: {
        persistedShopId,
        guestName: order.guestName,
        guestPhone: order.guestPhone,
        provinceRef: order.provinceRef,
        districtRef: order.districtRef,
        communeRef: order.communeRef,
        addressDetail: order.addressDetail,
      },
    });
  }

  return {
    async submit(input: Parameters<typeof submit>[0]) {
      const result = await submit(input);
      if (result.ok) {
        try { await (options.onConfirmed ?? ((code) => reportMetaPurchaseSafely(client, code)))(input.publicCode); }
        catch { console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", reason: "SCHEDULING_FAILED" })); }
      }
      return result;
    },
  };
}
