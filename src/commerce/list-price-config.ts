export function readListPriceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const display = env.LIST_PRICE_DISPLAY === "true";
  const campaignBasis = env.LIST_PRICE_CAMPAIGN_BASIS === "true";
  if (campaignBasis && !display)
    throw new Error("LIST_PRICE_CAMPAIGN_BASIS requires LIST_PRICE_DISPLAY");
  return Object.freeze({
    display,
    campaignBasis,
    orderHistory: env.LIST_PRICE_ORDER_HISTORY === "true",
  });
}
