import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { ANONYMOUS_CART_MAX_DISTINCT_ITEMS } from "./anonymous-cart.ts";
import { resolveSellingPolicy, type ReservationState } from "./capacity-policy.ts";
import { mergeReservationLines } from "./capacity-reservation.ts";
import { parseGuestCheckoutInput } from "./guest-checkout-input.ts";
import { calculateGuestShippingFeeVnd } from "./guest-shipping-policy.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import type { PromotionCandidateReadClient } from "./promotion-candidate-repository.ts";
import type {
  RenderedQuoteProofFacts,
  RenderedQuoteProofRejection,
} from "./checkout-quote-proof.ts";
import type { PromotionCampaignKind, PromotionPricingResult } from "./promotion-pricing.ts";
import { buildStorefrontCartLines } from "./storefront-cart.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_PUBLIC_CODE_LENGTH = 128;
/**
 * Whether an order's existing holds are exactly the basket now being snapshotted.
 *
 * The same comparison `reserveOrderCapacity` makes, so the two cannot disagree about what "the same
 * basket" means: merged per variant, and equal on both the set of variants and each quantity.
 */
function reservationsMatchBasket(
  holds: readonly { variantId: string; quantity: number }[],
  items: readonly { variantId: string; quantity: number }[],
): boolean {
  const requested = mergeReservationLines(items);
  if (holds.length !== requested.length) return false;
  const heldByVariantId = new Map(holds.map((hold) => [hold.variantId, hold.quantity]));
  return requested.every((line) => heldByVariantId.get(line.variantId) === line.quantity);
}

/**
 * Whether this order's holds are still a live claim on the basket being snapshotted.
 *
 * Matching the basket is not enough. An expired hold keeps its variant and quantity, so it still
 * *looks* like the basket while no longer holding anything — and `reserveOrderCapacity` refuses it
 * as `reservation-conflict` because a `RELEASED` row does not hold capacity. An order whose holds
 * lapsed therefore has to be superseded exactly like one whose basket changed: same dead end, same
 * remedy, and the reserve boundary's rule is the one both have to agree with.
 */
function holdsAreLiveFor(
  holds: readonly { variantId: string; quantity: number; state: ReservationState }[],
  items: readonly { variantId: string; quantity: number }[],
): boolean {
  if (!holds.every((hold) => hold.state === "RESERVED" || hold.state === "SUBMITTING")) return false;
  return reservationsMatchBasket(holds, items);
}

const ACTIVE_CHECKOUT_STATES = [
  "DRAFT",
  "VALIDATING",
  "POS_SUBMITTING",
  "CONFIRMED",
  "SYNC_UNKNOWN",
] as const;

type ActiveCheckoutState = (typeof ACTIVE_CHECKOUT_STATES)[number];

type CheckoutFailureReason =
  | "INVALID_INPUT"
  | "CART_UNAVAILABLE"
  | "CART_EMPTY"
  | "CART_LINE_UNAVAILABLE"
  | "MONEY_UNSUPPORTED"
  | "PUBLIC_CODE_UNAVAILABLE";

type CheckoutSnapshotResult =
  | {
      ok: true;
      order: {
        /** ADR 0014 §3 makes the order the reservation's idempotency key, so I6b needs it. */
        id: string;
        publicCode: string;
        state: ActiveCheckoutState;
        merchandiseSubtotalVnd: bigint;
        shippingFeeVnd: bigint;
        totalVnd: bigint;
        /** The committed basket, as persisted. One entry per line; I6b merges by variant (§7). */
        lines: readonly { variantId: string; quantity: number }[];
      };
      /**
       * F8b — the fulfillment state each line carried in the quote this attempt authenticated.
       *
       * Empty on the paths that return an existing checkout without re-verifying a proof: there is
       * no promise made on *this* attempt to hold the reservation to, and inventing one would be
       * worse than declaring none. `reserveOrderCapacity()` compares only what it is given.
       */
      verifiedFulfillmentStateByVariantId: ReadonlyMap<string, "READY" | "PREORDER">;
    }
  | { ok: false; reason: CheckoutFailureReason }
  /**
   * The buyer has not demonstrably seen this price. Carries the quote the server just computed so
   * the caller can show refreshed money and issue a fresh proof; no DRAFT is left submit-capable.
   */
  | {
      ok: false;
      reason: "QUOTE_UNPROVEN";
      quoteReason: RenderedQuoteProofRejection;
      refreshedQuote: RenderedQuoteProofFacts;
    };

