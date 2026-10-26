import type { PrismaClient } from "../generated/prisma/client.ts";

import { canProjectExactMoney } from "./pancake-voucher-projection.ts";
import { createVoucherHoldRateLimiter, type VoucherCodeRateLimiter } from "./voucher-code-rate-limit.ts";
import { canIssueNewVouchers, readVoucherVerifiedShopIds } from "./voucher-gate.ts";
import { createVoucherHoldService, type VoucherGroup, type VoucherHoldFailureReason, type VoucherHoldGrant } from "./voucher-hold-service.ts";
import { readVoucherPreview } from "./voucher-preview.ts";
import { issueVoucherQuoteProof, voucherProofFactsFromQuote, voucherQuoteDigest, type VoucherProofFacts, type VoucherProofLine } from "./voucher-quote-proof.ts";
import { applyAllocationToLines } from "./voucher-quote.ts";

/**
 * Voucher v1 (V12): the one intentional POST that turns a voucher PREVIEW into a held, submit-capable quote.
 *
 * Order, every step fail-closed (ADR 0019 D-1, D-4, D-6, spec §4.1, TG-02, TG-12):
 *
 *  1. both gates (feature + verified POS shop) -- otherwise "preview only", nothing is read or written;
 *  2. recompute the quote from the cart (`readVoucherPreview`, read-only, repeatable-read);
 *  3. the buyer must have seen THIS total (`expectedTotalVnd`): a different one is `TOTAL_CHANGED`, never a hold;
 *  4. `canProjectExactMoney` on the exact vendor lines BEFORE any hold, budget or proof: money the POS cannot
 *     take to the VND is `POS_INFEASIBLE` and nothing exists afterwards (AC-20);
 *  5. the atomic hold (`voucher-hold-service`), all groups or none; a cart whose paid lines moved is `CART_CHANGED`;
 *  6. only then the HELD `lav1` proof, over the holds that now exist.
 *
 * Gifts: the proof binds the NUMBER of retained gift slots (a changed gift count is a different quote); which gift
 * variation the buyer picked stays with the gift selection and the checkout proof, as before.
 *
 * Nothing here is reachable from a GET, a prefetch or a render; the only caller is a Server Action.
 */

export type VoucherHoldFlowFailure =
  | "PREVIEW_ONLY"
  | "RATE_LIMITED"
  | "CART_UNAVAILABLE"
  | "QUOTE_UNAVAILABLE"
  | "NO_VOUCHER_QUOTE"
  | "TOTAL_CHANGED"
  | "POS_INFEASIBLE"
  | "PROOF_UNAVAILABLE"
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
  | Readonly<{ ok: false; reason: VoucherHoldFlowFailure; /** The total the server computes now, when that is what changed. */ currentTotalVnd?: number }>;

const GIFT_SLOTS_VARIATION = "gift-slots";
const stripSegment = (lineId: string) => lineId.replace(/\|v\d+$/, "");

