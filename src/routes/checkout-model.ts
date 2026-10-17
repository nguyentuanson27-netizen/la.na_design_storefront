import type { CartGiftPickerModel } from "./cart-gift-model.ts";
import type { BenefitCheckoutRender } from "../commerce/benefit-checkout-render.ts";
import type { RenderedCheckoutQuoteFacts } from "../commerce/checkout-quote.ts";
import {
  buildPreorderFulfillmentNotice,
  PREORDER_LABEL,
  type PreorderFulfillmentNotice,
} from "../commerce/preorder-fulfillment-presentation.ts";
import type { StorefrontCartLine } from "../commerce/storefront-cart.ts";
import type { TrustedProductImage } from "../commerce/product-media.ts";
import { buildCheckoutPromotionView, type PromotionBannerView } from "./cart-promotion-model.ts";
import { describeLineDiscount } from "./line-discount-model.ts";
import { buildOrderSummary, type OrderSummaryView } from "./order-summary-model.ts";

/**
 * Everything the checkout route decides, as one pure function.
 *
 * Separate from `checkout.ts` because that file reaches `next/server`, the cart runtime and the
 * auth secret behind the quote proof. What is left is what the page decided inline: which of the
 * three states it is in, how each ordered line reads, and what the Meta pixel is told the order
 * contains.
 */

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

/**
 * Why the page renders what it renders.
 *
 * - `empty`      — no cart, or a cart with no lines.
 * - `unquotable` — lines exist but could not be priced, or could not be proved. Both are the same
 *                  answer to the shopper (go back and fix the cart), and keeping them one state
 *                  stops the page inventing a difference it cannot explain.
 * - `ready`      — a quote and a proof over exactly the facts rendered below.
 */
export type CheckoutState = "empty" | "unquotable" | "ready";

export type CheckoutLineView = Readonly<{
  /** React key. A benefit quote can list one variation twice (two paid price segments), so `variantId` is not unique. */
  lineKey: string;
  variantId: string;
  productName: string;
  primaryImage: TrustedProductImage | null;
  /** `Màu / Kích cỡ`, or the fallback when the line resolved to no option pair. */
  optionLabel: string;
  quantity: number;
  /** Benefit quotes only: the price of one unit of this segment, so split prices read as `2 × 400.000 ₫`. */
  unitPriceText: string | null;
  /** A per-product promotion on this line: the catalog price to strike through. Absent when there is none. */
  originalPriceText?: string;
  /** Whole percent off for that promotion; absent when there is none or it rounds under 1%. */
  discountPercent?: number;
  /**
   * Set only when a quantity / order-value price lowered this line BELOW the price its per-product promotion
   * left: that promotion price, the one `originalPriceText` and `discountPercent` are measured against.
   * `unitPriceText` is then the further price after those offers, shown apart from the sale.
   */
  promotionPriceText?: string;
  lineTotalText: string;
  /**
   * F8b / §30 — the same `Đặt trước` marker the cart showed for this line, or `null`.
   *
   * Recomputed from the same canonical line fact rather than carried over from the cart render, so
   * a line cannot arrive here looking like ready stock because the cart page was stale.
   */
  preorderLabel: string | null;
}>;

export type CheckoutTotalsView = Readonly<{
  subtotalText: string;
  /** "Miễn phí" where shipping costs nothing, so the page never re-decides that. */
  shippingText: string;
  totalText: string;
  /**
   * The same total as a number, so a price-change notice can name the total the buyer submitted against
   * beside the server's new one. Display only: the server never reads it back.
   */
  totalVnd: number;
}>;

/** A gift on the order: priced 0đ for the buyer, never part of what they pay. */
export type CheckoutGiftLineView = Readonly<{
  lineKey: string;
  label: string;
  quantity: number;
  priceText: string;
  /** The gift product's own photo (a trusted catalog URL), or `null` to show the placeholder. */
  imageUrl?: string | null;
}>;

/**
 * GQ19 -- what a gift or quantity-tier checkout shows beyond the plain order lines.
 *
 * Present exactly when the page renders a benefit quote. `digest` identifies that exact quote: the
 * proof and explicit submit intent are bound to it; UI reminder state never supplies consent
 * for a refreshed quote (FR-06).
 */
