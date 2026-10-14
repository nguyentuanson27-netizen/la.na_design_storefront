import { giftRuleOfRow, validateGiftRuleForPublish } from "./gift-quantity-gift-rule.ts";
import { validateTierRuleForPublish, type TierRuleInput } from "./gift-quantity-tier-rule.ts";
import type { StackPeer } from "./gift-quantity-stack.ts";
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
 * what a failure does; this module owns *what* a valid rule is. Tier rules are validated by
 * `gift-quantity-tier-rule.ts` (GQ09a) and gift rules by `gift-quantity-gift-rule.ts` (GQ13a). A
 * kind nobody can validate is refused with `RULE_VALIDATION_NOT_AVAILABLE`, so a campaign whose rule
 * nobody can check can never become effective. That is deliberate fail-closed behaviour.
 *
 * Checks that need other rows (unique stack priority, EX-21 catalog prices, peers that exist) are
 * not pure and live in `gift-quantity-publish-guards.ts`, run by the lifecycle service in the same
 * transaction.
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
  stackingEnabled: boolean;
  stackPriority: number | null;
  stackPeers: readonly StackPeer[];
}>;

/** Stable machine-readable codes; an empty list means the rule is valid. */
export type RuleValidator = (input: RuleValidationInput) => readonly string[];

export const RULE_VALIDATION_NOT_AVAILABLE = "RULE_VALIDATION_NOT_AVAILABLE";

export const refuseUnvalidatedRules: RuleValidator = () => [RULE_VALIDATION_NOT_AVAILABLE];

function tierRuleOf(input: RuleValidationInput): TierRuleInput {
  return {
    unit: input.tierUnit,
    discountedUnits: input.tierDiscountedUnits,
    selectionPriority: input.tierSelectionPriority,
    tiers: input.tiers,
    stackingEnabled: input.stackingEnabled,
    stackPriority: input.stackPriority,
    peers: input.stackPeers,
  };
}

function giftRulePublishInputOf(input: RuleValidationInput) {
  return {
    trigger: input.giftTrigger,
    subtotalScope: input.subtotalScope,
    rule: giftRuleOfRow({
      minimumQuantity: input.minimumQuantity,
      minimumSubtotalVnd: input.minimumSubtotalVnd,
      awardMode: input.awardMode,
      maxGiftsPerOrder: input.maxGiftsPerOrder,
      allowDuplicateGifts: input.allowDuplicateGifts,
      giftOptions: input.giftVariantIds.map((variantId) => ({ variantId })),
    }),
  } as const;
}

/**
 * The validator the production lifecycle service uses. Tier rules (GQ09a) and gift rules (GQ13a) are
 * validated here; any other kind refuses, so the dispatch fails closed.
 */
export const validateRuleForPublish: RuleValidator = (input) =>
  input.kind === "QUANTITY_TIER"
    ? validateTierRuleForPublish(tierRuleOf(input))
    : input.kind === "GIFT_ITEM"
      ? validateGiftRuleForPublish(giftRulePublishInputOf(input))
      : refuseUnvalidatedRules(input);