/**
 * Decides whether the authoritative quote this transaction just computed is the one the buyer was
 * shown. Required rather than optional: a snapshot service constructed without it would create
 * submit-capable DRAFTs at prices nobody proved, and that is exactly the P9a failure. Callers that
 * are exercising something else pass an explicitly accepting verifier, which is greppable.
 */
export type RenderedQuoteVerifier = (
  facts: RenderedQuoteProofFacts,
) => Readonly<{ ok: true }> | Readonly<{ ok: false; reason: RenderedQuoteProofRejection }>;

type GuestCheckoutSnapshotServiceOptions = Readonly<{
  checkoutInputValidated?: boolean;
  verifyRenderedQuote: RenderedQuoteVerifier;
}>;

const snapshotOrderSelection = {
  id: true,
  publicCode: true,
  state: true,
  syncErrorCode: true,
  pancakeShopId: true,
  merchandiseSubtotalVnd: true,
  shippingFeeVnd: true,
  totalVnd: true,
  // I6b — what the reservation boundary reserves. Read back from the persisted lines rather than
  // carried out of the in-memory `snapshots` array, so the recovery path below (which finds an
  // existing active checkout after a `P2002`) reports the same basket as the create path. A hold
  // taken against a basket the order does not actually have would be worse than no hold.
  lines: { select: { variantId: true, quantity: true } },
} satisfies Prisma.OrderMirrorSelect;

