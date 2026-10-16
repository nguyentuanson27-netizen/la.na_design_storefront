import { parseTrustedProductImageUrl } from "../commerce/product-media.ts";
import type { CartGiftState } from "../commerce/cart-gift-selection.ts";

export type CartGiftPickerModel = Readonly<{
  campaigns: readonly Readonly<{
    campaignId: string; revision: number; earned: number; entitled: number; selected: number;
    unclaimed: number; selectable: number | null; contendedSlots: number; unavailableSlots: number; shortageText: string | null; shortfallText: string | null; allowDuplicateGifts: boolean;
    products: readonly Readonly<{ productId: string; name: string; imageUrl: string | null; options: readonly Readonly<{ variantId: string; label: string; stock: number }>[] }>[];
  }>[];
  selections: readonly Readonly<{ campaignId: string; variantId: string; campaignRevision: number; quantity: number; label: string; imageUrl?: string | null }>[];
  invalid: boolean;
  stackConflict: boolean;
}>;

const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
export function buildCartGiftPickerModel(state: CartGiftState): CartGiftPickerModel {
  const labelByVariant = new Map(state.labels.map((label) => [label.variantId, label]));
  return {
    invalid: !state.validation.ok,
    stackConflict: (state.giftStackDropped?.length ?? 0) > 0,
    selections: state.selections.map((row) => {
      const label = labelByVariant.get(row.variantId);
      return { campaignId: row.campaignId, variantId: row.variantId, campaignRevision: row.campaignRevision, quantity: row.quantity,
        imageUrl: parseTrustedProductImageUrl(label?.imageUrl),
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
        const product = products.get(option.productId) ?? { productId: option.productId, name: label.productName, imageUrl: parseTrustedProductImageUrl(label.imageUrl), options: [] };
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