export type CheckoutBenefitView = Readonly<{
  digest: string;
  giftLines: readonly CheckoutGiftLineView[];
  giftQuantity: number;
  /** Slots earned, taken and left. All zero for a tier-only quote. */
  slots: Readonly<{ entitled: number; selected: number; unclaimed: number; skippedWhileAvailable: number; shortForStock: number }>;
  needsAcknowledgement: boolean;
  /** Plain-language account of the slots the order will not include; `null` when nothing is left unclaimed. */
  unclaimedText: string | null;
  acknowledgementLabel: string | null;
  /** EX-21: shown when a quantity tier no longer applies and the price was recomputed. */
  tierNotice: string | null;
}>;

/**
 * AM-01 (OD-01 = A): all the checkout banner shows. The server's full upsell model (variants, signed
 * intents, gift state) stays on the server; the browser gets the paid-cart key for the D-06 skip and
 * the programme name, nothing it could replay.
 */
export type CheckoutUpsellBanner = Readonly<{ paidCartKey: string; offerName: string | null }>;

export type CheckoutViewModel = Readonly<{
  state: CheckoutState;
  giftPicker?: CartGiftPickerModel;
  attemptKey?: string;
  /** UI refresh identity, never a form key or quote authority. */
  quoteRenderId?: string;
  upsell?: CheckoutUpsellBanner;
  /** Physical items remain visible during gift repair; prices are withheld without a valid quote. */
  lines: readonly CheckoutLineView[];
  totals: CheckoutTotalsView | null;
  /** The token the form submits with. Present exactly when `state` is `ready`. */
  quoteProof: string | null;
  /**
   * F8b / §30 — the preparation and shipment truth, from the same projection the cart uses.
   *
   * `null` in the `empty` and `unquotable` states: there is no order to describe, and describing
   * one would be a claim about a basket that is not going to be submitted as it stands.
   */
  preorderNotice: PreorderFulfillmentNotice | null;
  /** `null` for an ordinary checkout: the gift / quantity-tier section is simply not rendered. */
  benefit: CheckoutBenefitView | null;
  /** The reached-promotions banner; present only for a benefit checkout that has something to say. */
  promotions?: PromotionBannerView;
  /** The bill in reading order (value, discounts, shipping, total). Absent if it could not be made to add up. */
  summary?: OrderSummaryView;
  /** Why the cart cannot be offered for checkout, when that is more specific than "check your cart". */
  unavailableNotice: string | null;
}>;

/**
 * What the pixel is told this checkout contains.
 *
 * Every line must have a proven public PDP identity. An unresolved identity suppresses the whole Meta event,
 * because dropping an item while totals still count it would contradict the reported value.
 */
export function checkoutPixelContentIds(lines: readonly StorefrontCartLine[]): readonly string[] | null {
  // Preserve the existing slug scheme. Never substitute an internal ID or guess a catalog ID.
  if (lines.some((line) => !(line.metaContentId ?? line.productSlug))) return null;
  return lines.map((line) => (line.metaContentId ?? line.productSlug)!);
}

function checkoutDiscountEntry(discount: ReturnType<typeof describeLineDiscount>): { originalPriceText?: string; discountPercent?: number } {
  if (!discount) return {};
  return { originalPriceText: discount.originalPriceText, ...(discount.percent === null ? {} : { discountPercent: discount.percent }) };
}

/** The per-product (legacy) step on a quote line: catalog price in, price after the promotion out. */
function legacyStepDiscount(steps: readonly Readonly<{ source: string; inputPriceVnd: number; outputPriceVnd: number }>[]) {
  const step = steps.find((candidate) => candidate.source === "LEGACY");
  return step ? describeLineDiscount(step.inputPriceVnd, step.outputPriceVnd) : null;
}

/**
 * The per-product promotion of a benefit-checkout line, on one basis: the catalog price struck through, the
 * price its Flash Sale / clearance leaves, and the percentage between exactly those two. Both come from the
 * cart line (a per-product promotion priced alone), never from the quote's legacy step, whose input is the
 * price after any tier ordered before it. A quantity or order-value price below that is named separately
 * (`promotionPriceText`), so no label ever sits beside a price it was not computed for.
 */