const productSelection = {
  name: true,
  pancakeProductId: true,
  isPresent: true,
  isActive: true,
  // I5 — the stored selling policy. Without it `buildStorefrontCartLines()` below judged every
  // product by `STANDARD`'s floor of 0, so this path refused exactly the lines the storefront and
  // the cart had just offered: a `PREORDER` variant at 0 and an `OVERSELL` variant above its
  // allowance were both turned into `OUT_OF_STOCK` here, before I6b's reservation ever got to make
  // the authoritative decision. Same one select the storefront catalog read carries.
  sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
  variants: {
    orderBy: [{ pancakeVariationId: "asc" as const }],
    select: {
      id: true,
      pancakeVariationId: true,
      isPresent: true,
      isActive: true,
      color: true,
      size: true,
      pancakeRetailPrice: true,
      pancakeRetailPriceAfterDiscount: true,
      warehouseStocks: {
        orderBy: [{ pancakeWarehouseId: "asc" as const }],
        select: { quantity: true },
      },
      // ADR 0014 §11 disables OVERSELL/PREORDER for a composite parent, and composition is a
      // variant-level relation. One bounded row per variant answers it at the same granularity
      // I2's admin boundary and I6a's reservation transaction use.
      compositeComponents: { take: 1, select: { componentVariantId: true } },
      compositeParents: {
        select: {
          parentVariant: {
            select: {
              isPresent: true,
              isActive: true,
              product: {
                select: {
                  isPresent: true,
                  isActive: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductMirrorSelect;

type SelectedSnapshotOrder = Prisma.OrderMirrorGetPayload<{
  select: typeof snapshotOrderSelection;
}>;
type SelectedProduct = Prisma.ProductMirrorGetPayload<{ select: typeof productSelection }>;
type TransactionClient = Prisma.TransactionClient;

function parseShopId(shopId: number): number | null {
  return Number.isSafeInteger(shopId) && shopId > 0 && shopId <= MAX_POSTGRES_INTEGER
    ? shopId
    : null;
}

function parsePublicCode(publicCode: unknown): string | null {
  if (typeof publicCode !== "string") return null;
  if (publicCode.length === 0 || publicCode.length > MAX_PUBLIC_CODE_LENGTH) return null;
  if (publicCode.trim() !== publicCode) return null;
  return publicCode;
}

function isValidDate(now: Date): boolean {
  return now instanceof Date && !Number.isNaN(now.getTime());
}

function isActiveCheckoutState(state: string): state is ActiveCheckoutState {
  return (ACTIVE_CHECKOUT_STATES as readonly string[]).includes(state);
}

function isMutableDraft(order: SelectedSnapshotOrder): boolean {
  return order.state === "DRAFT";
}

function toSnapshotResult(order: SelectedSnapshotOrder): CheckoutSnapshotResult | null {
  if (
    !isActiveCheckoutState(order.state) ||
    order.merchandiseSubtotalVnd === null ||
    order.shippingFeeVnd === null ||
    order.totalVnd === null
  ) {
    return null;
  }

  return {
    ok: true,
    order: {
      id: order.id,
      publicCode: order.publicCode,
      state: order.state,
      merchandiseSubtotalVnd: order.merchandiseSubtotalVnd,
      shippingFeeVnd: order.shippingFeeVnd,
      totalVnd: order.totalVnd,
      lines: order.lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
    },
    // This path returns an order that already exists without re-authenticating a quote, so this
    // attempt made no promise about fulfillment state and declares none. See the field's doc.
    verifiedFulfillmentStateByVariantId: new Map(),
  };
}

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number | null {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) return null;
    total += stock.quantity;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

function isSupportedVndAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkedMultiplyVnd(unitPriceVnd: number, quantity: number): number | null {
  if (!isSupportedVndAmount(unitPriceVnd) || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return null;
  }
  const total = unitPriceVnd * quantity;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function checkedAddVnd(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

async function lockLiveAnonymousCart(
  tx: TransactionClient,
  cartId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Cart"
    WHERE "id" = ${cartId}
      AND "userId" IS NULL
      AND "expiresAt" > ${now}
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function lockActiveCheckout(
  tx: TransactionClient,
  cartId: string,
): Promise<SelectedSnapshotOrder | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "OrderMirror"
    WHERE "sourceCartId" = ${cartId}
      AND "state" IN ('DRAFT', 'VALIDATING', 'POS_SUBMITTING', 'CONFIRMED', 'SYNC_UNKNOWN')
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  return tx.orderMirror.findUnique({
    where: { id },
    select: snapshotOrderSelection,
  });
}

export async function requiresFreshGuestCheckoutSnapshot(
  client: PrismaClient,
  cartId: string,
): Promise<boolean> {
  if (typeof cartId !== "string" || cartId.length === 0) {
    return true;
  }

  const activeCheckout = await client.orderMirror.findFirst({
    where: {
      sourceCartId: cartId,
      state: { in: [...ACTIVE_CHECKOUT_STATES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: snapshotOrderSelection,
  });

  return !activeCheckout || isMutableDraft(activeCheckout);
}

function toStorefrontProduct(product: SelectedProduct) {
  const variants = [];
  for (const variant of product.variants) {
    const sellableStock = sumWarehouseStocks(variant.warehouseStocks);
    if (sellableStock === null) return null;
    variants.push({
      id: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      isPresent: variant.isPresent,
      isActive: variant.isActive,
      isCompositeComponentAvailable: variant.compositeParents.some(
        ({ parentVariant }) =>
          parentVariant.isPresent &&
          parentVariant.isActive &&
          parentVariant.product.isPresent &&
          parentVariant.product.isActive,
      ),
      color: variant.color,
      size: variant.size,
      sellableStock,
      retailPrice: variant.pancakeRetailPrice,
      retailPriceAfterDiscount: variant.pancakeRetailPriceAfterDiscount,
    });
  }
  return {
    // Checkout never renders a public product link, so the slug is a placeholder rather than a
    // public fact. The external product identity is real and comes straight from the mirror.
    slug: "checkout-snapshot",
    pancakeProductId: product.pancakeProductId,
    name: product.name,
    isPresent: product.isPresent,
    isActive: product.isActive,
    // The canonical capacity facts, carried so this path judges a line by the same policy the
    // shopper was shown. No PREORDER/OVERSELL special case is made here: the mode is data, and
    // `resolveSellingPolicy()` supplies the approved default when no row exists.
    sellingPolicy: resolveSellingPolicy(product.sellingPolicy),
    isComposite: product.variants.some((variant) => variant.compositeComponents.length > 0),
    variants,
  };
}

export function createGuestCheckoutSnapshotService(
  client: PrismaClient,
  options: GuestCheckoutSnapshotServiceOptions,
) {
  const checkoutInputValidated = options.checkoutInputValidated ?? false;
  const verifyRenderedQuote = options.verifyRenderedQuote;
  if (typeof verifyRenderedQuote !== "function") {
    throw new TypeError("Guest checkout snapshot requires a rendered-quote verifier");
  }

  async function create({
    cartId,
    shopId,
    publicCode,
    checkoutInput,
    now,
  }: {
    cartId: string;
    shopId: number;
    publicCode: string;
    checkoutInput: unknown;
    now: Date;
  }): Promise<CheckoutSnapshotResult> {
    const parsedCheckout = parseGuestCheckoutInput(checkoutInput);
    const safeShopId = parseShopId(shopId);
    const safePublicCode = parsePublicCode(publicCode);
    if (
      !parsedCheckout.ok ||
      safeShopId === null ||
      safePublicCode === null ||
      typeof cartId !== "string" ||
      cartId.length === 0 ||
      !isValidDate(now)
    ) {
      return { ok: false, reason: "INVALID_INPUT" };
    }

    try {
      return await client.$transaction(async (tx): Promise<CheckoutSnapshotResult> => {
        if (!(await lockLiveAnonymousCart(tx, cartId, now))) {
          return { ok: false, reason: "CART_UNAVAILABLE" };
        }

        const activeCheckout = await lockActiveCheckout(tx, cartId);
        let mutableDraft = activeCheckout && isMutableDraft(activeCheckout)
          ? activeCheckout
          : null;
        // An active checkout that has already left DRAFT is frozen: report it as-is.
        if (activeCheckout && !mutableDraft) {
          return toSnapshotResult(activeCheckout) ?? { ok: false, reason: "MONEY_UNSUPPORTED" };
        }
        if (!checkoutInputValidated) {
          return { ok: false, reason: "INVALID_INPUT" };
        }
        if (mutableDraft && mutableDraft.pancakeShopId !== safeShopId) {
          // The configured shop moved out from under an open DRAFT. Refusing the refresh would
          // strand this cart permanently: DRAFT is the one active state stranded-checkout recovery
          // never sweeps, and returning a failure here means `pancake-order-submit` — which owns
          // the `SHOP_SCOPE_UNVERIFIED` rejection — is never reached to clear it. Reject the
          // mismatched DRAFT with that same vocabulary and snapshot a fresh one under the current
          // shop, which is what the pre-mutable supersede path did.
          await tx.orderMirror.update({
            where: { id: mutableDraft.id },
            data: { state: "REJECTED", syncErrorCode: "SHOP_SCOPE_UNVERIFIED" },
          });
          mutableDraft = null;
        }

        const items = await tx.cartItem.findMany({
          where: { cartId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { variantId: true, quantity: true },
        });
        if (items.length === 0) {
          return { ok: false, reason: "CART_EMPTY" };
        }
        if (items.length > ANONYMOUS_CART_MAX_DISTINCT_ITEMS) {
          return { ok: false, reason: "CART_LINE_UNAVAILABLE" };
        }

        // I6b — an order id must not outlive the basket its ledger rows hold.
        //
        // A reservation is keyed by the order (ADR 0014 §3) and only answers a retry for the *same*
        // basket; anything else is `reservation-conflict`, fail-closed on purpose. Rewriting this
        // DRAFT's lines in place would therefore bind a live order id to a basket its own holds
        // contradict, and every retry would be refused — a buyer with a perfectly valid cart stuck
        // on CART_CHANGED for good, with the active-checkout index blocking a second order too.
        //
        // The DRAFT is superseded instead, exactly as the shop-scope mismatch above does: retire
        // it, free its holds, and let the fresh order below mint a new idempotency key.
        //
        // Only when every hold is still RESERVED. `SUBMITTING`, `COMMITTED` or `UNKNOWN` means a
        // write may have reached Pancake, and §8 lets nothing free those on inference — that order
        // stays as it is and §10 reconciliation owns it. Releasing here is a guarded compare-and-set
        // in the same transaction as the retirement, so the two cannot diverge.
        if (mutableDraft) {
          const holds = await tx.variantCapacityReservation.findMany({
            where: { orderId: mutableDraft.id },
            select: { variantId: true, quantity: true, state: true },
          });
          if (holds.length > 0 && !holdsAreLiveFor(holds, items)) {
            // Safe to supersede only when no hold is in a state where a write may have landed.
            // `RELEASED` joins `RESERVED` here: it is terminal *and* it is evidence nothing was
            // sent, so retiring the attempt around it frees nothing and hides nothing.
            if (
              holds.every((hold) => hold.state === "RESERVED" || hold.state === "RELEASED")
            ) {
              await tx.variantCapacityReservation.updateMany({
                where: { orderId: mutableDraft.id, state: "RESERVED" },
                data: { state: "RELEASED", releasedAt: now },
              });
              await tx.orderMirror.update({
                where: { id: mutableDraft.id },
                data: { state: "REJECTED", syncErrorCode: "SUPERSEDED_BY_CART_CHANGE" },
              });
              mutableDraft = null;
            }
            // Otherwise it is left alone deliberately. `reserveOrderCapacity` will still refuse the
            // rewritten DRAFT, which is the correct fail-closed answer while a write may be live.
          }
        }

        const variantIds = items.map(({ variantId }) => variantId);
        const products = await tx.productMirror.findMany({
          where: {
            pancakeShopId: safeShopId,
            variants: { some: { id: { in: variantIds } } },
          },
          orderBy: [{ pancakeProductId: "asc" }],
          select: productSelection,
        });

        const storefrontProducts = [];
        for (const product of products) {
          const storefrontProduct = toStorefrontProduct(product);
          if (!storefrontProduct) {
            return { ok: false, reason: "CART_LINE_UNAVAILABLE" };
          }
          storefrontProducts.push(storefrontProduct);
        }

        const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
          variantIds: storefrontProducts.flatMap((product) =>
            product.variants.map((variant) => variant.id),
          ),
          client: tx as unknown as PromotionCandidateReadClient,
        });
        // The order snapshot prices through the same projection object the cart and the checkout
        // render use, resolved inside this transaction, so the persisted DRAFT quote is current
        // server truth at snapshot time and never a browser-supplied or stale-cached number.
        //
        // What this deliberately does *not* establish: that the buyer is charged the money they
        // were shown. A campaign that starts or ends between render and submission is re-resolved
        // here to the new price, not compared against the rendered one — so this path can persist a
        // DRAFT at a price the buyer never saw. Binding the rendered quote and refusing an unseen
        // price is P9a's rendered-quote proof plus stale comparison; P8 only persists the current
        // authoritative quote and its audit. Do not read this block as that guarantee.
        //
        // The audit needs the campaign behind the price too, so it observes the resolver answer
        // through `onResolved` instead of rebuilding a second projection that could drift.
        const pricingByVariantId = new Map<string, PromotionPricingResult>();
        const lines = buildStorefrontCartLines({
          items,
          products: storefrontProducts,
          pricingRule: buildPromotionalStorefrontPricing({
            campaignsByVariantId,
            now,
            onResolved: (variantId, pricing) => pricingByVariantId.set(variantId, pricing),
          }),
        });
        const snapshots: Array<{
          variantId: string;
          pancakeVariationId: string;
          productName: string;
          color: string | null;
          size: string;
          quantity: number;
          unitPriceVnd: bigint;
          lineTotalVnd: bigint;
          baseUnitPriceVnd: bigint;
          promotionCampaignId: string | null;
          promotionName: string | null;
          promotionKind: PromotionCampaignKind | null;
          promotionDiscountType: "PERCENTAGE" | "FIXED_PRICE" | null;
          promotionPercentageValue: number | null;
          promotionFixedPriceVnd: bigint | null;
        }> = [];
        // Kept as plain numbers beside the BigInt rows: the proof canonicalizes safe integers, and
        // round-tripping money back out of BigInt purely to hash it would be a second conversion
        // with nothing to gain.
        const quoteItems: Array<{
          variantExternalId: string;
          quantity: number;
          unitPriceVnd: number;
          fulfillmentState: "READY" | "PREORDER";
        }> = [];
        const verifiedFulfillmentStateByVariantId = new Map<string, "READY" | "PREORDER">();
        let merchandiseSubtotalVnd = 0;
        let totalQuantity = 0;

        for (const line of lines) {
          // Identity comes from the resolved line, which is the one projection that knows whether a
          // real variation was resolved at all. Re-deriving it here from a side map was a second
          // identity path that could disagree with the line it is describing. `pricingByVariantId`
          // is deliberately not that: it carries money the line already agrees with (asserted
          // below), never identity.
          const pancakeVariationId = line.pancakeVariationId;
          const pricing = pricingByVariantId.get(line.variantId);
          if (
            !line.available ||
            line.price === null ||
            line.productName === null ||
            line.size === null ||
            !pancakeVariationId ||
            !pricing ||
            pricing.basePriceVnd === null ||
            pricing.effectivePriceVnd === null ||
            line.price !== pricing.effectivePriceVnd
          ) {
            return { ok: false, reason: "CART_LINE_UNAVAILABLE" };
          }

          const lineTotalVnd = checkedMultiplyVnd(line.price, line.quantity);
          if (lineTotalVnd === null) {
            return { ok: false, reason: "MONEY_UNSUPPORTED" };
          }
          const nextSubtotal = checkedAddVnd(merchandiseSubtotalVnd, lineTotalVnd);
          const nextQuantity = totalQuantity + line.quantity;
          if (nextSubtotal === null || !Number.isSafeInteger(nextQuantity) || nextQuantity <= 0) {
            return { ok: false, reason: "MONEY_UNSUPPORTED" };
          }

          const promotion = pricing.promotion;
          if (pricing.isDiscounted && promotion === null) {
            return { ok: false, reason: "MONEY_UNSUPPORTED" };
          }

          merchandiseSubtotalVnd = nextSubtotal;
          totalQuantity = nextQuantity;
          snapshots.push({
            variantId: line.variantId,
            pancakeVariationId,
            productName: line.productName,
            color: line.color,
            size: line.size,
            quantity: line.quantity,
            baseUnitPriceVnd: BigInt(pricing.basePriceVnd),
            unitPriceVnd: BigInt(line.price),
            lineTotalVnd: BigInt(lineTotalVnd),
            promotionCampaignId: promotion?.id ?? null,
            promotionName: promotion?.name ?? null,
            promotionKind: promotion?.kind ?? null,
            promotionDiscountType: promotion?.discountType ?? null,
            promotionPercentageValue: promotion?.percentageValue ?? null,
            promotionFixedPriceVnd: promotion?.fixedPriceVnd ?? null,
          });
          quoteItems.push({
            variantExternalId: pancakeVariationId,
            quantity: line.quantity,
            unitPriceVnd: line.price,
            // Re-resolved here from the same canonical, quantity-aware rule the checkout render
            // used — now that this path carries the real selling policy, the two agree whenever
            // capacity has not moved. When it has, the refreshed quote no longer matches the
            // proof and the buyer is asked to re-confirm, instead of the order committing under a
            // fulfillment state they never saw.
            fulfillmentState: line.isPreorderSale ? ("PREORDER" as const) : ("READY" as const),
          });
          // Same fact, keyed by the internal id I6b addresses lines by. The quote item carries the
          // external identity, which the reservation ledger does not use.
          verifiedFulfillmentStateByVariantId.set(
            line.variantId,
            line.isPreorderSale ? "PREORDER" : "READY",
          );
        }

        const shippingFeeVnd = calculateGuestShippingFeeVnd({
          subtotalVnd: merchandiseSubtotalVnd,
          totalQuantity,
        });
        const totalVnd = checkedAddVnd(merchandiseSubtotalVnd, shippingFeeVnd);
        if (totalVnd === null) {
          return { ok: false, reason: "MONEY_UNSUPPORTED" };
        }

        // The acknowledgement gate, deliberately inside this transaction rather than ahead of it.
        // The quote is checked against the proof at the same instant, under the same cart lock, that
        // it is about to be persisted — a check before the transaction could pass and then have the
        // price move underneath it before the DRAFT was written, which is the exact substitution
        // this unit exists to prevent. Nothing has been written for this attempt yet, so returning
        // here leaves no submit-capable DRAFT, no `POS_SUBMITTING` and no Pancake call.
        const refreshedQuote: RenderedQuoteProofFacts = Object.freeze({
          items: Object.freeze(quoteItems.map((item) => Object.freeze({ ...item }))),
          merchandiseSubtotalVnd,
          shippingFeeVnd,
          totalVnd,
          totalQuantity,
        });
        const quoteVerification = verifyRenderedQuote(refreshedQuote);
        if (!quoteVerification.ok) {
          return {
            ok: false,
            reason: "QUOTE_UNPROVEN",
            quoteReason: quoteVerification.reason,
            refreshedQuote,
          };
        }

        const draftFacts = {
          syncErrorCode: null,
          checkoutSnapshottedAt: now,
          guestName: parsedCheckout.value.name,
          guestPhone: parsedCheckout.value.phone,
          provinceRef: parsedCheckout.value.provinceRef,
          districtRef: parsedCheckout.value.districtRef,
          communeRef: parsedCheckout.value.communeRef,
          addressDetail: parsedCheckout.value.detail,
          note: parsedCheckout.value.note,
          merchandiseSubtotalVnd: BigInt(merchandiseSubtotalVnd),
          shippingFeeVnd: BigInt(shippingFeeVnd),
          totalVnd: BigInt(totalVnd),
        };

        const order = mutableDraft
          ? await tx.orderMirror.update({
              where: { id: mutableDraft.id },
              data: {
                ...draftFacts,
                lines: { deleteMany: {}, create: snapshots },
              },
              select: snapshotOrderSelection,
            })
          : await tx.orderMirror.create({
              data: {
                publicCode: safePublicCode,
                userId: null,
                sourceCartId: cartId,
                pancakeShopId: safeShopId,
                state: "DRAFT",
                ...draftFacts,
                lines: { create: snapshots },
              },
              select: snapshotOrderSelection,
            });

        const snapshot = toSnapshotResult(order);
        if (snapshot === null || !snapshot.ok) {
          return snapshot ?? { ok: false, reason: "MONEY_UNSUPPORTED" };
        }
        // This attempt authenticated a quote, so it *can* promise a fulfillment state — unlike the
        // paths that hand back an existing checkout. `toSnapshotResult()` cannot know it: it reads
        // persisted rows, and the state is not persisted.
        return { ...snapshot, verifiedFulfillmentStateByVariantId };
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const activeCheckout = await client.orderMirror.findFirst({
          where: {
            sourceCartId: cartId,
            state: { in: [...ACTIVE_CHECKOUT_STATES] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: snapshotOrderSelection,
        });
        if (!activeCheckout || isMutableDraft(activeCheckout)) {
          return { ok: false, reason: "PUBLIC_CODE_UNAVAILABLE" };
        }
        return toSnapshotResult(activeCheckout) ?? {
          ok: false,
          reason: "PUBLIC_CODE_UNAVAILABLE",
        };
      }
      throw error;
    }
  }

  return { create };
}
