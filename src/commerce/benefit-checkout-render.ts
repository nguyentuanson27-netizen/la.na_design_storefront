/**
 * What the checkout page renders for a cart that has gifts or quantity-tier segments (GQ19).
 *
 * The page and the submit are two halves of one statement -- "the buyer saw exactly this quote" --
 * so the page does not derive anything of its own. It calls the same `resolveBenefitCheckoutQuote`
 * the checkout DRAFT step calls, then signs the resulting facts with the same cart-bound secret. A
 * proof issued here therefore verifies at submit time exactly when the server would still compute
 * the same quote, and fails closed into a refreshed render when anything moved.
 *
 * Three outcomes, mirroring the resolver:
 *  - `LEGACY`      the gate is OFF or nothing applies: the page renders the ordinary quote, untouched.
 *  - `UNAVAILABLE` the benefits cannot be offered right now (cannot price, a stored gift choice no
 *                  longer holds, the POS shop has no line-level pricing evidence, or the proof does
 *                  not fit its envelope). The buyer is sent back to the cart; nothing is guessed.
 *  - `BENEFIT`     the facts to show, the proof that binds them, and whether the buyer still owes an
 *                  explicit non-claim acknowledgement (FR-06).
 */

import { readCartGiftState } from "./cart-gift-selection.ts";
import { isGiftQuantityPromotionsEnabled } from "./gift-quantity-gate.ts";
import { buildCartGiftPickerModel, type CartGiftPickerModel } from "../routes/cart-gift-model.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { resolveBenefitCheckoutQuote } from "./benefit-checkout-quote.ts";
import {
  benefitQuoteDigest,
  benefitQuoteNeedsNonclaimAcknowledgement,
  issueBenefitQuoteProof,
  type BenefitQuoteProofFacts,
} from "./checkout-quote-proof.ts";
import { readLineLevelPricingVerifiedShopIds } from "./pancake-line-level-contract.ts";
import type { StorefrontCartLine } from "./storefront-cart.ts";

type Env = Readonly<Record<string, string | undefined>>;

type GiftDisplay = Readonly<{ giftPicker?: CartGiftPickerModel }>;
export type BenefitCheckoutRender = GiftDisplay & (
  | Readonly<{ kind: "LEGACY" }>
  | Readonly<{ kind: "UNAVAILABLE"; reason: "BENEFITS_UNAVAILABLE" | "GIFT_SELECTION_INVALID" | "POS_NOT_ACCEPTED" | "PROOF_UNAVAILABLE" }>
  | Readonly<{
      kind: "BENEFIT";
      facts: BenefitQuoteProofFacts;
      proof: string;
      /** Identifies this exact quote; the form keys the acknowledgement on it so a new quote starts unchecked. */
      digest: string;
      needsAcknowledgement: boolean;
      giftLabels: ReadonlyMap<string, string>;
      /** Display only: campaign names by id, so the checkout can name each saving line. Optional so a render built without it still shows. */
      campaignNames?: ReadonlyMap<string, string>;
      /** EX-21: a quantity tier whose price became invalid was dropped whole; the buyer is told. */
      tierDropped: boolean;
    }>);

export async function readBenefitCheckoutRender({
  client,
  cartId,
  lines,
  shopId,
  now,
  secret,
  env = process.env,
}: Readonly<{
  client: PrismaClient;
  cartId: string;
  lines: readonly StorefrontCartLine[];
  shopId: number;
  now: Date;
  secret: string;
  env?: Env;
}>): Promise<BenefitCheckoutRender> {
  let giftPicker: CartGiftPickerModel | undefined;
  let resolution: Awaited<ReturnType<typeof resolveBenefitCheckoutQuote>>;
  try {
    resolution = await client.$transaction(async (tx) => {
      const giftState = isGiftQuantityPromotionsEnabled(env) ? await readCartGiftState(tx, cartId, shopId, now, env) : undefined;
      if (giftState) giftPicker = buildCartGiftPickerModel(giftState);
      return resolveBenefitCheckoutQuote({ tx, cartId, shopId, now, env, lines, giftState });
    });
  } catch {
    // A read that failed is not "no benefits": quoting the plain cart here would show a price the
    // submit then refuses. Fail closed instead.
    return { kind: "UNAVAILABLE", reason: "BENEFITS_UNAVAILABLE" };
  }
  if (resolution.kind === "LEGACY") return { kind: "LEGACY", giftPicker };
  if (resolution.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE", reason: "BENEFITS_UNAVAILABLE" };
  if (resolution.kind === "GIFT_SELECTION_INVALID") return { kind: "UNAVAILABLE", reason: "GIFT_SELECTION_INVALID", giftPicker: giftPicker ? { ...giftPicker, invalid: true } : undefined };

  // The POS withholds a benefit order for any shop without line-level pricing evidence (GQ20). Offering
  // a checkout the submit is certain to close would only cost the buyer a form and an order number.
  if (!readLineLevelPricingVerifiedShopIds(env).includes(shopId)) return { kind: "UNAVAILABLE", reason: "POS_NOT_ACCEPTED" };

  const proof = issueBenefitQuoteProof({ quote: resolution.facts, cartId, secret });
  if (proof === null) return { kind: "UNAVAILABLE", reason: "PROOF_UNAVAILABLE" };

  return {
    kind: "BENEFIT",
    giftPicker,
    facts: resolution.facts,
    proof,
    digest: benefitQuoteDigest(resolution.facts),
    needsAcknowledgement: benefitQuoteNeedsNonclaimAcknowledgement(resolution.facts),
    giftLabels: resolution.giftLabels,
    campaignNames: resolution.campaignNames,
    tierDropped: resolution.dropped.some((entry) => entry.reason === "TIER_PRICE_INVALID"),
  };
}
