import { compareClothingSizes } from "../commerce/clothing-size.ts";
import { parseTrustedProductImageUrl } from "../commerce/product-media.ts";
import type { CartGiftState } from "../commerce/cart-gift-selection.ts";
import type { GiftSelectionError } from "../commerce/gift-quantity-entitlement.ts";

export type CartGiftPickerModel = Readonly<{
  campaigns: readonly Readonly<{
    campaignId: string; revision: number; earned: number; entitled: number; selected: number;
    unclaimed: number; selectable: number | null; contendedSlots: number; unavailableSlots: number; shortageText: string | null; shortfallText: string | null; allowDuplicateGifts: boolean;
    products: readonly Readonly<{ productId: string; name: string; imageUrl: string | null; options: readonly Readonly<{ variantId: string; label: string; stock: number; color: string | null; size: string | null }>[] }>[];
  }>[];
  selections: readonly Readonly<{ campaignId: string; variantId: string; campaignRevision: number; quantity: number; label: string; imageUrl?: string | null; problems?: readonly string[] }>[];
  /** Choices kept at a lower milestone the cart has moved past. Not in the order; taking a new gift replaces them. */
  replaced?: readonly Readonly<{ campaignId: string; variantId: string; campaignRevision: number; quantity: number; label: string; imageUrl?: string | null }>[];
  repairGroups?: readonly Readonly<{ message: string; selectionKeys: readonly string[] }>[];
  invalid: boolean;
  stackConflict: boolean;
}>;

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const repairText: Record<GiftSelectionError, string> = {
  SELECTION_INVALID: "Món quà đã chọn không còn nhận được nữa. Nàng bấm “Bỏ quà để chọn lại” rồi chọn món khác nhé.",
  SELECTION_REVISION_INVALID: "Mẫu quà này không còn nằm trong danh sách quà của chương trình. Nàng bấm “Bỏ quà để chọn lại” rồi chọn một mẫu khác trong danh sách nhé.",
  CAMPAIGN_NOT_ENTITLED: "Đơn hàng hiện chưa đủ điều kiện nhận món quà này (ví dụ nàng vừa giảm số lượng hoặc đổi sản phẩm). Nàng thêm sản phẩm cho đủ điều kiện, hoặc bấm “Bỏ quà để chọn lại” nhé.",
  STALE_CAMPAIGN_REVISION: "Chương trình quà tặng đã được cập nhật. Nàng bấm “Bỏ quà để chọn lại” để chọn theo ưu đãi mới nhé.",
  VARIANT_NOT_ALLOWED: "Mẫu quà (màu hoặc size) này không còn nằm trong danh sách quà của chương trình. Nàng bấm “Bỏ quà để chọn lại” rồi chọn một mẫu khác trong danh sách nhé.",
  OVER_ENTITLEMENT: "Số quà đã chọn nhiều hơn số suất của đơn. Nàng bỏ bớt quà trong nhóm này nhé.",
  DUPLICATE_PRODUCT_NOT_ALLOWED: "Mỗi mẫu quà chỉ được nhận một lần, kể cả khác màu hoặc kích cỡ. Nàng bỏ bớt quà trùng và chọn mẫu khác nhé.",
  OUT_OF_STOCK: "Món quà này tạm hết hàng. Nàng bấm “Bỏ quà để chọn lại” rồi chọn món khác nhé.",
};

/**
 * A product's gift options in the order a shopper reads them: grouped by colour, and within a
 * colour the sizes run XS → S → M → L → XL → 2XL, the same comparison the product page uses.
 * Storage order (L, M, S, XL) is not an order anyone shops in, and it is not even stable: a
 * campaign's gift options are read without an order and carry no position, so colours sort by
 * name (Vietnamese collation) and the variant id breaks any remaining tie. The result depends only
 * on the options, never on the order the database returned them in.
 */
function orderGiftOptions<T extends { variantId: string }>(
  options: readonly T[],
  labelByVariant: ReadonlyMap<string, { color?: string | null; size?: string | null }>,
): T[] {
  const colorOf = (option: T) => labelByVariant.get(option.variantId)?.color ?? "";
  const sizeOf = (option: T) => labelByVariant.get(option.variantId)?.size ?? "";
  return [...options].sort(
    (a, b) =>
      colorOf(a).localeCompare(colorOf(b), "vi", { sensitivity: "base" }) ||
      compareClothingSizes(sizeOf(a), sizeOf(b)) ||
      (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0),
  );
}

