import { lockShippingCampaignRead } from "./shipping-campaign-lock.ts";
import { MAX_CATEGORY_MEMBERSHIPS } from "./category-taxonomy.ts";
import { deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { readGuestShippingPolicy, type GuestShippingPolicy } from "./guest-shipping-policy.ts";
import { evaluateShippingCampaigns, MAX_SHIPPING_CAMPAIGNS, MAX_SHIPPING_QUOTE_LINES, validateShippingCampaign, type ShippingCampaign, type ShippingQuote } from "./shipping-campaign.ts";

export type ShippingReadClient = Pick<Prisma.TransactionClient, "shippingPromotionCampaign" | "variantMirror" | "productCategoryMembership">;
export const shippingCampaignSelection = {
  id: true, pancakeShopId: true, name: true, isEnabled: true, enabledAt: true, disabledAt: true,
  startsAt: true, endsAt: true, revision: true, minimumQuantity: true, priority: true,
  stackingEnabled: true, categoryKeys: true, includeProductIds: true, excludeProductIds: true,
} satisfies Prisma.ShippingPromotionCampaignSelect;
export type ShippingCampaignRow = Prisma.ShippingPromotionCampaignGetPayload<{ select: typeof shippingCampaignSelection }>;

function assertShopId(shopId: number): void {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > 2_147_483_647) throw new RangeError("Invalid shipping shop");
}

export function toShippingCampaign(row: ShippingCampaignRow): ShippingCampaign {
  const parsed = validateShippingCampaign({ ...row, scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: row.categoryKeys, includeProductIds: row.includeProductIds, excludeProductIds: row.excludeProductIds } });
  if (!parsed.ok) throw new RangeError("Invalid persisted shipping campaign");
  return { ...parsed.value, id: row.id, revision: row.revision, isEnabled: row.isEnabled, enabledAt: row.enabledAt, disabledAt: row.disabledAt };
}

/** Reads only this shop's active campaigns, bounded before hydration; a failed read is never an empty list. */
export async function readActiveShippingCampaigns(client: ShippingReadClient, shopId: number, now: Date): Promise<readonly ShippingCampaign[]> {
  assertShopId(shopId);
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid shipping clock");
  const rows = await client.shippingPromotionCampaign.findMany({
    where: { pancakeShopId: shopId, isEnabled: true, AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ] },
    select: shippingCampaignSelection,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    take: MAX_SHIPPING_CAMPAIGNS + 1,
  });
  if (rows.length > MAX_SHIPPING_CAMPAIGNS) throw new RangeError("Shipping campaign read exceeds its bound");
  return rows.map(toShippingCampaign).filter((campaign) => deriveCampaignLifecycle({ ...campaign, now }).status === "ACTIVE");
}

/** Server-only inputs: caller-owned PAID cart/order items, not gift lines or a browser's eligibility count. */
export async function readShippingQuote({ client, shopId, now, paidItems, hasOtherPromotions, policy = readGuestShippingPolicy() }: Readonly<{
  client: ShippingReadClient & Pick<Prisma.TransactionClient, "$executeRaw">;
  shopId: number;
  now: Date;
  paidItems: readonly Readonly<{ variantId: string; quantity: number }>[];
  hasOtherPromotions: boolean;
  policy?: GuestShippingPolicy;
}>): Promise<ShippingQuote> {
  assertShopId(shopId);
  if (!Array.isArray(paidItems) || paidItems.length > MAX_SHIPPING_QUOTE_LINES || paidItems.some((item) => !/^[A-Za-z0-9_-]{1,64}$/.test(item.variantId) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) throw new RangeError("Invalid shipping paid items");
  if (!Number.isSafeInteger(paidItems.reduce((sum, item) => sum + item.quantity, 0))) throw new RangeError("Shipping quantity overflow");
  await lockShippingCampaignRead(client, shopId);
  const campaigns = await readActiveShippingCampaigns(client, shopId, now);
  if (campaigns.length === 0 || paidItems.length === 0) return evaluateShippingCampaigns({ campaigns, lines: [], policy, now, hasOtherPromotions });
  const variantIds = [...new Set(paidItems.map((item) => item.variantId))];
  const variants = await client.variantMirror.findMany({
    where: { id: { in: variantIds }, product: { pancakeShopId: shopId } },
    select: { id: true, productId: true },
  });
  if (variants.length !== variantIds.length) throw new RangeError("Shipping product identity is unavailable");
  const productIds = [...new Set(variants.map((variant) => variant.productId))];
  const membershipLimit = productIds.length * MAX_CATEGORY_MEMBERSHIPS;
  const membership = await client.productCategoryMembership.findMany({ where: { productId: { in: productIds } }, select: { productId: true, categoryKey: true }, take: membershipLimit + 1 });
  if (membership.length > membershipLimit) throw new RangeError("Shipping membership exceeds its bound");
  const categories = new Map(productIds.map((id) => [id, [] as string[]]));
  for (const row of membership) categories.get(row.productId)?.push(row.categoryKey);
  const products = new Map(variants.map((variant) => [variant.id, { productId: variant.productId, categoryKeys: categories.get(variant.productId)! }]));
  return evaluateShippingCampaigns({ campaigns, policy, now, hasOtherPromotions, lines: paidItems.map((item) => ({ role: "PAID", product: products.get(item.variantId)!, quantity: item.quantity })) });
}

/** Copied with the accepted amounts; identifiers remain auditable even if campaign configuration later changes. */
export function shippingQuoteAudit(quote: ShippingQuote) {
  return {
    shippingBaseFeeVnd: BigInt(quote.baseFeeVnd),
    shippingPromotionCampaignId: quote.campaign?.id ?? null,
    shippingPromotionRevision: quote.campaign?.revision ?? null,
  };
}
