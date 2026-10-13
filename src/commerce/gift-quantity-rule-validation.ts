import type {
  GiftAwardMode,
  GiftQuantityCampaignKind,
  GiftSubtotalScope,
  GiftTrigger,
  QuantityTierDiscountedUnits,
  QuantityTierDiscountUnit,
  QuantityTierSelectionPriority,
} from "../generated/prisma/client.ts";

/**
 * Publish-time validation of a gift / quantity-tier rule (GQ04 seam).
 *
 * The lifecycle service (`gift-quantity-activation-service.ts`) owns *when* validation runs and
 * what a failure does; this module owns *what* a valid rule is. The rule-specific validators arrive
 * with the Admin write contracts (GQ09a tiers, GQ13a gifts). Until they do, the default refuses
 * every publish with `RULE_VALIDATION_NOT_AVAILABLE`, so a campaign whose rule nobody can yet
 * validate can never become effective. That is deliberate fail-closed behaviour, not a TODO.
 */

export type RuleValidationInput = Readonly<{
  kind: GiftQuantityCampaignKind;
  giftTrigger: GiftTrigger | null;
  minimumQuantity: number | null;
  minimumSubtotalVnd: bigint | null;
  subtotalScope: GiftSubtotalScope | null;
  awardMode: GiftAwardMode | null;
  maxGiftsPerOrder: number | null;
  allowDuplicateGifts: boolean | null;
  tierUnit: QuantityTierDiscountUnit | null;
  tierDiscountedUnits: QuantityTierDiscountedUnits | null;
  tierSelectionPriority: QuantityTierSelectionPriority | null;
  tiers: readonly Readonly<{ minQuantity: number; discountValue: number }>[];
  giftVariantIds: readonly string[];
}>;

/** Stable machine-readable codes; an empty list means the rule is valid. */
export type RuleValidator = (input: RuleValidationInput) => readonly string[];

export const RULE_VALIDATION_NOT_AVAILABLE = "RULE_VALIDATION_NOT_AVAILABLE";

export const refuseUnvalidatedRules: RuleValidator = () => [RULE_VALIDATION_NOT_AVAILABLE];

/** The validator the production lifecycle service uses. Replaced by GQ09a/GQ13a. */
export const validateRuleForPublish: RuleValidator = refuseUnvalidatedRules;
