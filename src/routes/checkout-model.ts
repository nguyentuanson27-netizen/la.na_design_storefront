import { describeListPriceSavings } from "./list-price-savings.ts";
import { readListPriceConfig } from "../commerce/list-price-config.ts";
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
import type { VoucherPickerModel } from "./voucher-picker-model.ts";

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
  isListReference?: boolean;
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

/** V18: one voucher line on the checkout: what it is called and what it takes off. */
export type CheckoutVoucherLine = Readonly<{ id: string; title: string; amountText: string }>;

/**
 * V18: what the checkout says about vouchers. Exactly one of three situations, or `null` for "nothing to say":
 *  - `HELD`    the cart holds vouchers that the quote below already includes; `heldUntilMs` is the earliest expiry.
 *  - `OFFERED` the shopper's selection would save money but nothing is held yet. The form cannot be submitted until the
 *              shopper confirms it (a deliberate POST) or drops the vouchers in the cart: a checkout must never place an
 *              order without a voucher the shopper was just shown.
 *  - `STALE`   the cart held vouchers that no longer describe it and none is on offer; the shopper is told, not charged for them.
 */
export type CheckoutVoucherView = Readonly<
  | { state: "HELD"; lines: readonly CheckoutVoucherLine[]; heldUntilMs: number | null }
  | {
      state: "OFFERED";
      /** The quote the shopper saw; the hold POST sends it back and the server recomputes it. */
      digest: string;
      lines: readonly CheckoutVoucherLine[];
      /** Total after the vouchers, shipping included, as the hold will make it. */
      totalText: string;
      /** The consent the hold needs, in words: a gift that would be lost, a total that would go up. Null when there is nothing to accept. */
      giftLossText: string | null;
      totalIncreaseText: string | null;
      /** The previous holds expired or stopped describing the cart. */
      afterStale: boolean;
    }
  | { state: "STALE" }
>;

