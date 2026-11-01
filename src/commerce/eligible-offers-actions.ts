"use server";

import { fetchEligibleOffersPage, type EligibleOffersNextPageResult } from "@/routes/eligible-offers";

export type EligibleOffersNextPageActionInput = {
  campaignId: string;
  /** Every product id the shopper has on screen (or was given and could not be drawn). */
  shownProductIds: string[];
  /** Products ahead of the first one shown: a listing opened at `?page=N` starts after (N - 1) pages. */
  skip: number;
};

export async function loadEligibleOffersNextPageAction(
  input: EligibleOffersNextPageActionInput,
): Promise<EligibleOffersNextPageResult> {
  return fetchEligibleOffersPage({
    campaignId: input.campaignId,
    shownProductIds: input.shownProductIds,
    skip: input.skip,
  });
}
