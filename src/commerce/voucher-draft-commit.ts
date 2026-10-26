import type { PrismaClient } from "../generated/prisma/client.ts";

import { giftsAfterVoucher } from "./voucher-checkout-quote.ts";
import { applyGiftEntitlementsToSelections, countingKeys } from "./voucher-gift-repair.ts";
import type { VoucherSelectionIntent } from "./voucher-optimizer.ts";
import { readVoucherPreviewWithin, type OwnVoucherHold } from "./voucher-preview.ts";
import { createVoucherSelectionService, type VoucherGroupDraft, type VoucherSelectionResult } from "./voucher-selection-service.ts";

/**
 * Voucher v1 (AC-35, spec 4.1.4 / 7.3): the picker's "Áp dụng" for a draft that may cost the shopper gifts they chose.
 *
 *  - no gift is lost: the draft is saved exactly as before;
 *  - gifts are lost and there is no explicit consent: refused (`CONFIRMATION_REQUIRED`), nothing written;
 *  - consent for a quote that is no longer the server's quote under the cart lock: refused (`QUOTE_CHANGED`), nothing written;
 *  - consent for the current quote: the voucher intent AND the gift change are written in ONE transaction -- the choices the
 *    voucher makes unearned are removed or reduced, so the cart the shopper sees afterwards is consistent.
 * The consent is a digest and a yes; what is lost is always recomputed here, never taken from the browser.
 */

const intentOf = (draft: VoucherGroupDraft) => (draft.mode === "AUTO" ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: draft.voucherId } as const));

export async function commitVoucherDraft(input: Readonly<{
  client: PrismaClient;
  cartId: string;
  shopId: number;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  draft: Readonly<{ merchandise: VoucherGroupDraft; shipping: VoucherGroupDraft }>;
  /** The digest of the quote the shopper explicitly confirmed, or null when they confirmed nothing. */
  consentDigest: string | null;
  ownHolds: readonly OwnVoucherHold[];
}>): Promise<VoucherSelectionResult> {
  const { client, cartId, shopId, draft, consentDigest, ownHolds } = input;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  let repair: { entitlements: readonly { campaignId: string; entitled: number }[]; counting: ReadonlySet<string> } | null = null;

  return createVoucherSelectionService(client, { shopId, env }).applyBoth({
    cartId,
    ...draft,
    now,
    async beforeSave(tx) {
      const selectionOverride: VoucherSelectionIntent = { merchandise: intentOf(draft.merchandise), shipping: intentOf(draft.shipping) };
      const preview = await readVoucherPreviewWithin(tx, { cartId, shopId, now, env, ownHolds, selectionOverride });
      // A preview that cannot be derived keeps the old behaviour: the intent is saved and the hold flow judges it.
      if (!preview.enabled || !preview.ok) return null;
      // A consent the shopper gave is always held against the quote the server derives now, even if this draft happens to need none.
      if (consentDigest !== null && preview.quoteDigest !== consentDigest) return { ok: false, reason: "QUOTE_CHANGED" } as const;
      const giftLost = (preview.quote.giftLoss?.selectedSlotsLost ?? 0) > 0;
      // What costs the shopper something needs their explicit yes BEFORE it is saved (spec 4.1.7 / 7.3, AC-29 / AC-35): a chosen gift
      // lost, or a total that rises against the no-voucher cart (a lost campaign free-ship, a higher fee: EX-06).
      const needsConsent = giftLost || preview.quote.confirmation !== null;
      if (!needsConsent) return null;
      if (consentDigest === null) return { ok: false, reason: "CONFIRMATION_REQUIRED" } as const;
      if (!giftLost) return null;
      const gifts = giftsAfterVoucher(preview);
      if (gifts === null || preview.giftState === null) return { ok: false, reason: "QUOTE_CHANGED" } as const;
      repair = { entitlements: gifts.entitlements, counting: countingKeys(preview.giftState.selections) };
      return null;
    },
    async afterSave(tx) {
      if (repair !== null) await applyGiftEntitlementsToSelections(tx, cartId, repair.entitlements, repair.counting);
    },
  });
}
