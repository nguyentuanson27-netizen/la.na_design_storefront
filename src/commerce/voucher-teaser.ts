import { toVoucherCard } from "./voucher-candidate-repository.ts";
import type { VoucherCampaign } from "./voucher-campaign.ts";
import { buildVoucherScopeResolver, type VoucherProductFacts } from "./voucher-scope.ts";

/**
 * Voucher v1 (V17): the small PDP teaser (spec §7.1). It names up to two PUBLIC vouchers that cover this product and
 * states their own conditions -- never that the shopper "will get" one, because eligibility depends on the cart.
 * Pure: it shows nothing a hold or a quote would need, so rendering the page can never reserve anything.
 */

export const MAX_VOUCHER_TEASER_ITEMS = 2;

export type VoucherTeaserItem = Readonly<{ id: string; text: string }>;

const money = new Intl.NumberFormat("vi-VN");
const vnd = (value: number) => `${money.format(value)}đ`;

function textOf(campaign: VoucherCampaign): string {
  const card = toVoucherCard(campaign);
  const min = card.minEligibleSubtotalVnd === null ? "" : ` cho đơn từ ${vnd(card.minEligibleSubtotalVnd)}`;
  if (card.kind === "SHIPPING_FREE") return `Miễn phí vận chuyển${min}`;
  const discount = card.discount;
  if (discount === null) return card.name;
  if (discount.type === "FIXED_AMOUNT_VND") return `Giảm ${vnd(discount.amountVnd)}${min}`;
  return `Giảm ${discount.percent}%${discount.maxDiscountVnd === null ? "" : ` (tối đa ${vnd(discount.maxDiscountVnd)})`}${min}`;
}

/** A rough "worth" used only to pick which two to show: merchandise by amount-ish, then freeship. Ties by id. */
function weight(campaign: VoucherCampaign): number {
  if (campaign.kind === "SHIPPING_FREE") return 1;
  const discount = campaign.discount;
  if (discount === null) return 0;
  return discount.type === "FIXED_AMOUNT_VND" ? discount.amountVnd : (discount.maxDiscountVnd ?? discount.percent * 10_000);
}

export function buildVoucherTeaser(input: Readonly<{ campaigns: readonly VoucherCampaign[]; product: VoucherProductFacts }>): readonly VoucherTeaserItem[] {
  const items = input.campaigns
    .filter((campaign) => campaign.visibility === "PUBLIC" && toVoucherCard(campaign).availability === "AVAILABLE")
    .filter((campaign) => buildVoucherScopeResolver(campaign.scope, String(campaign.pancakeShopId))(input.product))
    .sort((a, b) => weight(b) - weight(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_VOUCHER_TEASER_ITEMS)
    .map((campaign) => Object.freeze({ id: campaign.id, text: textOf(campaign) }));
  return Object.freeze(items);
}
