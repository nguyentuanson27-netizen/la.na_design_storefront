/** Spec list-price-display-v1: exact integer money, independent of campaign membership. */
export function computeListPriceVnd(pos: number | null): number | null {
  if (pos === null || !Number.isSafeInteger(pos) || pos <= 0) return null;
  const target = (BigInt(pos) * BigInt(12) + BigInt(9)) / BigInt(10);
  const list =
    ((target + BigInt(1000) + BigInt(49999)) / BigInt(50000)) * BigInt(50000) -
    BigInt(1000);
  return list <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(list) : null;
}

export type CampaignPriceClassification =
  | "BASE_PRICE_UNAVAILABLE"
  | "LIST_PRICE_UNAVAILABLE"
  | "ARITHMETIC_OR_CONFIG_INVALID"
  | "NON_POSITIVE_AFTER_ROUNDING"
  | "THRESHOLD_NOT_MET"
  | "EFFECTIVE";
export function classifyListPriceCampaign(
  pos: number | null,
  percent: number | null,
): Readonly<{
  classification: CampaignPriceClassification;
  price: number | null;
}> {
  if (pos === null || !Number.isSafeInteger(pos) || pos <= 0)
    return { classification: "BASE_PRICE_UNAVAILABLE", price: null };
  if (
    percent === null ||
    !Number.isInteger(percent) ||
    percent < 1 ||
    percent > 99
  )
    return { classification: "ARITHMETIC_OR_CONFIG_INVALID", price: null };
  const list = computeListPriceVnd(pos);
  if (list === null)
    return { classification: "LIST_PRICE_UNAVAILABLE", price: null };
  const result =
    ((BigInt(list) * BigInt(100 - percent) + BigInt(50000)) / BigInt(100000)) *
    BigInt(1000);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    return { classification: "ARITHMETIC_OR_CONFIG_INVALID", price: null };
  if (result <= BigInt(0))
    return { classification: "NON_POSITIVE_AFTER_ROUNDING", price: null };
  const price = Number(result);
  return {
    classification: price < pos ? "EFFECTIVE" : "THRESHOLD_NOT_MET",
    price,
  };
}
export function minimumEffectiveListPricePercent(
  pos: number | null,
): number | null {
  for (let p = 1; p <= 99; p++)
    if (classifyListPriceCampaign(pos, p).classification === "EFFECTIVE")
      return p;
  return null;
}

export function resolveListPricePresentation(
  input: Readonly<{
    variantId: string;
    basePriceVnd: number | null;
    effectivePriceVnd: number | null;
    listPriceVnd: number | null;
    isDiscounted: boolean;
    enabled: boolean;
  }>,
) {
  const {
    variantId,
    basePriceVnd: base,
    effectivePriceVnd: price,
    listPriceVnd: list,
    enabled,
  } = input;
  if (
    !enabled ||
    !variantId ||
    base === null ||
    price === null ||
    list === null ||
    ![base, price, list].every(Number.isSafeInteger) ||
    !(list > base && base >= price && price > 0)
  )
    return null;
  const percent = Number(
    (BigInt(list - price) * BigInt(100) + BigInt(list) / BigInt(2)) /
      BigInt(list),
  );
  return percent >= 1
    ? Object.freeze({
        variantId,
        referencePriceVnd: list,
        displayPriceVnd: price,
        badgePercent: percent,
      })
    : null;
}

/** Null means no percentage in 1–99 yields a positive price below this POS. */
export function summarizeThresholdWarnings(
  warnings: readonly Readonly<{ minimumPercent: number | null }>[],
) {
  return {
    count: warnings.length,
    minimumPercent: warnings.some((warning) => warning.minimumPercent === null)
      ? null
      : Math.max(...warnings.map((warning) => warning.minimumPercent ?? 0)),
  };
}