function paidLineDiscount(
  cartLine: StorefrontCartLine | undefined,
  fact: Readonly<{ unitPriceVnd: number; discountSteps: readonly Readonly<{ source: string; inputPriceVnd: number; outputPriceVnd: number }>[] }>,
): { originalPriceText?: string; discountPercent?: number; promotionPriceText?: string } {
  const tierApplied = fact.discountSteps.some((step) => step.source === "QUANTITY_TIER");
  // Without the cart line's own catalog price the quote's legacy step is the only evidence, and it is a
  // sound one only when no tier ran before it (a tier's output is then not the catalog price).
  if (cartLine?.basePrice === undefined || cartLine.basePrice === null) return tierApplied ? {} : checkoutDiscountEntry(legacyStepDiscount(fact.discountSteps));
  const discount = describeLineDiscount(cartLine.basePrice, cartLine.price);
  if (!discount) return {};
  return {
    ...checkoutDiscountEntry(discount),
    ...(cartLine.price !== null && fact.unitPriceVnd < cartLine.price ? { promotionPriceText: currency.format(cartLine.price) } : {}),
  };
}

export function buildCheckoutViewModel(
  input: Readonly<{
    lines: readonly StorefrontCartLine[];
    totals: RenderedCheckoutQuoteFacts | null;
    quoteProof: string | null;
  }>,
): CheckoutViewModel {
  if (input.lines.length === 0) {
    return Object.freeze({
      state: "empty",
      lines: Object.freeze([]),
      totals: null,
      quoteProof: null,
      preorderNotice: null,
      benefit: null,
      unavailableNotice: null,
    });
  }

  // A quote without a proof is unusable: submission would reject it and the shopper would loop
  // through a reconfirm no retry escapes. Both halves are required before checkout is offered.
  if (!input.totals || !input.quoteProof) {
    return Object.freeze({
      state: "unquotable",
      lines: Object.freeze([]),
      totals: null,
      quoteProof: null,
      preorderNotice: null,
      benefit: null,
      unavailableNotice: null,
    });
  }

  const totals = input.totals;
  const summary = buildOrderSummary({
    goodsAfterDiscountsVnd: totals.merchandiseSubtotalVnd,
    discounts: [],
    shippingFeeVnd: totals.shippingFeeVnd,
    expectedTotalVnd: totals.totalVnd,
  });

  return Object.freeze({
    state: "ready",
    lines: Object.freeze(
      input.lines.map((line) =>
        Object.freeze({
          variantId: line.variantId,
          productName: line.productName ?? "Sản phẩm không còn trong catalog",
          primaryImage: line.media.primary,
          optionLabel: [line.color, line.size].filter(Boolean).join(" / ") || "Biến thể",
          lineKey: line.variantId,
          // The charged unit price: a struck-through catalog price is only honest beside the price paid, and
          // the line total on the right cannot stand in for it when more than one is bought.
          unitPriceText: line.price === null ? null : currency.format(line.price),
          ...checkoutDiscountEntry(describeLineDiscount(line.basePrice, line.price)),
          quantity: line.quantity,
          // `ready` means every line priced, so the fallback is unreachable rather than lenient.
          lineTotalText: currency.format((line.price ?? 0) * line.quantity),
          preorderLabel: line.available && line.isPreorderSale ? PREORDER_LABEL : null,
        }),
      ),
    ),
    totals: Object.freeze({
      subtotalText: currency.format(totals.merchandiseSubtotalVnd),
      shippingText:
        totals.shippingFeeVnd === 0 ? "Miễn phí" : currency.format(totals.shippingFeeVnd),
      totalText: currency.format(totals.totalVnd),
      totalVnd: totals.totalVnd,
    }),
    quoteProof: input.quoteProof,
    preorderNotice: buildPreorderFulfillmentNotice(input.lines),
    benefit: null,
    ...(summary ? { summary } : {}),
    unavailableNotice: null,
  });
}

