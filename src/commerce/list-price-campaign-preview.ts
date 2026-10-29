import { requireAdminSession } from "../auth/authorization.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import type {
  AdminSessionCandidate,
  PromotionThresholdWarning,
} from "./promotion-activation-service.ts";
import { readListPriceConfig } from "./list-price-config.ts";
import {
  classifyListPriceCampaign,
  minimumEffectiveListPricePercent,
  summarizeThresholdWarnings,
} from "./list-price.ts";

/** Advisory only. Draft persistence stays non-expanding; publish revalidates under its locks. */
export async function previewListPriceCampaign(
  input: Readonly<{
    client: PrismaClient;
    session: AdminSessionCandidate;
    campaignId: string;
  }>,
) {
  requireAdminSession(input.session);
  if (
    !readListPriceConfig().campaignBasis ||
    !isBoundedPromotionIdentifier(input.campaignId)
  )
    return {};
  const campaign = await input.client.promotionCampaign.findUnique({
    where: { id: input.campaignId },
    select: {
      discountType: true,
      percentageValue: true,
      targets: { select: { productId: true, variantId: true } },
    },
  });
  if (!campaign || campaign.discountType !== "PERCENTAGE") return {};
  const productIds = campaign.targets.flatMap((target) =>
    target.productId ? [target.productId] : [],
  );
  const variantIds = campaign.targets.flatMap((target) =>
    target.variantId ? [target.variantId] : [],
  );
  const variants = await input.client.variantMirror.findMany({
    where: {
      OR: [{ productId: { in: productIds } }, { id: { in: variantIds } }],
    },
    select: { id: true, pancakeRetailPrice: true },
    orderBy: { id: "asc" },
    take: 2001,
  });
  // Never present truncated coverage as a complete warning count. Activation enforces this bound.
  if (variants.length > 2000) return {};
  const warnings: PromotionThresholdWarning[] = [];
  for (const variant of variants) {
    if (
      classifyListPriceCampaign(
        variant.pancakeRetailPrice,
        campaign.percentageValue,
      ).classification === "THRESHOLD_NOT_MET"
    ) {
      warnings.push({
        variantId: variant.id,
        minimumPercent: minimumEffectiveListPricePercent(
          variant.pancakeRetailPrice,
        ),
      });
    }
  }
  return warnings.length
    ? {
        warnings: warnings.slice(0, 50),
        warningSummary: summarizeThresholdWarnings(warnings),
      }
    : {};
}
