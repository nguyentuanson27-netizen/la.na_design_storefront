/**
 * The central effective-price authority.
 *
 * One semantic resolver supplies storefront, cart, checkout, order audit, structured data,
 * analytics and the final Pancake line mapping. Nothing downstream re-derives a promotional price:
 * a second formula in a card, a cart projection or a feed is how two surfaces end up quoting
 * different money for the same variant.
 *
 * It is deliberately pure and takes an explicit `now`. Reading the clock inside would make every
 * consumer's behaviour untestable at a window boundary, and a storefront render, a cart quote and a
 * checkout reconfirmation of the same request must all resolve against one instant.
 *
 * This module does not decide *which* campaigns apply to a variant — that membership question
 * belongs to the promotion repository. It is handed the candidates and owns the money.
 *
 * `pancakeRetailPriceAfterDiscount` is intentionally absent. Under the approved v1 decision website
 * pricing is `pancakeRetailPrice` plus website campaign state, so a lower Pancake discount field
 * neither sets the effective price nor makes it unresolved.
 */

/**
 * Every campaign kind, in admin display order. Mirrors the `PromotionCampaignKind` database enum;
 * allowlists and SQL kind lists derive from this rather than restating it.
 *
 * `CLEARANCE` is "Xả hàng lẻ size": priced exactly like `PROMOTION` (no window required), and kept
 * as its own kind so the storefront can list and label it separately.
 */
export const PROMOTION_CAMPAIGN_KINDS = ["PROMOTION", "FLASH_SALE", "CLEARANCE"] as const;

export type PromotionCampaignKind = (typeof PROMOTION_CAMPAIGN_KINDS)[number];

/** How the admin names each kind. */
export const PROMOTION_CAMPAIGN_KIND_LABELS: Readonly<Record<PromotionCampaignKind, string>> = {
  PROMOTION: "Khuyến mãi",
  FLASH_SALE: "Flash Sale",
  CLEARANCE: "Xả hàng lẻ size",
};

export function isPromotionCampaignKind(value: unknown): value is PromotionCampaignKind {
  return (PROMOTION_CAMPAIGN_KINDS as readonly unknown[]).includes(value);
}

export type PromotionDiscountType = "PERCENTAGE" | "FIXED_PRICE";

/**
 * A campaign the repository has already established as covering this variant. Times are UTC
 * instants; the interval is half-open `[startsAt, endsAt)` with a null bound meaning unbounded.
 *
 * `fixedPriceVnd` stays `bigint` all the way from the database. Converting to `number` at the
 * repository boundary would silently lose precision above 2^53, and losing precision on money is
 * exactly the failure this resolver exists to prevent.
 */
export type ApplicablePromotionCampaign = Readonly<{
  id: string;
  name: string;
  kind: PromotionCampaignKind;
  discountType: PromotionDiscountType;
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
}>;

export type PromotionSnapshot = Readonly<{
  id: string;
  name: string;
  kind: PromotionCampaignKind;
  discountType: PromotionDiscountType;
  percentageValue: number | null;
  fixedPriceVnd: bigint | null;
  startsAt: Date | null;
  endsAt: Date | null;
}>;

export type PromotionPricingReason =
  /** The mirrored base price is not usable website money; the variant cannot be purchased. */
  | "BASE_PRICE_UNAVAILABLE"
  /** A single campaign applied but could not produce a valid discount for this variant. */
  | "PROMOTION_INVALID"
  /** More than one campaign applied; campaigns never stack, so none is used. */
  | "PROMOTION_CONFLICT";

export type PromotionPricingInput = Readonly<{
  basePriceVnd: number | null;
  campaigns: readonly ApplicablePromotionCampaign[];
  now: Date;
}>;

export type PromotionPricingResult = Readonly<{
  basePriceVnd: number | null;
  effectivePriceVnd: number | null;
  isDiscounted: boolean;
  promotion: PromotionSnapshot | null;
  reason: PromotionPricingReason | null;
  /** The next instant at which this variant's price could change, for presentation refresh. */
  nextTransitionAt: Date | null;
}>;

const MIN_PERCENTAGE = 1;
const MAX_PERCENTAGE = 99;
const MAX_SAFE_VND = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A website-wide commerce money rule, not only a promotion check.
 *
 * Pancake mirrors prices as `DOUBLE PRECISION`, so null, NaN, infinity, fractional, non-positive
 * and beyond-safe-integer values all reach the application. None of them is authoritative money,
 * and a variant carrying one cannot complete a website purchase.
 */
