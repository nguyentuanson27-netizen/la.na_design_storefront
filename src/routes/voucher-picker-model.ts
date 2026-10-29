import type { VoucherCard } from "../commerce/voucher-candidate-repository.ts";
import type { VoucherSelectionIntent } from "../commerce/voucher-optimizer.ts";
import type { VoucherCardReason, VoucherCardState, VoucherQuote } from "../commerce/voucher-quote.ts";

/**
 * Voucher v1 (V15, one group per slot per ADR 0020): the picker as plain data (spec §7). No pricing happens here and nothing is decided in React:
 * the model only words and orders what the server-derived `VoucherQuote` already says, so PDP, cart and checkout
 * show the same groups (one per merchandise type, then shipping), the same reasons and the same totals.
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
  /** The slot this group chooses one voucher for: `SHIPPING_FREE`, `MERCHANDISE` (no type) or `MERCHANDISE:<typeId>`. */
  slot: string;
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
  /** Merchandise groups in application order (type priority), then shipping last. */
  groups: readonly VoucherPickerGroup[];
  summary: Readonly<{
    paidBeforeText: string;
    merchandiseDiscountText: string | null;
    /** One line per chosen merchandise voucher, in application order, when more than one applies. */
    merchandiseLines: readonly Readonly<{ id: string; label: string; amountText: string }>[];
    shippingFeeText: string;
    shippingDiscountText: string | null;
    totalText: string;
    totalVnd: number;
  }>;
  footer: Readonly<{ label: string; count: number }>;
  /** Digest of the exact quote shown. The hold POST sends it back; a different quote is never held on an equal total. */
  quoteDigest: string | null;
  /** Version of the choice the cart has SAVED when this model was derived; sent back by "Áp dụng" so a stale picker is refused. */
  selectionVersion: string | null;
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
    savingText: state.savingVnd === null ? null : `-${formatVoucherVnd(state.savingVnd)}`,
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
  selectionVersion?: string | null;
}>): VoucherPickerModel {
  const { quote, entries } = input;
  const intent = input.intent;
  const itemsOf = (slotEntries: typeof entries) =>
    slotEntries.map((entry) => ({ item: itemOf(entry.card, entry.state), saving: entry.state.savingVnd ?? 0, shortfall: entry.state.shortfallVnd ?? Number.MAX_SAFE_INTEGER }));
  const slotGroup = (slot: string, kind: VoucherPickerGroup["kind"], heading: string, hint: string, noneLabel: string, slotEntries: typeof entries): VoucherPickerGroup => {
    const mode = (kind === "MERCHANDISE" ? intent?.merchandise[slot]?.mode : intent?.shipping.mode) ?? "AUTO";
    const items = order(itemsOf(slotEntries));
    return Object.freeze({ slot, kind, heading, hint, noneLabel, noneSelected: !items.some((item) => item.selected), mode, items: Object.freeze(items) });
  };

  // Merchandise: one group per slot that has a card, in the order the stack is applied (untyped first, then by type priority).
  const merchandiseEntries = entries.filter((entry) => entry.card.kind === "MERCHANDISE");
  const slots = new Map<string, { priority: number; name: string | null; entries: (typeof entries)[number][] }>();
  for (const entry of merchandiseEntries) {
    const slot = entry.state.slot;
    const slotInfo = slots.get(slot) ?? { priority: entry.card.type?.priority ?? 0, name: entry.card.type?.name ?? null, entries: [] };
    slotInfo.entries.push(entry);
    slots.set(slot, slotInfo);
  }
  const merchandiseGroups = [...slots.entries()]
    .sort(([slotA, a], [slotB, b]) => a.priority - b.priority || (slotA < slotB ? -1 : slotA > slotB ? 1 : 0))
    .map(([slot, info]) =>
      info.name === null
        ? slotGroup(slot, "MERCHANDISE", "Voucher giảm tiền hàng", "Chọn 1", "Không dùng voucher giảm tiền hàng", info.entries)
        : slotGroup(slot, "MERCHANDISE", info.name, "Chọn 1 mốc", `Không dùng voucher “${info.name}”`, info.entries),
    );
  // v1 always listed the (possibly empty) merchandise group; keep that when no card exists.
  if (merchandiseGroups.length === 0) merchandiseGroups.push(slotGroup("MERCHANDISE", "MERCHANDISE", "Voucher giảm tiền hàng", "Chọn 1", "Không dùng voucher giảm tiền hàng", []));
  const shippingGroup = slotGroup("SHIPPING_FREE", "SHIPPING_FREE", "Voucher vận chuyển", "Chọn 1", "Không dùng voucher vận chuyển", entries.filter((entry) => entry.card.kind === "SHIPPING_FREE"));
  const merchandiseLines = quote.merchandise.map((line) => {
    const card = entries.find((entry) => entry.card.id === line.campaignId)?.card;
    return Object.freeze({ id: line.campaignId, label: card?.type?.name ?? "Voucher giảm tiền hàng", amountText: `-${formatVoucherVnd(line.discountVnd)}` });
  });

  const notices = quote.notices.map((notice) =>
    notice.group === "MERCHANDISE"
      ? "Voucher giảm tiền hàng đã chọn không còn dùng được cho giỏ này, nên đã chọn lại ưu đãi tốt nhất."
      : "Voucher vận chuyển đã chọn không còn dùng được cho giỏ này, nên đã chọn lại ưu đãi tốt nhất.",
  );
  const giftLoss = quote.giftLoss;
  return Object.freeze({
    previewNotHeld: true as const,
    groups: Object.freeze([...merchandiseGroups, shippingGroup]),
    summary: Object.freeze({
      paidBeforeText: formatVoucherVnd(quote.paidBeforeVnd),
      merchandiseDiscountText: quote.merchandiseDiscountVnd > 0 ? `-${formatVoucherVnd(quote.merchandiseDiscountVnd)}` : null,
      merchandiseLines: Object.freeze(merchandiseLines.length > 1 ? merchandiseLines : []),
      shippingFeeText: formatVoucherVnd(quote.shippingFeeVnd),
      shippingDiscountText: quote.shippingDiscountVnd > 0 ? `-${formatVoucherVnd(quote.shippingDiscountVnd)}` : null,
      totalText: formatVoucherVnd(quote.totalPayableVnd),
      totalVnd: quote.totalPayableVnd,
    }),
    footer: Object.freeze(
      quote.voucherCount > 0 ? { label: `Áp dụng • ${quote.voucherCount} ưu đãi`, count: quote.voucherCount } : { label: "Bỏ qua ưu đãi và tiếp tục", count: 0 },
    ),
    quoteDigest: input.quoteDigest ?? null,
    selectionVersion: input.selectionVersion ?? null,
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
  const selected = model.groups.map((group) => `${group.slot}=${group.mode}:${group.items.find((item) => item.selected)?.id ?? "-"}`).join("|");
  return `${model.summary.totalVnd}|${model.footer.count}|${selected}`;
}
