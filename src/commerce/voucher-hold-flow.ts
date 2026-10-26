import type { PrismaClient } from "../generated/prisma/client.ts";

import { canProjectExactMoney } from "./pancake-voucher-projection.ts";
import { createVoucherHoldRateLimiter, type VoucherCodeRateLimiter } from "./voucher-code-rate-limit.ts";
import { canIssueNewVouchers, readVoucherVerifiedShopIds } from "./voucher-gate.ts";
import { createVoucherHoldService, type HeldVoucher, type VoucherGroup, type VoucherHoldFailureReason, type VoucherHoldGrant } from "./voucher-hold-service.ts";
import { readVoucherPreview } from "./voucher-preview.ts";
import { buildVoucherQuoteFacts, GIFT_SLOTS_VARIATION } from "./voucher-quote-facts.ts";
import { issueVoucherQuoteProof, voucherProofFactsFromQuote } from "./voucher-quote-proof.ts";

/**
 * Voucher v1 (V12): the one intentional POST that turns a voucher PREVIEW into a held, submit-capable quote.
 *
 * Order, every step fail-closed (ADR 0019 D-1, D-4, D-6, spec §4.1, TG-02, TG-12):
 *
 *  1. both gates (feature + verified POS shop) and the throttle -- otherwise nothing is read or written;
 *  2. read the buyer's OWN live holds, then recompute the quote from the cart (`readVoucherPreview`, read-only,
 *     repeatable-read) with those holds kept in play: a retry never loses what the buyer already holds because the
 *     campaign has since filled up, ended or been switched off (TG-05 A, AC-31, AC-33);
 *  3. the buyer must have seen THIS quote: `expectedQuoteDigest` is the digest of the exact vouchers, revisions,
 *     line prices, gift slots, shipping and total. Equal totals of two different quotes are not consent. A quote
 *     that costs the buyer a gift or raises the total needs an explicit `acknowledged` (AC-34);
 *  4. `canProjectExactMoney` on the exact vendor lines BEFORE any hold, budget or proof (AC-20);
 *  5. the atomic hold (`voucher-hold-service`), all groups or none, and -- still inside that transaction -- the HELD
 *     `lav1` proof. If the proof cannot be issued the whole call rolls back: quota is never held without a proof to
 *     spend it, and a swap keeps its old hold.
 *
 * Gifts: the proof binds the NUMBER of retained gift slots; which gift variation the buyer picked stays with the
 * gift selection and the checkout proof (V13 must keep the two consistent).
 *
 * Nothing here is reachable from a GET, a prefetch or a render; the only caller is a Server Action.
 */

export type VoucherHoldFlowFailure =
  | "PREVIEW_ONLY"
  | "RATE_LIMITED"
  | "CART_UNAVAILABLE"
  | "QUOTE_UNAVAILABLE"
  | "NO_VOUCHER_QUOTE"
  /** The quote the server computes now is not the one the buyer saw. */
  | "QUOTE_CHANGED"
  /** Same quote, but it costs a gift or raises the total and the buyer has not acknowledged that. */
  | "CONFIRMATION_REQUIRED"
  | "POS_INFEASIBLE"
  | VoucherHoldFailureReason;

export type VoucherHoldFlowResult =
  | Readonly<{ ok: true; state: "NONE"; totalPayableVnd: number; released: readonly VoucherGroup[] }>
  | Readonly<{
      ok: true;
      state: "HELD";
      proof: string;
      /** The EARLIEST hold expiry: the quote is submit-capable strictly before this instant, never extended. */
      expiresAtMs: number;
      totalPayableVnd: number;
      holds: readonly Readonly<{ kind: VoucherGroup; holdId: string; campaignId: string; amountVnd: number; expiresAtMs: number; reused: boolean }>[];
    }>
  | Readonly<{
      ok: false;
      reason: VoucherHoldFlowFailure;
      /** The total the server computes now, when the quote changed. */
      currentTotalVnd?: number;
      /** The digest of the quote the server computes now, so the UI can re-show it and ask again. */
      currentQuoteDigest?: string;
      /** What the buyer must acknowledge. */
      confirmation?: Readonly<{ giftSlotsLost: number; totalIncreaseVnd: number; shippingFeeIncreaseVnd: number }>;
    }>;

const HEX64 = /^[0-9a-f]{64}$/;