const UNAVAILABLE_NOTICES: Record<Extract<BenefitCheckoutRender, { kind: "UNAVAILABLE" }>["reason"], string> = {
  BENEFITS_UNAVAILABLE: "Chưa kiểm tra được ưu đãi và quà tặng của giỏ hàng. Nàng quay lại giỏ hàng rồi thử lại nhé.",
  GIFT_SELECTION_INVALID: "Quà nàng chọn không còn phù hợp (hết hàng hoặc chương trình đã đổi). Nàng bỏ lựa chọn cũ ngay tại đây rồi chọn lại nhé; hệ thống không tự đổi quà thay nàng.",
  POS_NOT_ACCEPTED: "Đơn có quà tặng hoặc ưu đãi theo số lượng hiện chưa đặt trực tuyến được. Nàng có thể bỏ sản phẩm áp dụng ưu đãi khỏi giỏ hoặc quay lại sau nhé.",
  PROOF_UNAVAILABLE: "Giỏ hàng có nhiều dòng ưu đãi quá nên chưa xác nhận được giá. Nàng bớt vài sản phẩm rồi thử lại nhé.",
};

/** Keep physical items and gift repair available without issuing prices or checkout authority. */
export function buildBenefitUnavailableCheckoutViewModel(
  render: Extract<BenefitCheckoutRender, { kind: "UNAVAILABLE" }>,
  lines: readonly StorefrontCartLine[] = [],
): CheckoutViewModel {
  return Object.freeze({
    state: "unquotable",
    // Keep physical paid items visible without claiming an unproven price/discount allocation.
    lines: Object.freeze(lines.map((line) => ({
      lineKey: line.variantId, variantId: line.variantId,
      productName: line.productName ?? "Sản phẩm không còn trong catalog",
      primaryImage: line.media.primary,
      optionLabel: [line.color, line.size].filter(Boolean).join(" / ") || "Biến thể",
      quantity: line.quantity, unitPriceText: null, lineTotalText: "Chờ tính lại",
      preorderLabel: line.available && line.isPreorderSale ? PREORDER_LABEL : null,
    }))),
    totals: null,
    quoteProof: null,
    preorderNotice: null,
    benefit: null,
    giftPicker: render.giftPicker,
    unavailableNotice: UNAVAILABLE_NOTICES[render.reason],
  });
}

function slotText(slots: CheckoutBenefitView["slots"]): string | null {
  if (slots.unclaimed === 0) return null;
  const parts = [`Nàng được hưởng ${slots.entitled} suất quà, đã chọn ${slots.selected}, chưa nhận ${slots.unclaimed}.`];
  if (slots.skippedWhileAvailable > 0) parts.push(`${slots.skippedWhileAvailable} suất còn có thể chọn.`);
  if (slots.shortForStock > 0) parts.push(`${slots.shortForStock} suất hiện chưa có lựa chọn phù hợp.`);
  return parts.join(" ");
}

/**
 * The checkout of a cart with gifts or quantity-tier segments.
 *
 * Every paid segment is its own line (a variation bought at two prices appears twice, each with its
 * own unit price), gifts are listed at 0đ and kept out of the subtotal, and the totals are the
 * quote's own: nothing here re-adds or re-prices. The proof and digest come from the render that
 * signed exactly these facts.
 */
