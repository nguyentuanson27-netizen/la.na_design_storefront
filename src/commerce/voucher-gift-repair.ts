import type { Prisma } from "../generated/prisma/client.ts";

import { readCartGiftState } from "./cart-gift-selection.ts";
import { resolveHeldVoucherCheckout } from "./voucher-checkout-quote.ts";

/**
 * Voucher v1 (AC-35, spec 4.1.4 / 7.3): the buyer was told that a voucher costs them a gift and explicitly agreed. This is
 * the moment their stored gift choice follows: the choices a campaign can no longer support after the voucher are removed
 * or reduced, in the SAME transaction that holds the voucher, so the checkout that follows is consistent and a refusal
 * anywhere rolls the voucher and the gift change back together.
 *
 * It repairs only what the voucher changed: choices that exceed the entitlement the cart has AFTER the voucher (a campaign
 * the voucher took the cart below, or fewer slots than were chosen). Anything else that is wrong with a choice (stock, a
 * changed campaign) is left exactly as it was and still reported by the existing contract, never silently fixed here.
 * Nothing is repaired without consent: the flow calls this only for an acknowledged hold, and a preview never does.
 */

export type VoucherGiftRepair = Readonly<{ removed: number; reduced: number }>;

export type VoucherGiftRepairResult =
  | Readonly<{ ok: true; repair: VoucherGiftRepair }>
  | Readonly<{ ok: false; reason: "QUOTE_CHANGED" }>;

export async function repairGiftSelectionsAfterVoucherConsent(input: Readonly<{
  tx: Prisma.TransactionClient;
  cartId: string;
  shopId: number;
  now: Date;
  env: Readonly<Record<string, string | undefined>>;
  attemptSecret: string;
}>): Promise<VoucherGiftRepairResult> {
  const { tx, cartId, shopId, now, env, attemptSecret } = input;
  const giftState = await readCartGiftState(tx, cartId, shopId, now, env);
  // The holds exist in this transaction already; the very derivation checkout will run says what the gifts are after them.
  const held = await resolveHeldVoucherCheckout({ tx, cartId, shopId, now, env, attemptSecret, giftState });
  if (held.kind !== "APPLIED") return { ok: false, reason: "QUOTE_CHANGED" };

  const entitledBy = new Map(held.gift.entitlements.map((entry) => [entry.campaignId, entry.entitled]));
  // Only the choices that count for this cart (a lower milestone waiting behind a higher one is not touched).
  const counting = new Set(giftState.selections.map((row) => `${row.campaignId}/${row.variantId}`));
  const rows = (await tx.cartGiftSelection.findMany({
    where: { cartId },
    // Newest choice first: when slots must go, the older, more settled choices stay.
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, campaignId: true, variantId: true, quantity: true },
  })).filter((row) => counting.has(`${row.campaignId}/${row.variantId}`));

  const totalByCampaign = new Map<string, number>();
  for (const row of rows) totalByCampaign.set(row.campaignId, (totalByCampaign.get(row.campaignId) ?? 0) + row.quantity);

  let removed = 0;
  let reduced = 0;
  for (const [campaignId, total] of totalByCampaign) {
    let excess = total - (entitledBy.get(campaignId) ?? 0);
    if (excess <= 0) continue;
    for (const row of rows.filter((candidate) => candidate.campaignId === campaignId)) {
      if (excess <= 0) break;
      if (row.quantity <= excess) {
        await tx.cartGiftSelection.delete({ where: { id: row.id } });
        excess -= row.quantity;
        removed += 1;
      } else {
        await tx.cartGiftSelection.update({ where: { id: row.id }, data: { quantity: row.quantity - excess } });
        excess = 0;
        reduced += 1;
      }
    }
  }
  return { ok: true, repair: { removed, reduced } };
}
