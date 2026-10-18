import { prisma } from "../db/prisma.ts";
import { readAdvisoryHeldQuantities, type AdvisoryHoldReadClient } from "./capacity-advisory.ts";
import {
  readActiveGiftQuantityCampaigns,
  readScopeProductFacts,
  type GiftQuantityCandidateReadClient,
} from "./gift-quantity-candidate-repository.ts";
import {
  areProductPromotionOffersOpen,
  giftOptionVariantIds,
  isReadyGiftOption,
  selectProductPromotionOffers,
  type ProductPromotionOffer,
} from "./product-promotion-offers.ts";

type GiftVariantRow = Readonly<{
  id: string;
  isActive: boolean;
  isPresent: boolean;
  product: Readonly<{ isActive: boolean; isPresent: boolean }>;
  warehouseStocks: ReadonlyArray<Readonly<{ quantity: number }>>;
  compositeComponents: ReadonlyArray<unknown>;
}>;

/** Everything this read touches, so a test or a transaction can pass its own client. */
export type ProductPromotionOffersReadClient = GiftQuantityCandidateReadClient &
  AdvisoryHoldReadClient & {
    variantMirror: { findMany: (args: unknown) => Promise<GiftVariantRow[]> };
  };

/**
 * The gift variants that could be granted today, read the way the cart reads them
 * (`cart-gift-selection.ts`): this shop's variants only, live, standalone, READY stock net of
 * advisory holds. The cart also subtracts its own lines' demand; a product page has no basket, so
 * a gift the shopper's own order would use up is still reported as available here.
 */
async function readReadyGiftVariantIds(
  client: ProductPromotionOffersReadClient,
  variantIds: readonly string[],
  shopId: number,
): Promise<ReadonlySet<string>> {
  if (variantIds.length === 0) return new Set();
  const [variants, held] = await Promise.all([
    client.variantMirror.findMany({
      where: { id: { in: [...variantIds] }, product: { pancakeShopId: shopId } },
      select: {
        id: true,
        isActive: true,
        isPresent: true,
        product: { select: { isActive: true, isPresent: true } },
        warehouseStocks: { select: { quantity: true } },
        compositeComponents: { select: { componentVariantId: true } },
      },
    }),
    readAdvisoryHeldQuantities(client, variantIds),
  ]);
  const ready = new Set<string>();
  for (const variant of variants) {
    const option = {
      active: variant.isActive && variant.isPresent && variant.product.isActive && variant.product.isPresent,
      composite: variant.compositeComponents.length > 0,
      stock: variant.warehouseStocks.reduce((sum, row) => sum + row.quantity, 0),
      held: held.get(variant.id) ?? 0,
    };
    if (isReadyGiftOption(option)) ready.add(variant.id);
  }
  return ready;
}

/** The database half of `product-promotion-offers.ts`: read, then select; any failure says nothing. */
export async function readProductPromotionOffers({
  productId,
  now,
  client = prisma as unknown as ProductPromotionOffersReadClient,
  env = process.env,
}: Readonly<{
  productId: string;
  now: Date;
  client?: ProductPromotionOffersReadClient;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<readonly ProductPromotionOffer[]> {
  if (!areProductPromotionOffersOpen(env)) return [];
  try {
    const lookup = await readActiveGiftQuantityCampaigns({ now, productIds: [productId], client, env });
    if (!lookup.enabled || lookup.campaigns.length === 0) return [];
    const [facts] = await readScopeProductFacts({ productIds: [productId], client });
    if (facts === undefined) return [];
    // `areProductPromotionOffersOpen` has already proved the shop id is a positive integer.
    const shopId = Number(env.PANCAKE_SHOP_ID!.trim());
    const readyGifts = await readReadyGiftVariantIds(client, giftOptionVariantIds(lookup.campaigns), shopId);
    return selectProductPromotionOffers(lookup.campaigns, facts, readyGifts);
  } catch {
    // A promotion line is an aid to the decision, never a reason for the product page to fail.
    return [];
  }
}