export function buildCartGiftPickerModel(state: CartGiftState): CartGiftPickerModel {
  const labelByVariant = new Map(state.labels.map((label) => [label.variantId, label]));
  const selectionKey = (row: { campaignId: string; variantId: string }) => `${row.campaignId}/${row.variantId}`;
  const problems = new Map<string, string[]>();
  const repairGroups: { message: string; selectionKeys: string[] }[] = [];
  if (!state.validation.ok) for (const issue of state.validation.issues) {
    // lineIndex belongs to the validator's original selection array, before presentation ordering.
    const line = issue.lineIndex === null ? undefined : state.selections[issue.lineIndex];
    if (line) {
      const key = selectionKey(line);
      problems.set(key, [...(problems.get(key) ?? []), repairText[issue.error]]);
    } else {
      // Aggregate issues describe a scope, never an arbitrarily selected "bad" line.
      const affected = state.selections.filter(row =>
        (issue.campaignId === null || row.campaignId === issue.campaignId) &&
        (issue.variantId === null || row.variantId === issue.variantId));
      repairGroups.push({
        message: issue.error === "OUT_OF_STOCK"
          ? "Quà tặng trong nhóm này không còn đủ số lượng cho các món nàng đã chọn. Nàng bỏ bớt hoặc chọn sang món khác nhé."
          : repairText[issue.error],
        selectionKeys: affected.map(selectionKey),
      });
    }
  }
  const superseded = new Set((state.giftSuperseded ?? []).map((entry) => entry.campaignId));
  const labelOf = (variantId: string) => {
    const label = labelByVariant.get(variantId);
    return label ? `${label.productName} — ${label.optionLabel}` : "Quà đã chọn không còn khả dụng";
  };
  return {
    invalid: !state.validation.ok,
    // Giving way to a higher milestone is the rule working, not a conflict the buyer must fix.
    stackConflict: (state.giftStackDropped ?? []).some((entry) => !superseded.has(entry.campaignId)),
    replaced: (state.replacedSelections ?? []).map((row) => ({ campaignId: row.campaignId, variantId: row.variantId,
      campaignRevision: row.campaignRevision, quantity: row.quantity, label: labelOf(row.variantId),
      imageUrl: parseTrustedProductImageUrl(labelByVariant.get(row.variantId)?.imageUrl) })),
    repairGroups,
    selections: state.selections.map((row) => ({ campaignId: row.campaignId, variantId: row.variantId,
      campaignRevision: row.campaignRevision, quantity: row.quantity,
      imageUrl: parseTrustedProductImageUrl(labelByVariant.get(row.variantId)?.imageUrl),
      problems: problems.get(selectionKey(row)) ?? [], label: labelOf(row.variantId) })),
    campaigns: state.entitlements.map((entry) => {
      const selected = state.selections.filter((row) => row.campaignId === entry.campaignId).reduce((sum, row) => sum + row.quantity, 0);
      const campaign = state.campaigns.find((c) => c.id === entry.campaignId)!;
      const summary = state.validation.ok ? state.validation.summaries.find((row) => row.campaignId === entry.campaignId) : undefined;
      const products = new Map<string, { productId: string; name: string; imageUrl: string | null; options: { variantId: string; label: string; stock: number; color: string | null; size: string | null }[] }>();
      for (const option of campaign.options) {
        // Show only gifts that can actually be awarded now; stale selections remain in the repair list.
        if (option.readyAvailable <= 0) continue;
        const label = labelByVariant.get(option.variantId);
        if (!label) continue;
        const candidateImage = parseTrustedProductImageUrl(label.imageUrl);
        const product = products.get(option.productId) ?? { productId: option.productId, name: label.productName, imageUrl: candidateImage, options: [] };
        if (!product.imageUrl && candidateImage) {
          product.imageUrl = candidateImage;
        }
        product.options.push({ variantId: option.variantId, label: label.optionLabel || "Phiên bản tiêu chuẩn", stock: option.readyAvailable, color: label.color ?? null, size: label.size ?? null });
        products.set(option.productId, product);
      }
      const shortfall = entry.shortfallToNext;
      // The engine aggregate includes distinct-product limits and shared capacity, not just stock.
      const unavailableSlots = summary?.shortForStock ?? entry.unfulfillableForStock;
      const shortageText = unavailableSlots === 0 ? null : campaign.options.length > 0 && campaign.options.every((option) => option.readyAvailable === 0)
        ? `Thiếu tồn kho cho ${unavailableSlots} suất quà.`
        : `Không đủ lựa chọn quà hợp lệ cho ${unavailableSlots} suất.`;
      return { campaignId: entry.campaignId, revision: entry.revision, earned: entry.earned, entitled: entry.entitled, selected,
        unclaimed: Math.max(0, entry.entitled - selected), selectable: summary ? summary.skippedWhileAvailable + summary.contendedForSharedStock : null, contendedSlots: summary?.contendedForSharedStock ?? 0, unavailableSlots, shortageText, allowDuplicateGifts: campaign.allowDuplicateGifts,
        shortfallText: shortfall?.quantity ? `Mua thêm ${shortfall.quantity} sản phẩm phù hợp để đạt mốc quà tiếp theo.` : shortfall?.subtotalVnd ? `Mua thêm ${currency.format(shortfall.subtotalVnd)} để đạt mốc quà tiếp theo.` : null,
        products: [...products.values()].map((product) => ({ ...product, options: orderGiftOptions(product.options, labelByVariant) })) };
    }),
  };
}
