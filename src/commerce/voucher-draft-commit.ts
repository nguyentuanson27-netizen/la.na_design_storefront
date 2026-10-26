import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { giftsAfterVoucher } from "./voucher-checkout-quote.ts";
import { applyGiftEntitlementsToSelections, countingKeys } from "./voucher-gift-repair.ts";
import { createVoucherHoldService } from "./voucher-hold-service.ts";
import type { VoucherSelectionIntent } from "./voucher-optimizer.ts";
import { readVoucherPreviewWithin } from "./voucher-preview.ts";
import {
  createVoucherSelectionService,
  selectionIntentFromRow,
  type VoucherCodeResult,
  type VoucherGroup,
  type VoucherGroupDraft,
  type VoucherSelectionResult,
} from "./voucher-selection-service.ts";

/**
 * Voucher v1 (AC-35 / AC-29, spec 4.1.4 / 4.1.7 / 7.3): every public way to SAVE a voucher choice -- the picker's "Áp dụng", the
 * single-group action and a typed code -- passes the same gate, inside the selection transaction, under the cart lock, before
 * anything is written:
 *
 *  - a consent the shopper gave is always held against the quote the server derives NOW (a stale digest is `QUOTE_CHANGED`,
 *    even when the choice itself needs none);
 *  - a choice that costs a chosen gift, or raises the total against the no-voucher cart (EX-06), needs that consent
 *    (`CONFIRMATION_REQUIRED`, nothing written);
 *  - with the consent for the current quote, the voucher intent AND the gift change are written together: the choices the
 *    voucher makes unearned are removed or reduced in the same transaction.
 * The consent is a digest and a yes, never a price or a list of gifts. The shopper's own live holds are read INSIDE the
 * transaction after the lock: a snapshot taken before it could credit a hold that has since been released or has expired.
 */

const intentOf = (draft: VoucherGroupDraft) => (draft.mode === "AUTO" ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: draft.voucherId } as const));

type Refusal = Readonly<{ reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" }>;
type GiftRepair = Readonly<{ entitlements: readonly { campaignId: string; entitled: number }[]; counting: ReadonlySet<string> }>;

/** The gate, run in `tx` with the cart row already locked. `repair` is what to apply after the choice is saved. */
async function consentGate(tx: Prisma.TransactionClient, input: Readonly<{
  cartId: string;
  shopId: number;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  attemptSecret: string;
  override: VoucherSelectionIntent;
  consentDigest: string | null;
  /** The one PRIVATE campaign a code just verified, so it can be previewed before it is saved. */
  verifiedPrivateIds?: readonly string[];
}>): Promise<Readonly<{ refusal: Refusal | null; repair: GiftRepair | null }>> {
  const { cartId, shopId, env, now, consentDigest } = input;
  const ownHolds = await createVoucherHoldService(tx as never, { attemptSecret: input.attemptSecret, env }).readOwnLiveHoldsIn(tx as never, cartId);
  const preview = await readVoucherPreviewWithin(tx, { cartId, shopId, now, env, ownHolds, selectionOverride: input.override, verifiedPrivateIds: input.verifiedPrivateIds });
  // A preview that cannot be derived keeps the old behaviour: the intent is saved and the hold flow judges it.
  if (!preview.enabled || !preview.ok) return { refusal: null, repair: null };
  if (consentDigest !== null && preview.quoteDigest !== consentDigest) return { refusal: { reason: "QUOTE_CHANGED" }, repair: null };
  const giftLost = (preview.quote.giftLoss?.selectedSlotsLost ?? 0) > 0;
  // What costs the shopper something needs their explicit yes BEFORE it is saved: a chosen gift lost, or a total that rises
  // against the no-voucher cart (a lost campaign free-ship, a higher fee: EX-06).
  if (!giftLost && preview.quote.confirmation === null) return { refusal: null, repair: null };
  if (consentDigest === null) return { refusal: { reason: "CONFIRMATION_REQUIRED" }, repair: null };
  if (!giftLost) return { refusal: null, repair: null };
  const gifts = giftsAfterVoucher(preview);
  if (gifts === null || preview.giftState === null) return { refusal: { reason: "QUOTE_CHANGED" }, repair: null };
  return { refusal: null, repair: { entitlements: gifts.entitlements, counting: countingKeys(preview.giftState.selections) } };
}

export async function commitVoucherDraft(input: Readonly<{
  client: PrismaClient;
  cartId: string;
  shopId: number;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  draft: Readonly<{ merchandise: VoucherGroupDraft; shipping: VoucherGroupDraft }>;
  /** The digest of the quote the shopper explicitly confirmed, or null when they confirmed nothing. */
  consentDigest: string | null;
  attemptSecret: string;
}>): Promise<VoucherSelectionResult> {
  const { client, cartId, shopId, draft, consentDigest, attemptSecret } = input;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  let repair: GiftRepair | null = null;

  return createVoucherSelectionService(client, { shopId, env }).applyBoth({
    cartId,
    ...draft,
    now,
    async beforeSave(tx) {
      const gate = await consentGate(tx, {
        cartId, shopId, env, now, attemptSecret, consentDigest,
        override: { merchandise: intentOf(draft.merchandise), shipping: intentOf(draft.shipping) },
      });
      if (gate.refusal !== null) return { ok: false, reason: gate.refusal.reason } as const;
      repair = gate.repair;
      return null;
    },
    async afterSave(tx) {
      if (repair !== null) await applyGiftEntitlementsToSelections(tx, cartId, repair.entitlements, repair.counting);
    },
  });
}

/**
 * A typed or linked code. The code is verified and rate-counted as always; whether the choice it makes is SAVED goes through the
 * same gate as a draft, with the other group left as it is saved. A refusal reports which verified campaign is waiting, so the
 * picker can show what the server derives for it and ask again with the digest it showed.
 */
export async function applyVoucherCode(input: Readonly<{
  client: PrismaClient;
  cartId: string;
  shopId: number;
  rawCode: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  consentDigest: string | null;
  attemptSecret: string;
}>): Promise<VoucherCodeResult> {
  const { client, cartId, shopId, rawCode, consentDigest, attemptSecret } = input;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  let repair: GiftRepair | null = null;

  return createVoucherSelectionService(client, { shopId, env }).applyCode({
    cartId,
    rawCode,
    now,
    async beforeSave(tx, verified) {
      const saved = selectionIntentFromRow(await tx.cartVoucherSelection.findUnique({ where: { cartId } }), now);
      const chosen = { mode: "MANUAL", voucherId: verified.campaignId } as const;
      const override: VoucherSelectionIntent = verified.group === "MERCHANDISE" ? { merchandise: chosen, shipping: saved.shipping } : { merchandise: saved.merchandise, shipping: chosen };
      const gate = await consentGate(tx, { cartId, shopId, env, now, attemptSecret, consentDigest, override, verifiedPrivateIds: [verified.campaignId] });
      if (gate.refusal !== null) return gate.refusal;
      repair = gate.repair;
      return null;
    },
    async afterSave(tx) {
      if (repair !== null) await applyGiftEntitlementsToSelections(tx, cartId, repair.entitlements, repair.counting);
    },
  });
}

export type { VoucherGroup };
