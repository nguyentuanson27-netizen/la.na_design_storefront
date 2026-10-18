import {
  readActiveGiftQuantityCampaigns,
  readScopeProductFacts,
  type GiftQuantityCandidateReadClient,
} from "./gift-quantity-candidate-repository.ts";
import {
  areProductPromotionOffersOpen,
  selectProductPromotionOffers,
  type ProductPromotionOffer,
} from "./product-promotion-offers.ts";

/** The database half of `product-promotion-offers.ts`: read, then select; any failure says nothing. */
export async function readProductPromotionOffers({
  productId,
  now,
  client,
  env = process.env,
}: Readonly<{
  productId: string;
  now: Date;
  client?: GiftQuantityCandidateReadClient;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<readonly ProductPromotionOffer[]> {
  if (!areProductPromotionOffersOpen(env)) return [];
  try {
    const lookup = await readActiveGiftQuantityCampaigns({ now, productIds: [productId], client, env });
    if (!lookup.enabled || lookup.campaigns.length === 0) return [];
    const [facts] = await readScopeProductFacts({ productIds: [productId], client });
    return facts === undefined ? [] : selectProductPromotionOffers(lookup.campaigns, facts);
  } catch {
    // A promotion line is an aid to the decision, never a reason for the product page to fail.
    return [];
  }
}
