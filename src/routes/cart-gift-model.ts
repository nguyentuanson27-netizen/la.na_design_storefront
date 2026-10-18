import { parseTrustedProductImageUrl } from "../commerce/product-media.ts";
import type { CartGiftState } from "../commerce/cart-gift-selection.ts";
import type { GiftSelectionError } from "../commerce/gift-quantity-entitlement.ts";

export type CartGiftPickerModel = Readonly<{
  campaigns: readonly Readonly<{
    campaignId: string; revision: number; earned: number; entitled: number; selected: number;
    unclaimed: number; selectable: number | null; contendedSlots: number; unavailableSlots: number; shortageText: string | null; shortfallText: string | null; allowDuplicateGifts: boolean;
    products: readonly Readonly<{ productId: string; name: string; imageUrl: string | null; options: readonly Readonly<{ variantId: string; label: string; stock: number }>[] }>[];
  }>[];
  selections: readonly Readonly<{ campaignId: string; variantId: string; campaignRevision: number; quantity: number; label: string; imageUrl?: string | null; problems?: readonly string[] }>[];
  repairGroups?: readonly Readonly<{ message: string; selectionKeys: readonly string[] }>[];
  invalid: boolean;
  stackConflict: boolean;
}>;

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const repairText: Record<GiftSelectionError, string> = {
  SELECTION_INVALID: "Lựa chọn quà không còn hợp lệ. Hãy bỏ lựa chọn cũ rồi chọn lại.",
  SELECTION_REVISION_INVALID: "Chưa xác nhận được phiên bản chương trình của quà này. Hãy bỏ lựa chọn cũ rồi chọn lại.",
  CAMPAIGN_NOT_ENTITLED: "Quà này không còn thuộc quyền nhận của giỏ hàng hiện tại. Hãy bỏ lựa chọn cũ rồi chọn lại.",
  STALE_CAMPAIGN_REVISION: "Chương trình quà đã thay đổi. Hãy bỏ lựa chọn cũ rồi chọn lại theo quyền nhận hiện tại.",
  VARIANT_NOT_ALLOWED: "Phiên bản quà này không còn được áp dụng. Hãy bỏ lựa chọn cũ rồi chọn lại.",
  OVER_ENTITLEMENT: "Nhóm quà này vượt số suất được nhận. Hãy giảm hoặc bỏ lựa chọn trong nhóm.",
  DUPLICATE_PRODUCT_NOT_ALLOWED: "Nhóm quà này có mẫu được chọn nhiều lần. Mỗi mẫu chỉ được nhận một lần; hãy giảm hoặc bỏ lựa chọn trùng trong nhóm.",
  OUT_OF_STOCK: "Phiên bản quà này không còn số lượng có thể cấp. Hãy bỏ lựa chọn cũ rồi chọn lại.",
};

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
          ? "Tổng số quà trong nhóm vượt lượng có thể cấp dùng chung. Hãy giảm hoặc bỏ lựa chọn trong nhóm."
          : repairText[issue.error],
        selectionKeys: affected.map(selectionKey),
      });
    }
  }
  return {
    invalid: !state.validation.ok,
    stackConflict: (state.giftStackDropped?.length ?? 0) > 0,
    repairGroups,
    selections: state.selections.map((row) => {
      const label = labelByVariant.get(row.variantId);
      return { campaignId: row.campaignId, variantId: row.variantId, campaignRevision: row.campaignRevision, quantity: row.quantity,
        imageUrl: parseTrustedProductImageUrl(label?.imageUrl),
        problems: problems.get(selectionKey(row)) ?? [],
        label: label ? `${label.productName} — ${label.optionLabel}` : "Quà đã chọn không còn khả dụng" };
    }),
    campaigns: state.entitlements.map((entry) => {
      const selected = state.selections.filter((row) => row.campaignId === entry.campaignId).reduce((sum, row) => sum + row.quantity, 0);
      const campaign = state.campaigns.find((c) => c.id === entry.campaignId)!;
      const summary = state.validation.ok ? state.validation.summaries.find((row) => row.campaignId === entry.campaignId) : undefined;
      const products = new Map<string, { productId: string; name: string; imageUrl: string | null; options: { variantId: string; label: string; stock: number }[] }>();
      for (const option of campaign.options) {
        const label = labelByVariant.get(option.variantId);
        if (!label || option.composite) continue;
        const candidateImage = parseTrustedProductImageUrl(label.imageUrl);
        const product = products.get(option.productId) ?? { productId: option.productId, name: label.productName, imageUrl: candidateImage, options: [] };
        if (!product.imageUrl && candidateImage) {
          product.imageUrl = candidateImage;
        }
        product.options.push({ variantId: option.variantId, label: label.optionLabel || "Phiên bản tiêu chuẩn", stock: option.readyAvailable });
        products.set(option.productId, product);
      }
      const shortfall = entry.shortfallToNext;
      // The engine aggregate includes distinct-product limits and shared capacity, not just stock.
      const unavailableSlots = summary?.shortForStock ?? entry.unfulfillableForStock;
      const shortageText = unavailableSlots === 0 ? null : campaign.options.length > 0 && campaign.options.every((option) => !option.composite && option.readyAvailable === 0)
        ? `Thiếu tồn kho cho ${unavailableSlots} suất quà.`
        : `Không đủ lựa chọn quà hợp lệ cho ${unavailableSlots} suất.`;
      return { campaignId: entry.campaignId, revision: entry.revision, earned: entry.earned, entitled: entry.entitled, selected,
        unclaimed: Math.max(0, entry.entitled - selected), selectable: summary ? summary.skippedWhileAvailable + summary.contendedForSharedStock : null, contendedSlots: summary?.contendedForSharedStock ?? 0, unavailableSlots, shortageText, allowDuplicateGifts: campaign.allowDuplicateGifts,
        shortfallText: shortfall?.quantity ? `Mua thêm ${shortfall.quantity} sản phẩm phù hợp để đạt mốc quà tiếp theo.` : shortfall?.subtotalVnd ? `Mua thêm ${currency.format(shortfall.subtotalVnd)} để đạt mốc quà tiếp theo.` : null,
        products: [...products.values()] };
    }),
  };
}
