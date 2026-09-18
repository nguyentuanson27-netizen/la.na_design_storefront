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
import { isUsableBasePriceVnd, resolvePromotionPricing } from "./promotion-pricing.ts";
import { createPreorderSnapshotAtConfirmation } from "./preorder-order-snapshot-repository.ts";

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
  | "ORDER_REJECTED";

type PancakeOrderValidationRejectionReason = Extract<
  PancakeOrderSubmissionReason,
  | "LOCAL_ORDER_INVALID"
  | "SHOP_SCOPE_UNVERIFIED"
  | "VARIATION_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "PRICE_UNAVAILABLE"
  | "STOCK_UNAVAILABLE"
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
      name: "pancake_order.validation_unavailable";
      correlationId: string;
      state: "DRAFT";
      reason: "VALIDATION_UNAVAILABLE";
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
  fetchCompleteCatalog(shopId: number): Promise<readonly PancakeCatalogVariation[]>;
  createOrder(request: PancakeCreateOrderRequest): Promise<unknown>;
};

export type PancakeOrderSubmissionOptions = {
  onEvent?: (event: PancakeOrderSubmissionEvent) => void;
  /**
   * The instant every campaign window is evaluated against for this submission.
   *
   * Injected rather than read inside the loop so one submission cannot straddle a campaign
   * boundary and price two lines of the same order against different instants.
   */
  now?: () => Date;
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
      reason === "STOCK_UNAVAILABLE"
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
     * DRAFT claim, the live catalog fetch, repricing, validation. Those can all end the submission
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
      include: { lines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
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
        promotionKind: "PROMOTION" | "FLASH_SALE" | null;
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

    if (order.pancakeShopId === null || order.pancakeShopId !== safeShopId) {
      return reject("SHOP_SCOPE_UNVERIFIED");
    }
    const persistedShopId = order.pancakeShopId;

    if (
      order.checkoutSnapshottedAt === null ||
      !isNormalizedNonEmptyString(order.guestName) ||
      !isNormalizedNonEmptyString(order.guestPhone) ||
      !isNormalizedNonEmptyString(order.provinceRef) ||
      !isNormalizedNonEmptyString(order.districtRef) ||
      !isNormalizedNonEmptyString(order.communeRef) ||
      !isNormalizedNonEmptyString(order.addressDetail) ||
      !isNormalizedOptionalString(order.note) ||
      order.merchandiseSubtotalVnd === null ||
      order.shippingFeeVnd === null ||
      order.totalVnd === null ||
      order.lines.length === 0 ||
      order.lines.length > ANONYMOUS_CART_MAX_DISTINCT_ITEMS
    ) {
      return reject("LOCAL_ORDER_INVALID");
    }

    let liveCatalog: readonly PancakeCatalogVariation[];
    try {
      liveCatalog = await gateway.fetchCompleteCatalog(persistedShopId);
    } catch {
      return resetValidation();
    }

    const liveByVariationId = new Map<string, PancakeCatalogVariation | null>();
    for (const variation of liveCatalog) {
      if (liveByVariationId.has(variation.id)) {
        liveByVariationId.set(variation.id, null);
      } else {
        liveByVariationId.set(variation.id, variation);
      }
    }

    // The fresher base is only half the answer. A website sale is `resolvePromotionPricing(base,
    // campaigns)`, so comparing a promoted DRAFT against raw Pancake retail would refuse every
    // correctly discounted order; and a percentage campaign against a moved base yields a different
    // number that the buyer has not agreed to. Both sides of the comparison therefore go through the
    // one resolver, at one instant.
    const now = readNow();
    // Inside the same pre-write recovery boundary as the catalog read above, and for the same
    // reason: the claim has moved the row to `VALIDATING`, but nothing has been sent to Pancake yet.
    // A transient failure resolving promotion candidates is therefore retryable, not fatal. Letting
    // it escape would leave the row `VALIDATING`, which the recovery sweep converts to a terminal
    // `REJECTED / VALIDATION_INTERRUPTED` fifteen minutes later — killing an order that only needed
    // to be tried again.
    let campaignsByVariantId: ApplicableCampaignLookup["campaignsByVariantId"];
    try {
      ({ campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
        variantIds: order.lines.map(({ variantId }) => variantId),
        client: client as unknown as PromotionCandidateReadClient,
      }));
    } catch {
      return resetValidation();
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
      if (!Number.isFinite(live.sellableStock) || live.sellableStock < line.quantity) {
        return reject("STOCK_UNAVAILABLE");
      }
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

    const request = buildPancakeCreateOrderRequest({
      shopId: persistedShopId,
      guestName: order.guestName,
      guestPhone: order.guestPhone,
      provinceRef: order.provinceRef,
      districtRef: order.districtRef,
      communeRef: order.communeRef,
      addressDetail: order.addressDetail,
      note: order.note,
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
      data: { state: "POS_SUBMITTING", syncErrorCode: null },
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

    let pancakeOrderId: string;
    try {
      const response = await gateway.createOrder(request);
      pancakeOrderId = parsePancakeCreateOrderResponse(response);
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
        // but the local state and its immutable preorder history must commit together. If the
        // snapshot cannot be produced from authoritative line/policy/stock facts, the transaction
        // rolls back and the existing ambiguous-write recovery path keeps the order fail-closed.
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

  return { submit };
}