export function createVoucherHoldFlow(client: PrismaClient, options: Readonly<{
  shopId: number;
  attemptSecret: string;
  proofSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam only: the production reader is `readVoucherPreview`. */
  readPreview?: typeof readVoucherPreview;
  rateLimiter?: VoucherCodeRateLimiter;
}>) {
  const limiter = options.rateLimiter ?? createVoucherHoldRateLimiter(client);
  const env = options.env ?? process.env;
  const readPreview = options.readPreview ?? readVoucherPreview;
  const holds = createVoucherHoldService(client, { attemptSecret: options.attemptSecret, env });

  async function hold(input: Readonly<{ cartId: string; expectedTotalVnd: number; now?: Date }>): Promise<VoucherHoldFlowResult> {
    const { cartId, expectedTotalVnd } = input;
    const now = input.now ?? new Date();
    if (!Number.isSafeInteger(expectedTotalVnd) || expectedTotalVnd < 1 || typeof cartId !== "string" || cartId.length === 0) return { ok: false, reason: "CART_UNAVAILABLE" };
    // 1. Both gates, before anything is read.
    if (!canIssueNewVouchers(env) || !readVoucherVerifiedShopIds(env).includes(options.shopId)) return { ok: false, reason: "PREVIEW_ONLY" };

    // Anti-flood (ADR 0019 D-5): counted on every attempt, before any cart or catalog read.
    if (!(await limiter.consume({ cartId, shopId: options.shopId, now }))) return { ok: false, reason: "RATE_LIMITED" };

    // 2. The quote, recomputed by the server.
    const preview = await readPreview({ client, cartId, shopId: options.shopId, now, env });
    if (!preview.enabled) return { ok: false, reason: "PREVIEW_ONLY" };
    if (!preview.ok) return { ok: false, reason: preview.reason };
    const { quote, campaigns, paidRevision, variationOfLine } = preview;

    // Nothing chosen: release whatever this attempt still holds and say so. (No expected-total test: no hold is made.)
    if (quote.voucherCount === 0) {
      const released = await holds.hold({ shopId: options.shopId, cartId, paidRevision: Number(paidRevision), quoteDigest: "0".repeat(64), grants: [], releaseKinds: ["MERCHANDISE", "SHIPPING_FREE"] });
      if (!released.ok) return { ok: false, reason: released.reason };
      return { ok: true, state: "NONE", totalPayableVnd: quote.totalPayableVnd, released: released.released };
    }

    // 3. The buyer agreed to this total, not to another one.
    if (quote.totalPayableVnd !== expectedTotalVnd) return { ok: false, reason: "TOTAL_CHANGED", currentTotalVnd: quote.totalPayableVnd };
    if (paidRevision > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "QUOTE_UNAVAILABLE" };

    // 4. Exact money, before any hold.
    const afterVoucher = applyAllocationToLines(preview.lines, quote.allocation);
    const paidLines = afterVoucher.map((line) => ({
      lineId: line.lineId,
      pancakeVariationId: variationOfLine.get(stripSegment(line.lineId)) ?? "",
      quantity: line.quantity,
      unitPriceVnd: line.unitPriceVnd,
    }));
    if (paidLines.some((line) => line.pancakeVariationId === "")) return { ok: false, reason: "QUOTE_UNAVAILABLE" };
    const giftSlots = quote.gifts.retainedSelectedSlots;
    const projection = canProjectExactMoney({
      paidLines,
      gifts: giftSlots > 0 ? [{ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: giftSlots }] : [],
      expectedPaidSubtotalVnd: quote.paidAfterVnd,
      shippingFeeVnd: quote.shippingFeeVnd,
      expectedTotalVnd: quote.totalPayableVnd,
    });
    if (!projection.ok) return { ok: false, reason: "POS_INFEASIBLE" };

    // The quote's own facts: this digest is what every hold stores and what a submit recomputes.
    const proofLines: VoucherProofLine[] = paidLines.map((line) => ({ pancakeVariationId: line.pancakeVariationId, quantity: line.quantity, unitPriceVnd: line.unitPriceVnd, role: "PAID" }));
    if (giftSlots > 0) proofLines.push({ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: giftSlots, unitPriceVnd: 0, role: "GIFT" });
    let previewFacts: VoucherProofFacts;
    try {
      previewFacts = voucherProofFactsFromQuote({ quote, campaigns, paidRevision, lines: proofLines });
    } catch {
      return { ok: false, reason: "QUOTE_UNAVAILABLE" };
    }
    const quoteDigest = voucherQuoteDigest(previewFacts);

    // 5. The atomic hold of the chosen vouchers; groups without a voucher are released.
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
    const granted = await holds.hold({ shopId: options.shopId, cartId, paidRevision: Number(paidRevision), quoteDigest, grants, releaseKinds });
    if (!granted.ok) return { ok: false, reason: granted.reason };

    // 6. The HELD proof, over the holds that now exist.
    const byKind = new Map(granted.holds.map((held) => [held.kind, { holdId: held.holdId, expiresAtMs: held.expiresAt.getTime() }]));
    const proof = issueVoucherQuoteProof({
      facts: voucherProofFactsFromQuote({
        quote,
        campaigns,
        paidRevision,
        lines: proofLines,
        holds: { ...(byKind.has("MERCHANDISE") ? { merchandise: byKind.get("MERCHANDISE")! } : {}), ...(byKind.has("SHIPPING_FREE") ? { shipping: byKind.get("SHIPPING_FREE")! } : {}) },
      }),
      cartId,
      secret: options.proofSecret,
    });
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
