import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { toVoucherCard, lookupVoucherCode, readSelectedVouchers, type VoucherCard } from "./voucher-candidate-repository.ts";
import { canIssueNewVouchers } from "./voucher-gate.ts";
import { createVoucherCodeRateLimiter, type VoucherCodeRateLimiter } from "./voucher-code-rate-limit.ts";
import type { GroupSelection, VoucherSelectionIntent } from "./voucher-optimizer.ts";

/**
 * Voucher v1 (V15): the cart-bound, server-owned voucher selection (ADR 0018 D-5, spec §4.2, §6, §8).
 *
 * The selection is intent only: AUTO, a manual voucher per group, an explicit "no voucher", or a code that was
 * validated and became a manual lock. It lives in `CartVoucherSelection` keyed by the cart, so it survives
 * PDP -> cart -> checkout and reload with no code in a URL, a client cookie or analytics.
 *
 * Nothing here is money and nothing here is a hold: no write in this file touches a campaign counter, a hold or an
 * order, and the browser supplies only a voucher id (or NONE) or a code. Every write runs under the cart row lock
 * (the same one the cart and gift writers take), is gated by `LA_VOUCHER_ENABLED`, and re-validates the voucher
 * against the live row. A stale saved id is not repaired here; the quote drops it with a notice (AC-04).
 */

export type VoucherGroup = "MERCHANDISE" | "SHIPPING_FREE";

export type VoucherGroupDraft = Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;

export type VoucherSelectionResult =
  | Readonly<{ ok: true; selection: VoucherSelectionIntent }>
  | Readonly<{ ok: false; reason: "FEATURE_DISABLED" | "CART_UNAVAILABLE" | "INVALID_INPUT" | "NOT_AVAILABLE" | "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" | "QUOTE_UNAVAILABLE" | "SELECTION_CHANGED" }>;

export type VoucherCodeResult =
  | Readonly<{ ok: true; selection: VoucherSelectionIntent; card: VoucherCard; group: VoucherGroup }>
  | Readonly<{ ok: false; reason: "FEATURE_DISABLED" | "CART_UNAVAILABLE" | "INVALID_CODE" | "VOUCHER_UNAVAILABLE" | "RATE_LIMITED" | "QUOTE_UNAVAILABLE" }>
  /** A valid code whose choice costs the shopper something they have not agreed to: nothing was saved. */
  | Readonly<{ ok: false; reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED"; pending: Readonly<{ campaignId: string; group: VoucherGroup }> }>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const AUTO_INTENT: VoucherSelectionIntent = Object.freeze({
  merchandise: Object.freeze({ mode: "AUTO" as const }),
  shipping: Object.freeze({ mode: "AUTO" as const }),
});

type Row = { merchandiseMode: "AUTO" | "MANUAL"; merchandiseVoucherId: string | null; shippingMode: "AUTO" | "MANUAL"; shippingVoucherId: string | null; expiresAt: Date };

function toGroup(mode: "AUTO" | "MANUAL", id: string | null): GroupSelection {
  return mode === "MANUAL" ? Object.freeze({ mode: "MANUAL" as const, voucherId: id }) : Object.freeze({ mode: "AUTO" as const });
}

/** The saved row as the optimizer's intent; an absent or expired row is plain AUTO. */
export function selectionIntentFromRow(row: Row | null, now: Date): VoucherSelectionIntent {
  if (row === null || row.expiresAt <= now) return AUTO_INTENT;
  return Object.freeze({ merchandise: toGroup(row.merchandiseMode, row.merchandiseVoucherId), shipping: toGroup(row.shippingMode, row.shippingVoucherId) });
}