export function createVoucherHoldFlow(client: PrismaClient, options: Readonly<{
  shopId: number;
  attemptSecret: string;
  proofSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seams only: the production readers/issuers are `readVoucherPreview` and `issueVoucherQuoteProof`. */
  readPreview?: typeof readVoucherPreview;
  issueProof?: typeof issueVoucherQuoteProof;
  rateLimiter?: VoucherCodeRateLimiter;
}>) {
  const env = options.env ?? process.env;
  const readPreview = options.readPreview ?? readVoucherPreview;
  const issueProof = options.issueProof ?? issueVoucherQuoteProof;
  const limiter = options.rateLimiter ?? createVoucherHoldRateLimiter(client);
  const holds = createVoucherHoldService(client, { attemptSecret: options.attemptSecret, env });

  async function hold(input: Readonly<{ cartId: string; expectedQuoteDigest: string; acknowledged?: boolean; now?: Date }>): Promise<VoucherHoldFlowResult> {
    const { cartId, expectedQuoteDigest } = input;
    const now = input.now ?? new Date();
    if (typeof expectedQuoteDigest !== "string" || !HEX64.test(expectedQuoteDigest) || typeof cartId !== "string" || cartId.length === 0) return { ok: false, reason: "CART_UNAVAILABLE" };
    // 1. Both gates, before anything is read.
    if (!canIssueNewVouchers(env) || !readVoucherVerifiedShopIds(env).includes(options.shopId)) return { ok: false, reason: "PREVIEW_ONLY" };
    // Anti-flood (ADR 0019 D-5): counted on every attempt, before any cart or catalog read.
    if (!(await limiter.consume({ cartId, shopId: options.shopId, now }))) return { ok: false, reason: "RATE_LIMITED" };

    // 2. The buyer's own live holds stay in play; then the quote, recomputed by the server.
    const ownHolds = await holds.readOwnLiveHolds(cartId);
    const preview = await readPreview({ client, cartId, shopId: options.shopId, now, env, ownHolds });
    if (!preview.enabled) return { ok: false, reason: "PREVIEW_ONLY" };
    if (!preview.ok) return { ok: false, reason: preview.reason };
    const { quote, campaigns, paidRevision } = preview;
    if (paidRevision > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "QUOTE_UNAVAILABLE" };

    // Nothing chosen: release whatever this attempt still holds and say so. (No digest test: no hold is made.)
    if (quote.voucherCount === 0) {
      const released = await holds.hold({ shopId: options.shopId, cartId, paidRevision: Number(paidRevision), quoteDigest: "0".repeat(64), grants: [], releaseKinds: ["MERCHANDISE", "SHIPPING_FREE"] });
      if (!released.ok) return { ok: false, reason: released.reason };
      return { ok: true, state: "NONE", totalPayableVnd: quote.totalPayableVnd, released: released.released };
    }

    const facts = buildVoucherQuoteFacts({ quote, campaigns, lines: preview.lines, variationOfLine: preview.variationOfLine, paidRevision });
    if (facts === null) return { ok: false, reason: "QUOTE_UNAVAILABLE" };

    // 3. The buyer saw THIS quote, and agreed to anything it costs them.
    if (facts.digest !== expectedQuoteDigest) return { ok: false, reason: "QUOTE_CHANGED", currentTotalVnd: quote.totalPayableVnd, currentQuoteDigest: facts.digest };
    if ((quote.giftLoss !== null || quote.confirmation !== null) && input.acknowledged !== true) {
      return {
        ok: false,
        reason: "CONFIRMATION_REQUIRED",
        currentQuoteDigest: facts.digest,
        confirmation: { giftSlotsLost: quote.giftLoss?.selectedSlotsLost ?? 0, totalIncreaseVnd: quote.confirmation?.totalIncreaseVnd ?? 0, shippingFeeIncreaseVnd: quote.confirmation?.shippingFeeIncreaseVnd ?? 0 },
      };
    }

    // 4. Exact money, before any hold.
    const projection = canProjectExactMoney({
      paidLines: facts.paidLines,
      gifts: facts.giftSlots > 0 ? [{ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: facts.giftSlots }] : [],
      expectedPaidSubtotalVnd: quote.paidAfterVnd,
      shippingFeeVnd: quote.shippingFeeVnd,
      expectedTotalVnd: quote.totalPayableVnd,
    });
    if (!projection.ok) return { ok: false, reason: "POS_INFEASIBLE" };

    // 5. The atomic hold of the chosen vouchers (groups without a voucher are released) and, inside the same
    //    transaction, the HELD proof over the holds that now exist.
    const revisionOf = new Map(campaigns.map((campaign) => [campaign.id, campaign.revision]));
    const grants: VoucherHoldGrant[] = [];
    const releaseKinds: VoucherGroup[] = [];
    const chosen: Array<[VoucherGroup, string | null, number]> = [
      ["MERCHANDISE", quote.selection.merchandiseId, quote.merchandiseDiscountVnd],
      ["SHIPPING_FREE", quote.selection.shippingId, quote.shippingDiscountVnd],
    ];
    for (const [kind, campaignId, discountVnd] of chosen) {
      if (campaignId === null) {
        releaseKinds.push(kind);
        continue;
      }
      const campaignRevision = revisionOf.get(campaignId);
      if (campaignRevision === undefined) return { ok: false, reason: "QUOTE_UNAVAILABLE" };
      grants.push({ kind, campaignId, campaignRevision, discountVnd });
    }
    let proof: string | null = null;
    const finalize = (granted: readonly HeldVoucher[]): VoucherHoldFailureReason | null => {
      const byKind = new Map(granted.map((held) => [held.kind, { holdId: held.holdId, expiresAtMs: held.expiresAt.getTime() }]));
      const merchandise = byKind.get("MERCHANDISE");
      const shipping = byKind.get("SHIPPING_FREE");
      try {
        proof = issueProof({
          facts: voucherProofFactsFromQuote({ quote, campaigns, paidRevision, lines: facts.proofLines, holds: { ...(merchandise ? { merchandise } : {}), ...(shipping ? { shipping } : {}) } }),
          cartId,
          secret: options.proofSecret,
        });
      } catch {
        proof = null;
      }
      return proof === null ? "PROOF_UNAVAILABLE" : null;
    };
    const granted = await holds.hold({ shopId: options.shopId, cartId, paidRevision: Number(paidRevision), quoteDigest: facts.digest, grants, releaseKinds }, finalize);
    if (!granted.ok) return { ok: false, reason: granted.reason };
    if (proof === null) return { ok: false, reason: "PROOF_UNAVAILABLE" };
    return {
      ok: true,
      state: "HELD",
      proof,
      expiresAtMs: Math.min(...granted.holds.map((held) => held.expiresAt.getTime())),
      totalPayableVnd: quote.totalPayableVnd,
      holds: granted.holds.map((held) => ({ kind: held.kind, holdId: held.holdId, campaignId: held.campaignId, amountVnd: held.heldDiscountVnd, expiresAtMs: held.expiresAt.getTime(), reused: held.reused })),
    };
  }

  return { hold };
}

export type VoucherHoldFlow = ReturnType<typeof createVoucherHoldFlow>;
