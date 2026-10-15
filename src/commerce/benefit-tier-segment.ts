/**
 * Whether a cart's paid groups carry a quantity-tier discount step.
 *
 * One definition for the two places that must agree: the checkout resolver (which decides a cart is a
 * *benefit cart*, and so is quoted in the benefit format and needs the shop's line-level POS evidence)
 * and the cart page (which decides whether to offer the checkout link). It is the tier-step ledger, not
 * the money: a legitimate stack can apply a tier and then a legacy ceiling and land on exactly the amount
 * the legacy resolver would charge, and the cart must still be treated as a benefit cart.
 *
 * Pure and dependency-free so the client-side cart model can import it.
 */
export function hasQuantityTierSegment(
  groups: readonly Readonly<{ steps: readonly Readonly<{ source: string }>[] }>[],
): boolean {
  return groups.some((group) => group.steps.some((step) => step.source === "QUANTITY_TIER"));
}