export function createVoucherSelectionService(client: PrismaClient, options: Readonly<{
  shopId: number;
  env?: Readonly<Record<string, string | undefined>>;
  rateLimiter?: VoucherCodeRateLimiter;
}>) {
  const { shopId } = options;
  const env = options.env ?? process.env;
  const limiter = options.rateLimiter ?? createVoucherCodeRateLimiter(client);

  /** Runs `work` with the (anonymous, unexpired) cart row locked; null when there is no such cart. */
  async function withCart<T>(cartId: string, now: Date, work: (tx: Prisma.TransactionClient, cart: { id: string; expiresAt: Date }) => Promise<T>): Promise<T | null> {
    if (typeof cartId !== "string" || cartId.length === 0 || cartId.length > 64) return null;
    return client.$transaction(async (tx) => {
      const carts = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>`SELECT "id", "expiresAt" FROM "Cart" WHERE "id" = ${cartId} AND "userId" IS NULL AND "expiresAt" > ${now} FOR UPDATE`;
      if (carts.length !== 1) return null;
      return work(tx, carts[0]!);
    });
  }

  async function read(cartId: string, now = new Date()): Promise<VoucherSelectionIntent> {
    if (!canIssueNewVouchers(env)) return AUTO_INTENT;
    const row = await client.cartVoucherSelection.findUnique({ where: { cartId } });
    return selectionIntentFromRow(row, now);
  }

  function columns(group: VoucherGroup, mode: "AUTO" | "MANUAL", voucherId: string | null) {
    return group === "MERCHANDISE"
      ? { merchandiseMode: mode, merchandiseVoucherId: voucherId }
      : { shippingMode: mode, shippingVoucherId: voucherId };
  }

  async function save(tx: Prisma.TransactionClient, cart: { id: string; expiresAt: Date }, group: VoucherGroup, mode: "AUTO" | "MANUAL", voucherId: string | null) {
    const data = columns(group, mode, voucherId);
    const row = await tx.cartVoucherSelection.upsert({
      where: { cartId: cart.id },
      create: { cartId: cart.id, expiresAt: cart.expiresAt, ...data },
      update: { ...data, expiresAt: cart.expiresAt },
    });
    return selectionIntentFromRow(row, new Date(0));
  }

  /**
   * The PRIVATE voucher ids this cart has already unlocked: exactly those its saved (unexpired) selection names.
   * A saved id can only have got there through `applyCode` (the server verified the code for THIS cart, under the
   * rate limit) or through this same rule, so the set is closed under the writes below. An id is not a credential:
   * knowing it, from another cart, a link or a log, unlocks nothing.
   */
  async function unlockedPrivateIds(tx: Prisma.TransactionClient, cartId: string, now: Date): Promise<ReadonlySet<string>> {
    const intent = selectionIntentFromRow(await tx.cartVoucherSelection.findUnique({ where: { cartId } }), now);
    const ids = [intent.merchandise, intent.shipping].flatMap((group) => (group.mode === "MANUAL" && group.voucherId !== null ? [group.voucherId] : []));
    return new Set(ids);
  }

  /**
   * AUTO, a manual voucher, or an explicit NONE (`voucherId: null`) for one group. A manual voucher must be an
   * active campaign of this shop and of that group. A PRIVATE one is accepted here only if this cart already
   * unlocked it by entering its code (`unlockedPrivateIds`); otherwise it answers NOT_AVAILABLE exactly like an
   * id that does not exist. No quota, budget or hold is touched.
   */
  async function setGroup(input: Readonly<{ cartId: string; group: VoucherGroup; mode: "AUTO" | "MANUAL"; voucherId?: string | null; now?: Date }>): Promise<VoucherSelectionResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const { group, mode } = input;
    const voucherId = input.voucherId ?? null;
    if ((group !== "MERCHANDISE" && group !== "SHIPPING_FREE") || (mode !== "AUTO" && mode !== "MANUAL")) return { ok: false, reason: "INVALID_INPUT" };
    if (mode === "AUTO" ? voucherId !== null : voucherId !== null && !ID_PATTERN.test(voucherId)) return { ok: false, reason: "INVALID_INPUT" };
    const result = await withCart<VoucherSelectionResult>(input.cartId, now, async (tx, cart) => {
      if (mode === "MANUAL" && voucherId !== null) {
        const found = await readSelectedVouchers({ client: tx, shopId, ids: [voucherId], now, env });
        if (found.length !== 1 || found[0]!.kind !== group) return { ok: false, reason: "NOT_AVAILABLE" };
        if (found[0]!.visibility === "PRIVATE" && !(await unlockedPrivateIds(tx, cart.id, now)).has(voucherId)) return { ok: false, reason: "NOT_AVAILABLE" };
      }
      return { ok: true, selection: await save(tx, cart, group, mode, voucherId) };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  /**
   * Commits the picker's "Áp dụng": both groups at once, in one transaction, so a shopper never ends up with half a
   * choice. Each manual voucher is validated exactly like `setGroup`; if either is refused nothing is written.
   *
   * A group passed as `null` is KEPT as saved: it is read here, under the cart lock, in the same transaction that writes, so a
   * change another tab saved a moment ago cannot be overwritten from a snapshot taken before the lock. A kept group is not
   * re-validated (it is not being chosen now; the quote drops a stale one with a notice).
   */
  async function applyBoth(input: Readonly<{
    cartId: string;
    merchandise: VoucherGroupDraft | null;
    shipping: VoucherGroupDraft | null;
    now?: Date;
    /**
     * Runs INSIDE the transaction, under the cart lock, after the vouchers are validated and BEFORE anything is written. A
     * refusal writes nothing. This is where the picker's consent to lose gifts is verified against the server's own quote.
     * It receives both groups as they would be saved (a kept group already resolved) and the intent saved right now.
     */
    beforeSave?: (tx: Prisma.TransactionClient, resolved: Readonly<{ merchandise: VoucherGroupDraft; shipping: VoucherGroupDraft; saved: VoucherSelectionIntent }>) => Promise<Extract<VoucherSelectionResult, { ok: false }> | null>;
    /** Runs INSIDE the same transaction right after the selection is written: the gift change the consent bought. */
    afterSave?: (tx: Prisma.TransactionClient) => Promise<void>;
  }>): Promise<VoucherSelectionResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const requested: Array<[VoucherGroup, VoucherGroupDraft | null]> = [["MERCHANDISE", input.merchandise], ["SHIPPING_FREE", input.shipping]];
    for (const [, draft] of requested) {
      if (draft === null) continue;
      if ((draft.mode !== "AUTO" && draft.mode !== "MANUAL") || (draft.mode === "AUTO" ? draft.voucherId !== null : draft.voucherId !== null && !ID_PATTERN.test(draft.voucherId))) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
    }
    const result = await withCart<VoucherSelectionResult>(input.cartId, now, async (tx, cart) => {
      const saved = selectionIntentFromRow(await tx.cartVoucherSelection.findUnique({ where: { cartId: cart.id } }), now);
      const keep = (group: GroupSelection): VoucherGroupDraft => (group.mode === "MANUAL" ? { mode: "MANUAL", voucherId: group.voucherId } : { mode: "AUTO", voucherId: null });
      const merchandise = input.merchandise ?? keep(saved.merchandise);
      const shipping = input.shipping ?? keep(saved.shipping);
      const drafts: Array<[VoucherGroup, VoucherGroupDraft, boolean]> = [["MERCHANDISE", merchandise, input.merchandise === null], ["SHIPPING_FREE", shipping, input.shipping === null]];
      const ids = drafts.flatMap(([, draft, kept]) => (!kept && draft.mode === "MANUAL" && draft.voucherId !== null ? [draft.voucherId] : []));
      const found = ids.length === 0 ? [] : await readSelectedVouchers({ client: tx, shopId, ids, now, env });
      const unlocked = found.some((campaign) => campaign.visibility === "PRIVATE") ? await unlockedPrivateIds(tx, cart.id, now) : new Set<string>();
      for (const [group, draft, kept] of drafts) {
        if (kept || draft.mode !== "MANUAL" || draft.voucherId === null) continue;
        const campaign = found.find((candidate) => candidate.id === draft.voucherId);
        if (campaign?.kind !== group || (campaign.visibility === "PRIVATE" && !unlocked.has(campaign.id))) return { ok: false, reason: "NOT_AVAILABLE" };
      }
      if (input.beforeSave) {
        const refusal = await input.beforeSave(tx, { merchandise, shipping, saved });
        if (refusal !== null) return refusal;
      }
      const data = { ...columns("MERCHANDISE", merchandise.mode, merchandise.voucherId), ...columns("SHIPPING_FREE", shipping.mode, shipping.voucherId) };
      const row = await tx.cartVoucherSelection.upsert({
        where: { cartId: cart.id },
        create: { cartId: cart.id, expiresAt: cart.expiresAt, ...data },
        update: { expiresAt: cart.expiresAt, ...data },
      });
      if (input.afterSave) await input.afterSave(tx);
      return { ok: true, selection: selectionIntentFromRow(row, new Date(0)) };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  /**
   * Validates a typed or linked code and, if good, locks that voucher in its group as the shopper's manual
   * choice (spec §4.2: a valid entered code is a manual lock). Throttled before the lookup; every failure of a
   * private code answers INVALID_CODE (see the candidate repository). Grants nothing.
   */
  async function applyCode(input: Readonly<{
    cartId: string;
    rawCode: unknown;
    now?: Date;
    /**
     * Runs INSIDE the transaction, under the cart lock, once the code is verified (and rate-counted) and BEFORE the choice is
     * written. A refusal writes nothing: the verified code is not saved, so a choice that costs a gift or raises the total
     * waits for the shopper's explicit consent exactly like a draft does.
     */
    beforeSave?: (tx: Prisma.TransactionClient, verified: Readonly<{ campaignId: string; group: VoucherGroup }>) => Promise<Readonly<{ reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" | "QUOTE_UNAVAILABLE" }> | null>;
    afterSave?: (tx: Prisma.TransactionClient) => Promise<void>;
  }>): Promise<VoucherCodeResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const result = await withCart<VoucherCodeResult>(input.cartId, now, async (tx, cart) => {
      // The attempt is counted before the code is looked at, valid or not.
      if (!(await limiter.consume({ cartId: cart.id, shopId, now }))) return { ok: false, reason: "RATE_LIMITED" };
      const lookup = await lookupVoucherCode({ client: tx, shopId, rawCode: input.rawCode, now, env });
      if (!lookup.ok) return { ok: false, reason: lookup.reason };
      const group: VoucherGroup = lookup.campaign.kind;
      if (input.beforeSave) {
        const refusal = await input.beforeSave(tx, { campaignId: lookup.campaign.id, group });
        if (refusal !== null) {
          // With no quote at all there is nothing to show or to confirm: the code is refused outright and nothing is pending.
          if (refusal.reason === "QUOTE_UNAVAILABLE") return { ok: false, reason: "QUOTE_UNAVAILABLE" };
          return { ok: false, reason: refusal.reason, pending: { campaignId: lookup.campaign.id, group } };
        }
      }
      const selection = await save(tx, cart, group, "MANUAL", lookup.campaign.id);
      if (input.afterSave) await input.afterSave(tx);
      return { ok: true, selection, card: toVoucherCard(lookup.campaign), group };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  return { read, setGroup, applyBoth, applyCode };
}