export type CheckoutViewModel = Readonly<{
  state: CheckoutState;
  listPriceSavingsText?: string;
  /** V18: absent unless the voucher feature has something to say about this cart. */
  vouchers?: CheckoutVoucherView;
  giftPicker?: CartGiftPickerModel;
  attemptKey?: string;
  /** UI refresh identity, never a form key or quote authority. */
  quoteRenderId?: string;
  upsell?: CheckoutUpsellBanner;
  /** Whether bank transfer is offered beside COD. The loader reads it from the server environment. */
  bankTransferEnabled?: boolean;
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

/**
 * InitiateCheckout for a gift / quantity-tier checkout that is ready to submit.
 *
 * Only facts the page itself shows: the products (by the same public identity as the ordinary
 * checkout), the paid units and the total the buyer is asked to pay, shipping included. There is no
 * `contents`: a split-price line has no single unit price to report truthfully, so the event says what
 * the order is worth without inventing a per-item price. Gifts are not counted: they are not bought.
 */
export function benefitCheckoutPixelParameters(
  data: CheckoutViewModel,
  lines: readonly StorefrontCartLine[],
): Readonly<{ content_ids: readonly string[]; content_type: "product"; currency: "VND"; value: number; num_items: number }> | null {
  if (data.state !== "ready" || data.benefit === null || data.totals === null || data.lines.length === 0) return null;
  const contentIds = checkoutPixelContentIds(lines);
  if (contentIds === null || contentIds.length === 0) return null;
  return Object.freeze({
    content_ids: contentIds,
    content_type: "product",
    currency: "VND",
    value: data.totals.totalVnd,
    num_items: data.lines.reduce((sum, line) => sum + line.quantity, 0),
  });
}

function checkoutDiscountEntry(discount: ReturnType<typeof describeLineDiscount>): { originalPriceText?: string; isListReference?: boolean; discountPercent?: number } {
  if (!discount) return {};
  return { ...(discount.isListReference ? { isListReference: true } : {}), originalPriceText: discount.originalPriceText, ...(discount.percent === null ? {} : { discountPercent: discount.percent }) };
}

/** The per-product (legacy) step on a quote line: catalog price in, price after the promotion out. */
function legacyStepDiscount(steps: readonly Readonly<{ source: string; inputPriceVnd: number; outputPriceVnd: number }>[]) {
  const step = steps.find((candidate) => candidate.source === "LEGACY");
  return step ? describeLineDiscount(step.inputPriceVnd, step.outputPriceVnd, false) : null;
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
  fact: Pick<QuoteLine, "unitPriceVnd" | "discountSteps">,
): { originalPriceText?: string; isListReference?: boolean; discountPercent?: number; promotionPriceText?: string } {
  if (readListPriceConfig().display && cartLine?.price != null) {
    const discount = describeLineDiscount(cartLine.basePrice ?? cartLine.price, fact.unitPriceVnd, true, cartLine.variantId);
    if (discount?.isListReference) return checkoutDiscountEntry(discount);
  }
  // The legacy campaign presentation excludes vouchers from its separate promotion label.
  // A valid list reference instead uses the final unit price displayed on this same line.
  fact = stripVoucherStep(fact);
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

type QuoteLine = BenefitCheckoutFacts["lines"][number];
type BenefitCheckoutFacts = Extract<BenefitCheckoutRender, { kind: "BENEFIT" }>["facts"];

/** The line as it stood before the voucher: price and ledger without the final VOUCHER step. */
function stripVoucherStep<L extends Pick<QuoteLine, "unitPriceVnd" | "discountSteps">>(line: L): L {
  const last = line.discountSteps.at(-1);
  if (last === undefined || last.source !== "VOUCHER") return line;
  return { ...line, unitPriceVnd: last.inputPriceVnd, discountSteps: line.discountSteps.slice(0, -1) };
}

function stripVoucherSteps(facts: BenefitCheckoutFacts): BenefitCheckoutFacts {
  return { ...facts, lines: facts.lines.map(stripVoucherStep) };
}

/** What the merchandise voucher took off the paid lines, whole VND. */
function voucherSavingVnd(facts: BenefitCheckoutFacts): number {
  return facts.lines.reduce((sum, line) => {
    const last = line.discountSteps.at(-1);
    return last !== undefined && last.source === "VOUCHER" ? sum + (last.inputPriceVnd - last.outputPriceVnd) * line.quantity : sum;
  }, 0);
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

  const listPriceSavingsText = describeListPriceSavings(input.lines, totals.merchandiseSubtotalVnd);
  return Object.freeze({
    ...(listPriceSavingsText ? { listPriceSavingsText } : {}),
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
          ...checkoutDiscountEntry(describeLineDiscount(line.basePrice, line.price, undefined, line.variantId)),
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
  GIFT_SELECTION_INVALID: "Quà nàng chọn không còn phù hợp (quà hết hàng hoặc chương trình tặng quà đã đổi). Nàng bỏ quà cũ ngay tại đây rồi chọn lại nhé; hệ thống không tự đổi quà thay nàng.",
  POS_NOT_ACCEPTED: "Đơn có quà tặng hoặc ưu đãi theo số lượng hiện chưa thể đặt trực tuyến. Nàng có thể bỏ sản phẩm áp dụng ưu đãi khỏi giỏ hoặc quay lại sau nhé.",
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
  // A merchandise voucher is the last step of each line it touched. The tier and promotion rows are measured on the
  // price BEFORE it, or the voucher's saving would be booked under the tier's name.
  const withoutVoucher = stripVoucherSteps(facts);
  const promotions = buildCheckoutPromotionView(withoutVoucher, giftQuantity, render.campaignNames, listedUnitPrices);
  const voucherSaving = voucherSavingVnd(facts);
  const voucherRows = render.voucher
    ? render.voucher.merchandise.map((entry) =>
        Object.freeze({
          id: `voucher:${entry.campaignId}`,
          label: render.voucher!.names.get(entry.campaignId) ?? "Voucher giảm giá",
          amountVnd: entry.amountVnd,
          amountText: currency.format(entry.amountVnd),
        }),
      )
    : [];
  // Every voucher the buyer holds must be a row, and the rows must add up to what the order's lines say the vouchers took.
  const voucherConsistent = voucherSaving === voucherRows.reduce((sum, row) => sum + row.amountVnd, 0) && voucherSaving === (render.voucher?.merchandiseDiscountVnd ?? 0);
  const shippingVoucher = render.voucher && render.voucher.shippingWaivedVnd > 0 && render.voucher.shippingCampaignId !== null
    ? { label: render.voucher.names.get(render.voucher.shippingCampaignId) ?? "Voucher vận chuyển", waivedVnd: render.voucher.shippingWaivedVnd }
    : undefined;
  const summary = listedValueVnd === null || !voucherConsistent
    ? null
    : buildOrderSummary({
        goodsAfterDiscountsVnd: facts.paidSubtotalVnd,
        discounts: [...(promotions?.savings ?? []), ...voucherRows],
        shippingFeeVnd: facts.shippingFeeVnd,
        giftQuantity,
        expectedTotalVnd: facts.totalVnd,
        expectedValueVnd: listedValueVnd,
        ...(shippingVoucher ? { shippingVoucher } : {}),
      });

  const listPriceSavingsText = describeListPriceSavings(input.lines, facts.paidSubtotalVnd);
  return Object.freeze({
    ...(listPriceSavingsText ? { listPriceSavingsText } : {}),
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

/**
 * V18: the vouchers' part of the checkout page. Pure.
 *
 * Held vouchers are read from the SAME render the quote, the totals and the proof came from, so what is listed here is
 * exactly what the order below includes. An offer is only ever the shopper's own selection previewed by the server; it
 * becomes a hold by an explicit POST, never by rendering this page.
 */
export function buildCheckoutVoucherView(input: Readonly<{
  /** Only what the vouchers need of the render: its kind, the held vouchers it quoted and whether stale holds were set aside. */
  render: Readonly<{ kind: string; voucher?: Extract<BenefitCheckoutRender, { kind: "BENEFIT" }>["voucher"]; voucherStale?: true }>;
  picker: VoucherPickerModel | null;
  /** Earliest expiry of the cart's live holds (database clock), or null when it could not be read. */
  heldUntilMs: number | null;
  /** False when a NEW hold could not be granted here (gates, shop not verified): an offer would block an order nobody can unblock. */
  offerAllowed?: boolean;
}>): CheckoutVoucherView | null {
  const { render } = input;
  const picker = input.offerAllowed === false ? null : input.picker;
  if (render.kind === "BENEFIT" && render.voucher) {
    const v = render.voucher;
    const lines: CheckoutVoucherLine[] = [];
    for (const entry of v.merchandise) lines.push({ id: entry.campaignId, title: v.names.get(entry.campaignId) ?? "Voucher giảm giá", amountText: `−${currency.format(entry.amountVnd)}` });
    if (v.shippingCampaignId !== null) lines.push({ id: v.shippingCampaignId, title: v.names.get(v.shippingCampaignId) ?? "Voucher vận chuyển", amountText: `−${currency.format(v.shippingWaivedVnd)}` });
    return Object.freeze({ state: "HELD", lines: Object.freeze(lines), heldUntilMs: input.heldUntilMs });
  }
  const stale = (render.kind === "LEGACY" || render.kind === "BENEFIT") && render.voucherStale === true;
  if (picker !== null && picker.quoteDigest !== null && picker.footer.count > 0) {
    const lines = picker.groups.flatMap((group) => group.items.filter((item) => item.selected).map((item) => ({ id: item.id, title: item.title, amountText: item.savingText ?? "" })));
    return Object.freeze({
      state: "OFFERED",
      digest: picker.quoteDigest,
      lines: Object.freeze(lines),
      totalText: picker.summary.totalText,
      giftLossText: picker.warnings.giftLoss,
      totalIncreaseText: picker.warnings.totalIncrease,
      afterStale: stale,
    });
  }
  return stale ? Object.freeze({ state: "STALE" }) : null;
}
