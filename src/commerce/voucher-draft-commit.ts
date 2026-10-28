import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { giftsAfterVoucher } from "./voucher-checkout-quote.ts";
import { applyGiftEntitlementsToSelections, countingKeys } from "./voucher-gift-repair.ts";
import { createVoucherHoldService } from "./voucher-hold-service.ts";
import type { GroupSelection, VoucherSelectionIntent } from "./voucher-optimizer.ts";
import { readVoucherPreviewWithin } from "./voucher-preview.ts";
import { selectionVersionOf } from "./voucher-selection-version.ts";
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
 * With no quote the server cannot derive, nothing that could change money or gifts is written (`QUOTE_UNAVAILABLE`): a
 * consent digest cannot be checked against a quote that does not exist, so a digest does not open the gate. What is always
 * allowed is a choice that cannot add cost: every group "no voucher" or exactly what is already saved, so a shopper can
 * still drop a code while pricing is down.
 * The consent is a digest and a yes, never a price or a list of gifts. The shopper's own live holds are read INSIDE the
 * transaction after the lock: a snapshot taken before it could credit a hold that has since been released or has expired.
 */

const intentOf = (draft: VoucherGroupDraft) => (draft.mode === "AUTO" ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: draft.voucherId } as const));

/** The optimizer's intent for a set of slot drafts: an AUTO slot is simply absent. */
const merchandiseIntentOf = (drafts: Readonly<Record<string, VoucherGroupDraft>>): VoucherSelectionIntent["merchandise"] =>
  Object.fromEntries(Object.entries(drafts).filter(([, draft]) => draft.mode === "MANUAL").map(([slot, draft]) => [slot, intentOf(draft)]));

type Refusal = Readonly<{ reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" | "QUOTE_UNAVAILABLE" }>;
type GiftRepair = Readonly<{ entitlements: readonly { campaignId: string; entitled: number }[]; counting: ReadonlySet<string> }>;

const isNone = (group: GroupSelection) => group.mode === "MANUAL" && group.voucherId === null;
const isAsSaved = (group: GroupSelection, saved: GroupSelection) => group.mode === saved.mode && (group.mode === "AUTO" || (saved.mode === "MANUAL" && group.voucherId === saved.voucherId));
const AUTO_GROUP: GroupSelection = { mode: "AUTO" };
/** True when the choice can only remove a voucher or leave it as it is: it cannot cost a gift or raise a total by being saved. */
const cannotCostAnything = (next: VoucherSelectionIntent, saved: VoucherSelectionIntent) =>
  [...new Set([...Object.keys(next.merchandise), ...Object.keys(saved.merchandise)])].every((slot) => {
    const group = next.merchandise[slot] ?? AUTO_GROUP;
    return isNone(group) || isAsSaved(group, saved.merchandise[slot] ?? AUTO_GROUP);
  }) && (isNone(next.shipping) || isAsSaved(next.shipping, saved.shipping));

/** The gate, run in `tx` with the cart row already locked. `repair` is what to apply after the choice is saved. */
async function consentGate(tx: Prisma.TransactionClient, input: Readonly<{
  cartId: string;
  shopId: number;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  attemptSecret: string;
  override: VoucherSelectionIntent;
  /** The choice saved right now (read under the same lock), to tell a choice that changes nothing or only clears. */
  saved: VoucherSelectionIntent;
  consentDigest: string | null;
  /** The one PRIVATE campaign a code just verified, so it can be previewed before it is saved. */
  verifiedPrivateIds?: readonly string[];
  /** The one type a code just unlocked, so its tiers can be previewed before the unlock is saved. */
  verifiedTypeIds?: readonly string[];
}>): Promise<Readonly<{ refusal: Refusal | null; repair: GiftRepair | null }>> {
  const { cartId, shopId, env, now, consentDigest } = input;
  const ownHolds = await createVoucherHoldService(tx as never, { attemptSecret: input.attemptSecret, env }).readOwnLiveHoldsIn(tx as never, cartId);
  const preview = await readVoucherPreviewWithin(tx, { cartId, shopId, now, env, ownHolds, selectionOverride: input.override, verifiedPrivateIds: input.verifiedPrivateIds, verifiedTypeIds: input.verifiedTypeIds })
    // A read that throws (an unreadable shipping policy, say) is "no quote", never "no cost".
    .catch(() => ({ enabled: true, ok: false }) as const);
  // No quote, no commit: the later hold/checkout layers are a second line, not a reason to save a choice whose price is unknown.
  if (!preview.enabled || !preview.ok) return { refusal: cannotCostAnything(input.override, input.saved) ? null : { reason: "QUOTE_UNAVAILABLE" }, repair: null };
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
  /**
   * The version of the saved choice the shopper's draft was built on (`selectionVersionOf`, handed out with the picker model).
   * Compared with the saved choice under the cart lock BEFORE anything else: a draft built on a choice another tab has changed
   * since is refused whole (`SELECTION_CHANGED`). null skips the check, for a caller that keeps the other group as saved
   * (`null` groups below) and so has no stale half to write.
   */
  expectedSelectionVersion: string | null;
  /**
   * One draft per merchandise slot to change; a slot that is absent, and a shipping passed as `null`, are kept as saved, read under
   * the cart lock (never from a snapshot taken before it).
   */
  draft: Readonly<{ merchandise: Readonly<Record<string, VoucherGroupDraft>>; shipping: VoucherGroupDraft | null }>;
  /** The digest of the quote the shopper explicitly confirmed, or null when they confirmed nothing. */
  consentDigest: string | null;
  attemptSecret: string;
}>): Promise<VoucherSelectionResult> {
  const { client, cartId, shopId, draft, consentDigest, attemptSecret, expectedSelectionVersion } = input;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  let repair: GiftRepair | null = null;

  return createVoucherSelectionService(client, { shopId, env }).applyAll({
    cartId,
    ...draft,
    now,
    async beforeSave(tx, resolved) {
      // First, before any quote is derived: is this still the choice the shopper was looking at?
      if (expectedSelectionVersion !== null && selectionVersionOf(resolved.saved) !== expectedSelectionVersion) return { ok: false, reason: "SELECTION_CHANGED" } as const;
      const gate = await consentGate(tx, {
        cartId, shopId, env, now, attemptSecret, consentDigest, saved: resolved.saved,
        override: { merchandise: merchandiseIntentOf(resolved.merchandise), shipping: intentOf(resolved.shipping) },
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
      // A voucher code locks that voucher in its slot; a type code leaves its slot to the ladder (AUTO) once the type is unlocked.
      const chosen = verified.campaignId === null ? null : ({ mode: "MANUAL", voucherId: verified.campaignId } as const);
      const slots = Object.fromEntries(Object.entries(saved.merchandise).filter(([slot]) => chosen !== null || slot !== verified.slot));
      const override: VoucherSelectionIntent =
        verified.group === "SHIPPING_FREE"
          ? { merchandise: saved.merchandise, shipping: chosen! }
          : { merchandise: chosen === null ? slots : { ...slots, [verified.slot]: chosen }, shipping: saved.shipping };
      const gate = await consentGate(tx, {
        cartId, shopId, env, now, attemptSecret, consentDigest, override, saved,
        ...(verified.campaignId === null ? {} : { verifiedPrivateIds: [verified.campaignId] }),
        ...(verified.typeId === null ? {} : { verifiedTypeIds: [verified.typeId] }),
      });
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