export function buildBenefitCheckoutViewModel(
  input: Readonly<{ lines: readonly StorefrontCartLine[]; render: Extract<BenefitCheckoutRender, { kind: "BENEFIT" }> }>,
): CheckoutViewModel {
  const { render } = input;
  const facts = render.facts;
  const lineByVariation = new Map(input.lines.flatMap((line) => (line.pancakeVariationId === null ? [] : [[line.pancakeVariationId, line] as const])));

  const paidLines: CheckoutLineView[] = [];
  const giftLines: CheckoutGiftLineView[] = [];
  for (const fact of facts.lines) {
    if (fact.role === "GIFT") {
      giftLines.push(
        Object.freeze({
          lineKey: fact.lineId,
          label: render.giftLabels.get(fact.pancakeVariationId) ?? "Quà tặng",
          imageUrl: render.giftImages?.get(fact.pancakeVariationId) ?? null,
          quantity: fact.quantity,
          priceText: currency.format(0),
        }),
      );
      continue;
    }
    const cartLine = lineByVariation.get(fact.pancakeVariationId);
    paidLines.push(
      Object.freeze({
        lineKey: fact.lineId,
        variantId: cartLine?.variantId ?? fact.lineId,
        productName: cartLine?.productName ?? "Sản phẩm không còn trong catalog",
        primaryImage: cartLine?.media.primary ?? null,
        optionLabel: cartLine ? [cartLine.color, cartLine.size].filter(Boolean).join(" / ") || "Biến thể" : "Biến thể",
        quantity: fact.quantity,
        unitPriceText: currency.format(fact.unitPriceVnd),
        ...paidLineDiscount(cartLine, fact),
        lineTotalText: currency.format(fact.lineTotalVnd),
        preorderLabel: fact.fulfillmentState === "PREORDER" ? PREORDER_LABEL : null,
      }),
    );
  }

  const slots = facts.entitlements.reduce(
    (sum, entry) => ({
      entitled: sum.entitled + entry.entitled,
      selected: sum.selected + entry.selected,
      unclaimed: sum.unclaimed + (entry.entitled - entry.selected),
      skippedWhileAvailable: sum.skippedWhileAvailable + entry.skippedWhileAvailable,
      shortForStock: sum.shortForStock + entry.shortForStock,
    }),
    { entitled: 0, selected: 0, unclaimed: 0, skippedWhileAvailable: 0, shortForStock: 0 },
  );

  const giftQuantity = giftLines.reduce((sum, line) => sum + line.quantity, 0);
  // Savings are measured against the price each line is listed at (per-product promotions only), which
  // is also what "Tổng giá trị đơn hàng" must come to; a paid line with no listed price proves nothing.
  const listedUnitPrices = new Map(
    input.lines.flatMap((line) => (line.pancakeVariationId === null || !line.available || line.price === null ? [] : [[line.pancakeVariationId, line.price] as const])),
  );
  const paidFacts = facts.lines.filter((fact) => fact.role === "PAID");
  const listedValueVnd = paidFacts.every((fact) => listedUnitPrices.has(fact.pancakeVariationId))
    ? paidFacts.reduce((sum, fact) => sum + listedUnitPrices.get(fact.pancakeVariationId)! * fact.quantity, 0)
    : null;
  const promotions = buildCheckoutPromotionView(facts, giftQuantity, render.campaignNames, listedUnitPrices);
  const summary = listedValueVnd === null
    ? null
    : buildOrderSummary({
        goodsAfterDiscountsVnd: facts.paidSubtotalVnd,
        discounts: promotions?.savings ?? [],
        shippingFeeVnd: facts.shippingFeeVnd,
        giftQuantity,
        expectedTotalVnd: facts.totalVnd,
        expectedValueVnd: listedValueVnd,
      });

  return Object.freeze({
    state: "ready",
    lines: Object.freeze(paidLines),
    totals: Object.freeze({
      subtotalText: currency.format(facts.paidSubtotalVnd),
      shippingText: facts.shippingFeeVnd === 0 ? "Miễn phí" : currency.format(facts.shippingFeeVnd),
      totalText: currency.format(facts.totalVnd),
      totalVnd: facts.totalVnd,
    }),
    giftPicker: render.giftPicker,
    quoteProof: render.proof,
    preorderNotice: buildPreorderFulfillmentNotice(input.lines),
    benefit: Object.freeze({
      digest: render.digest,
      giftLines: Object.freeze(giftLines),
      giftQuantity,
      slots: Object.freeze(slots),
      needsAcknowledgement: render.needsAcknowledgement,
      unclaimedText: slotText(slots),
      acknowledgementLabel: render.needsAcknowledgement
        ? `Tôi xác nhận không nhận ${slots.unclaimed} suất quà còn lại và muốn đặt hàng như trên.`
        : null,
      tierNotice: render.tierDropped
        ? "Ưu đãi giảm theo số lượng không còn áp dụng vì mức giảm không còn hợp lệ với giá hiện tại. Giá bên dưới đã được tính lại; hãy kiểm tra trước khi đặt hàng."
        : null,
    }),
    ...(promotions ? { promotions } : {}),
    ...(summary ? { summary } : {}),
    unavailableNotice: null,
  });
}
