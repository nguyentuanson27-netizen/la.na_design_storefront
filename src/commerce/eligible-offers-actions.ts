"use server";

import {
  fetchEligibleOffersCards,
  fetchEligibleOffersPage,
  type EligibleOffersNextPageResult,
  type EligibleOffersRefreshedCards,
} from "@/routes/eligible-offers";

export type EligibleOffersNextPageActionInput = {
  campaignId: string;
  /** Every product id the shopper has on screen, plus those a listing opened at `?page=N` starts after. */
  shownProductIds: string[];
};

export async function loadEligibleOffersNextPageAction(
  input: EligibleOffersNextPageActionInput,
): Promise<EligibleOffersNextPageResult> {
  return fetchEligibleOffersPage({
    campaignId: input.campaignId,
    shownProductIds: input.shownProductIds,
  });
}

/** Fresh card models for products already loaded, after the page was revalidated on the server. */
export async function refreshEligibleOffersCardsAction(input: { productIds: string[] }): Promise<EligibleOffersRefreshedCards> {
  return fetchEligibleOffersCards({ productIds: input.productIds });
}
