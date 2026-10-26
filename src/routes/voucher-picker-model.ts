import type { VoucherCard } from "../commerce/voucher-candidate-repository.ts";
import type { VoucherSelectionIntent } from "../commerce/voucher-optimizer.ts";
import type { VoucherCardReason, VoucherCardState, VoucherQuote } from "../commerce/voucher-quote.ts";

/**
 * Voucher v1 (V15): the picker as plain data (spec §7). No pricing happens here and nothing is decided in React:
 * the model only words and orders what the server-derived `VoucherQuote` already says, so PDP, cart and checkout
 * show the same two groups, the same reasons and the same totals.
 *
 * Shopper-safe by construction: it receives `VoucherCard`s (no ledger, no budget, no private code) and a quote
 * whose `held` is always false, and every amount is a preview ("Dự kiến"), never a claim that anything is held.
 */

export type VoucherPickerItem = Readonly<{
  id: string;
  title: string;
  /** Threshold / cap line, e.g. "Đơn từ 600.000đ · Tối đa 100.000đ". */
  condition: string;
  selected: boolean;
  /** An unavailable card is shown dimmed but never silently hidden, with its reason in text. */
  selectable: boolean;
  disabledReason: string | null;
  shortfallVnd: number | null;
  savingText: string | null;
  /** Present only for public code vouchers. */
  publicCode: string | null;
  endsAtIso: string | null;
}>;

export type VoucherPickerGroup = Readonly<{
  kind: "MERCHANDISE" | "SHIPPING_FREE";
  heading: string;
  hint: string;
  noneLabel: string;
  noneSelected: boolean;
  /** MANUAL when the shopper locked this group (including an explicit "no voucher"); AUTO when the server chose. */
  mode: "AUTO" | "MANUAL";
  items: readonly VoucherPickerItem[];
}>;

export type VoucherPickerModel = Readonly<{
  /** Always a preview: nothing is held and no countdown exists. */
  previewNotHeld: true;
  groups: readonly [VoucherPickerGroup, VoucherPickerGroup];
  summary: Readonly<{
    paidBeforeText: string;
    merchandiseDiscountText: string | null;
    shippingFeeText: string;
    shippingDiscountText: string | null;
    totalText: string;
    totalVnd: number;
  }>;
  footer: Readonly<{ label: string; count: number }>;
  /** Digest of the exact quote shown. The hold POST sends it back; a different quote is never held on an equal total. */
  quoteDigest: string | null;
  warnings: Readonly<{
    giftLoss: string | null;
    totalIncrease: string | null;
    notices: readonly string[];
  }>;
}>;

const money = new Intl.NumberFormat("vi-VN");
export const formatVoucherVnd = (value: number): string => `${money.format(value)}đ`;

const REASON_TEXT: Readonly<Record<VoucherCardReason, string>> = {
  BELOW_MINIMUM: "Chưa đủ điều kiện",
  NOT_APPLICABLE: "Không áp dụng cho sản phẩm trong giỏ",
  EXHAUSTED: "Hết lượt",
  FEE_ALREADY_ZERO: "Phí vận chuyển đã được miễn",
  POS_INFEASIBLE: "Không thể kết hợp với lựa chọn hiện tại",
  NOT_SELECTABLE: "Không thể kết hợp với lựa chọn hiện tại",
};

function titleOf(card: VoucherCard): string {
  if (card.kind === "SHIPPING_FREE") return "Miễn phí vận chuyển";
  const discount = card.discount;
  if (discount === null) return card.name;
  return discount.type === "FIXED_AMOUNT_VND" ? `Giảm ${formatVoucherVnd(discount.amountVnd)}` : `Giảm ${discount.percent}%`;
}

function conditionOf(card: VoucherCard): string {
  const parts: string[] = [];
  if (card.minEligibleSubtotalVnd !== null) parts.push(`Đơn từ ${formatVoucherVnd(card.minEligibleSubtotalVnd)}`);
  if (card.discount?.type === "PERCENTAGE" && card.discount.maxDiscountVnd !== null) parts.push(`Tối đa ${formatVoucherVnd(card.discount.maxDiscountVnd)}`);
  return parts.length === 0 ? card.name : parts.join(" · ");
}

function itemOf(card: VoucherCard, state: VoucherCardState): VoucherPickerItem {
  const unavailable = state.state === "UNAVAILABLE";
  const reasonText = state.reason === null ? null : REASON_TEXT[state.reason];
  const disabledReason = !unavailable
    ? null
    : state.reason === "BELOW_MINIMUM" && state.shortfallVnd !== null
      ? `Đặt thêm ${formatVoucherVnd(state.shortfallVnd)} để được hưởng ưu đãi này`
      : reasonText;
  return Object.freeze({
    id: card.id,
    title: titleOf(card),
    condition: conditionOf(card),
    selected: state.state === "SELECTED",
    selectable: !unavailable,
    disabledReason,
    shortfallVnd: unavailable ? state.shortfallVnd : null,
    savingText: state.savingVnd === null ? null : `Dự kiến giảm ${formatVoucherVnd(state.savingVnd)}`,
    publicCode: card.publicCode,
    endsAtIso: card.endsAt === null ? null : card.endsAt.toISOString(),
  });
}