export function isUsableBasePriceVnd(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

export function isActiveAt(campaign: ApplicablePromotionCampaign, now: Date): boolean {
  const startedAt = campaign.startsAt;
  const endsAt = campaign.endsAt;
  // Half-open [startsAt, endsAt): start inclusive, end exclusive, so B may start exactly when A
  // ends without the two ever reading as overlapping.
  if (startedAt !== null && now.getTime() < startedAt.getTime()) return false;
  if (endsAt !== null && now.getTime() >= endsAt.getTime()) return false;
  return true;
}

/**
 * The earliest boundary strictly after `now` among all candidates: the end of whatever is running,
 * or the start of whatever is scheduled next.
 */
function findNextTransition(
  campaigns: readonly ApplicablePromotionCampaign[],
  now: Date,
): Date | null {
  let earliest: Date | null = null;

  for (const campaign of campaigns) {
    for (const boundary of [campaign.startsAt, campaign.endsAt]) {
      if (boundary === null) continue;
      if (boundary.getTime() <= now.getTime()) continue;
      if (earliest === null || boundary.getTime() < earliest.getTime()) earliest = boundary;
    }
  }

  return earliest;
}

function toSnapshot(campaign: ApplicablePromotionCampaign): PromotionSnapshot {
  return Object.freeze({
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    discountType: campaign.discountType,
    percentageValue: campaign.percentageValue,
    fixedPriceVnd: campaign.fixedPriceVnd,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
  });
}

/**
 * Exact positive-integer rational arithmetic, rounded half up.
 *
 * `Math.round(base * (100 - percent) / 100)` is not normative over the full safe-integer domain:
 * the intermediate product exceeds 2^53 for large bases and the result drifts. `BigInt` keeps every
 * step exact, and the value only returns to `number` once it is known to be a safe integer.
 */
function applyPercentage(basePriceVnd: number, percentageValue: number): number | null {
  if (!Number.isSafeInteger(percentageValue)) return null;
  if (percentageValue < MIN_PERCENTAGE || percentageValue > MAX_PERCENTAGE) return null;

  const numerator = BigInt(basePriceVnd) * BigInt(100 - percentageValue);
  const effective = (numerator + BigInt(50)) / BigInt(100);

  return effective > MAX_SAFE_VND ? null : Number(effective);
}

function applyFixedPrice(fixedPriceVnd: bigint | null): number | null {
  if (fixedPriceVnd === null) return null;
  if (fixedPriceVnd <= BigInt(0) || fixedPriceVnd > MAX_SAFE_VND) return null;

  return Number(fixedPriceVnd);
}

export function resolvePromotionPricing({
  basePriceVnd,
  campaigns,
  now,
}: PromotionPricingInput): PromotionPricingResult {
  if (!isUsableBasePriceVnd(basePriceVnd)) {
    return Object.freeze({
      basePriceVnd: null,
      effectivePriceVnd: null,
      isDiscounted: false,
      promotion: null,
      reason: "BASE_PRICE_UNAVAILABLE" as const,
      nextTransitionAt: null,
    });
  }

  const nextTransitionAt = findNextTransition(campaigns, now);
  const undiscounted = (reason: PromotionPricingReason | null): PromotionPricingResult =>
    Object.freeze({
      basePriceVnd,
      effectivePriceVnd: basePriceVnd,
      isDiscounted: false,
      promotion: null,
      reason,
      nextTransitionAt,
    });

  const active = campaigns.filter((campaign) => isActiveAt(campaign, now));
  if (active.length === 0) return undiscounted(null);
  // Campaigns never stack. Two applicable candidates leave no rule for deciding between them, so
  // the variant simply gets no website promotion rather than an arbitrary one.
  if (active.length > 1) return undiscounted("PROMOTION_CONFLICT");

  const campaign = active[0]!;
  const effectivePriceVnd = campaign.discountType === "PERCENTAGE"
    ? applyPercentage(basePriceVnd, campaign.percentageValue ?? Number.NaN)
    : applyFixedPrice(campaign.fixedPriceVnd);

  // `0 < effective < base` is the definition of a discount here. Low-price rounding that lands back
  // on the base, and a configured fixed price that is not actually cheaper, both invalidate this
  // variant only — the campaign stays valid for the variants where it does discount.
  if (
    effectivePriceVnd === null
    || !Number.isSafeInteger(effectivePriceVnd)
    || effectivePriceVnd <= 0
    || effectivePriceVnd >= basePriceVnd
  ) {
    return undiscounted("PROMOTION_INVALID");
  }

  return Object.freeze({
    basePriceVnd,
    effectivePriceVnd,
    isDiscounted: true,
    promotion: toSnapshot(campaign),
    reason: null,
    nextTransitionAt,
  });
}
