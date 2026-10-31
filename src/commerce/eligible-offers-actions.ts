"use server";

import { fetchEligibleOffersPage, type EligibleOffersNextPageResult } from "@/routes/eligible-offers";

export type EligibleOffersNextPageActionInput = {
  campaignId: string;
  page: number;
};

export async function loadEligibleOffersNextPageAction(
  input: EligibleOffersNextPageActionInput,
): Promise<EligibleOffersNextPageResult> {
  return fetchEligibleOffersPage({
    campaignId: input.campaignId,
    page: input.page,
  });
}