/** Usable first (biggest saving first), then the nearest-to-qualifying; the id breaks every tie. */
function order(items: readonly { item: VoucherPickerItem; saving: number; shortfall: number }[]): VoucherPickerItem[] {
  return [...items]
    .sort((a, b) => Number(!a.item.selectable) - Number(!b.item.selectable) || (a.item.selectable ? b.saving - a.saving : a.shortfall - b.shortfall) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .map((entry) => entry.item);
}

export function buildVoucherPickerModel(input: Readonly<{
  quote: Extract<VoucherQuote, { ok: true }>;
  entries: readonly Readonly<{ card: VoucherCard; state: VoucherCardState }>[];
  /** The intent the quote was built from, so the picker knows which groups are locked. */
  intent?: VoucherSelectionIntent;
  quoteDigest?: string | null;
}>): VoucherPickerModel {
  const { quote, entries } = input;
  const group = (kind: "MERCHANDISE" | "SHIPPING_FREE", heading: string, noneLabel: string, noneSelected: boolean): VoucherPickerGroup => {
    const mode = (kind === "MERCHANDISE" ? input.intent?.merchandise.mode : input.intent?.shipping.mode) ?? "AUTO";
    const items = entries
      .filter((entry) => entry.card.kind === kind)
      .map((entry) => ({ item: itemOf(entry.card, entry.state), saving: entry.state.savingVnd ?? 0, shortfall: entry.state.shortfallVnd ?? Number.MAX_SAFE_INTEGER }));
    return Object.freeze({ kind, heading, hint: "Chọn 1", noneLabel, noneSelected, mode, items: Object.freeze(order(items)) });
  };
  const merchandiseSelected = quote.selection.merchandiseId !== null;
  const shippingSelected = quote.selection.shippingId !== null;

  const notices = quote.notices.map((notice) =>
    notice.group === "MERCHANDISE"
      ? "Voucher giảm tiền hàng đã chọn không còn dùng được cho giỏ này, nên đã chọn lại ưu đãi tốt nhất."
      : "Voucher vận chuyển đã chọn không còn dùng được cho giỏ này, nên đã chọn lại ưu đãi tốt nhất.",
  );
  const giftLoss = quote.giftLoss;
  return Object.freeze({
    previewNotHeld: true as const,
    groups: Object.freeze([
      group("MERCHANDISE", "Voucher giảm tiền hàng", "Không dùng voucher giảm tiền hàng", !merchandiseSelected),
      group("SHIPPING_FREE", "Voucher vận chuyển", "Không dùng voucher vận chuyển", !shippingSelected),
    ]) as unknown as readonly [VoucherPickerGroup, VoucherPickerGroup],
    summary: Object.freeze({
      paidBeforeText: formatVoucherVnd(quote.paidBeforeVnd),
      merchandiseDiscountText: quote.merchandiseDiscountVnd > 0 ? `-${formatVoucherVnd(quote.merchandiseDiscountVnd)}` : null,
      shippingFeeText: formatVoucherVnd(quote.shippingFeeVnd),
      shippingDiscountText: quote.shippingDiscountVnd > 0 ? `-${formatVoucherVnd(quote.shippingDiscountVnd)}` : null,
      totalText: formatVoucherVnd(quote.totalPayableVnd),
      totalVnd: quote.totalPayableVnd,
    }),
    footer: Object.freeze(
      quote.voucherCount > 0 ? { label: `Áp dụng • ${quote.voucherCount} ưu đãi`, count: quote.voucherCount } : { label: "Bỏ qua ưu đãi và tiếp tục", count: 0 },
    ),
    quoteDigest: input.quoteDigest ?? null,
    warnings: Object.freeze({
      giftLoss:
        giftLoss === null
          ? null
          : giftLoss.selectedSlotsLost > 0
            ? `Lựa chọn này làm mất ${giftLoss.selectedSlotsLost} suất quà tặng. Nếu nàng tiếp tục, quà đã chọn sẽ được bỏ khỏi giỏ hàng. Nàng có thể đổi voucher để giữ quà.`
            : `Lựa chọn này làm mất ${giftLoss.entitledSlotsLost} suất quà tặng. Nàng có thể đổi voucher để giữ quà.`,
      totalIncrease:
        quote.confirmation === null
          ? null
          : quote.confirmation.shippingFeeIncreaseVnd > 0
            ? `Phí vận chuyển tăng ${formatVoucherVnd(quote.confirmation.shippingFeeIncreaseVnd)}; tổng đơn tăng ${formatVoucherVnd(quote.confirmation.totalIncreaseVnd)} so với không dùng voucher.`
            : `Tổng đơn tăng ${formatVoucherVnd(quote.confirmation.totalIncreaseVnd)} so với không dùng voucher.`,
      notices: Object.freeze(notices),
    }),
  });
}

/** Changes whenever what the server decided changes, so a client picker can be remounted on the fresh model. */
export function voucherPickerKey(model: VoucherPickerModel): string {
  const selected = model.groups.map((group) => `${group.mode}:${group.items.find((item) => item.selected)?.id ?? "-"}`).join("|");
  return `${model.summary.totalVnd}|${model.footer.count}|${selected}`;
}
