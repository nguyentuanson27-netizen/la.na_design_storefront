import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { voucherSlotOf, type VoucherCampaign } from "./voucher-campaign.ts";
import { toVoucherCard, lookupVoucherCode, lookupVoucherTypeCode, readSelectedVouchers, type VoucherCard } from "./voucher-candidate-repository.ts";
import { canIssueNewVouchers } from "./voucher-gate.ts";
import { createVoucherCodeRateLimiter, type VoucherCodeRateLimiter } from "./voucher-code-rate-limit.ts";
import { AUTO_SELECTION, type GroupSelection, type VoucherSelectionIntent } from "./voucher-optimizer.ts";

/**
 * Voucher v1 (V15, extended by ADR 0020): the cart-bound, server-owned voucher selection (ADR 0018 D-5, spec §4.2, §6, §8).
 *
 * The selection is intent only: AUTO, a manual voucher per SLOT, an explicit "no voucher", or a code that was validated and
 * became a manual lock (a voucher code) or unlocked a type (a type code: AUTO inside the type's ladder). A slot is the shipping group, the
 * untyped merchandise group or one merchandise type. It lives in `CartVoucherSelection` keyed by the cart, so it survives
 * PDP -> cart -> checkout and reload with no code in a URL, a client cookie or analytics.
 *
 * Nothing here is money and nothing here is a hold: no write in this file touches a campaign counter, a hold or an
 * order, and the browser supplies only a slot, a voucher id (or NONE) or a code. Every write runs under the cart row lock
 * (the same one the cart and gift writers take), is gated by `LA_VOUCHER_ENABLED`, and re-validates the voucher
 * against the live row, including that it belongs to the slot it is chosen for. A stale saved id is not repaired here; the
 * quote drops it with a notice (AC-04).
 */

export type VoucherGroup = "MERCHANDISE" | "SHIPPING_FREE";

export type VoucherGroupDraft = Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;

export type VoucherSelectionResult =
  | Readonly<{ ok: true; selection: VoucherSelectionIntent }>
  | Readonly<{ ok: false; reason: "FEATURE_DISABLED" | "CART_UNAVAILABLE" | "INVALID_INPUT" | "NOT_AVAILABLE" | "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" | "QUOTE_UNAVAILABLE" | "SELECTION_CHANGED" }>;

/** What a verified code is waiting to do: lock one voucher, or unlock one type. */
export type VoucherCodePending = Readonly<{ campaignId: string | null; typeId: string | null; group: VoucherGroup; slot: string }>;

export type VoucherCodeResult =
  /** `card` is the voucher a campaign code locked; a type code has none (`typeName` names what it unlocked). */
  | Readonly<{ ok: true; selection: VoucherSelectionIntent; card: VoucherCard | null; typeName: string | null; group: VoucherGroup; slot: string }>
  | Readonly<{ ok: false; reason: "FEATURE_DISABLED" | "CART_UNAVAILABLE" | "INVALID_CODE" | "VOUCHER_UNAVAILABLE" | "RATE_LIMITED" | "QUOTE_UNAVAILABLE" }>
  /** A valid code whose choice costs the shopper something they have not agreed to: nothing was saved. */
  | Readonly<{ ok: false; reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED"; pending: VoucherCodePending }>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SLOT_PATTERN = /^(SHIPPING_FREE|MERCHANDISE(:[A-Za-z0-9_-]{1,64})?)$/;
const TYPED_PREFIX = "MERCHANDISE:";
export const MAX_TYPED_SELECTIONS = 8;
export const AUTO_INTENT: VoucherSelectionIntent = AUTO_SELECTION;

type TypeEntry = { mode: "AUTO" | "MANUAL"; voucherId: string | null; unlocked: boolean };
type Row = {
  merchandiseMode: "AUTO" | "MANUAL";
  merchandiseVoucherId: string | null;
  shippingMode: "AUTO" | "MANUAL";
  shippingVoucherId: string | null;
  /** `{ "<typeId>": { mode, voucherId, unlocked } }`; absent on a row written before types existed. */
  typeSelections?: unknown;
  expiresAt: Date;
};

function toGroup(mode: "AUTO" | "MANUAL", id: string | null): GroupSelection {
  return mode === "MANUAL" ? Object.freeze({ mode: "MANUAL" as const, voucherId: id }) : Object.freeze({ mode: "AUTO" as const });
}

/** Defensive: a malformed or oversized value is "nothing saved", never a throw. */
function parseTypeSelections(raw: unknown): Map<string, TypeEntry> {
  const out = new Map<string, TypeEntry>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TYPED_SELECTIONS) return out;
  for (const [typeId, value] of entries) {
    if (!ID_PATTERN.test(typeId) || value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const mode = entry.mode === "MANUAL" ? "MANUAL" : "AUTO";
    const voucherId = typeof entry.voucherId === "string" && ID_PATTERN.test(entry.voucherId) ? entry.voucherId : null;
    out.set(typeId, { mode, voucherId: mode === "MANUAL" ? voucherId : null, unlocked: entry.unlocked === true });
  }
  return out;
}

/** The saved row as the optimizer's intent; an absent or expired row is plain AUTO. */
export function selectionIntentFromRow(row: Row | null, now: Date): VoucherSelectionIntent {
  if (row === null || row.expiresAt <= now) return AUTO_INTENT;
  const merchandise: Record<string, GroupSelection> = {};
  if (row.merchandiseMode === "MANUAL") merchandise.MERCHANDISE = toGroup("MANUAL", row.merchandiseVoucherId);
  const unlocked: string[] = [];
  for (const [typeId, entry] of [...parseTypeSelections(row.typeSelections)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.mode === "MANUAL") merchandise[`${TYPED_PREFIX}${typeId}`] = toGroup("MANUAL", entry.voucherId);
    if (entry.unlocked) unlocked.push(typeId);
  }
  return Object.freeze({
    merchandise: Object.freeze(merchandise),
    shipping: toGroup(row.shippingMode, row.shippingVoucherId),
    ...(unlocked.length > 0 ? { unlockedTypeIds: Object.freeze(unlocked) } : {}),
  });
}

type SlotChange = Readonly<{ slot: string; mode: "AUTO" | "MANUAL"; voucherId: string | null }>;

/**
 * The full set of columns a write stores. It starts from what is saved ONLY while that row is unexpired (an expired row is
 * plain AUTO, so nothing of it may come back to life when the expiry is renewed), applies the slot changes, and unlocks the
 * given types.
 */
function nextColumns(existing: Row | null, now: Date, changes: readonly SlotChange[], unlockTypeIds: readonly string[] = []) {
  const base = existing !== null && existing.expiresAt > now ? existing : null;
  let merchandiseMode = base?.merchandiseMode ?? "AUTO";
  let merchandiseVoucherId = base?.merchandiseVoucherId ?? null;
  let shippingMode = base?.shippingMode ?? "AUTO";
  let shippingVoucherId = base?.shippingVoucherId ?? null;
  const typed = parseTypeSelections(base?.typeSelections);
  for (const change of changes) {
    const voucherId = change.mode === "MANUAL" ? change.voucherId : null;
    if (change.slot === "SHIPPING_FREE") {
      shippingMode = change.mode;
      shippingVoucherId = voucherId;
    } else if (change.slot === "MERCHANDISE") {
      merchandiseMode = change.mode;
      merchandiseVoucherId = voucherId;
    } else {
      const typeId = change.slot.slice(TYPED_PREFIX.length);
      typed.set(typeId, { mode: change.mode, voucherId, unlocked: typed.get(typeId)?.unlocked ?? false });
    }
  }
  for (const typeId of unlockTypeIds) typed.set(typeId, { ...(typed.get(typeId) ?? { mode: "AUTO" as const, voucherId: null }), unlocked: true });
  // An AUTO entry that unlocks nothing says nothing: dropping it keeps the stored value small.
  for (const [typeId, entry] of typed) if (entry.mode === "AUTO" && !entry.unlocked) typed.delete(typeId);
  const typeSelections = Object.fromEntries(typed) as Prisma.InputJsonObject;
  return { merchandiseMode, merchandiseVoucherId, shippingMode, shippingVoucherId, typeSelections };
}

/** True when the cart has already unlocked `campaign` if it is PRIVATE (a PUBLIC one needs no unlock). */
function unlockedFor(campaign: VoucherCampaign, saved: VoucherSelectionIntent): boolean {
  if (campaign.visibility !== "PRIVATE") return true;
  if (campaign.type) return (saved.unlockedTypeIds ?? []).includes(campaign.type.id);
  return [...Object.values(saved.merchandise), saved.shipping].some((group) => group.mode === "MANUAL" && group.voucherId === campaign.id);
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

  async function save(tx: Prisma.TransactionClient, cart: { id: string; expiresAt: Date }, now: Date, changes: readonly SlotChange[], unlockTypeIds: readonly string[] = []) {
    const existing = await tx.cartVoucherSelection.findUnique({ where: { cartId: cart.id } });
    const data = nextColumns(existing, now, changes, unlockTypeIds);
    const row = await tx.cartVoucherSelection.upsert({
      where: { cartId: cart.id },
      create: { cartId: cart.id, expiresAt: cart.expiresAt, ...data },
      update: { ...data, expiresAt: cart.expiresAt },
    });
    return selectionIntentFromRow(row, new Date(0));
  }

  /**
   * AUTO, a manual voucher, or an explicit NONE (`voucherId: null`) for one slot. A manual voucher must be an active campaign
   * of this shop and of that slot. A PRIVATE one is accepted here only if this cart already unlocked it by entering its code;
   * otherwise it answers NOT_AVAILABLE exactly like an id that does not exist. No quota, budget or hold is touched.
   */
  async function setSlot(input: Readonly<{ cartId: string; slot: string; mode: "AUTO" | "MANUAL"; voucherId?: string | null; now?: Date }>): Promise<VoucherSelectionResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const { slot, mode } = input;
    const voucherId = input.voucherId ?? null;
    if (typeof slot !== "string" || !SLOT_PATTERN.test(slot) || (mode !== "AUTO" && mode !== "MANUAL")) return { ok: false, reason: "INVALID_INPUT" };
    if (mode === "AUTO" ? voucherId !== null : voucherId !== null && !ID_PATTERN.test(voucherId)) return { ok: false, reason: "INVALID_INPUT" };
    const result = await withCart<VoucherSelectionResult>(input.cartId, now, async (tx, cart) => {
      if (mode === "MANUAL" && voucherId !== null) {
        const found = await readSelectedVouchers({ client: tx, shopId, ids: [voucherId], now, env });
        if (found.length !== 1 || voucherSlotOf(found[0]!) !== slot) return { ok: false, reason: "NOT_AVAILABLE" };
        if (found[0]!.visibility === "PRIVATE") {
          const saved = selectionIntentFromRow(await tx.cartVoucherSelection.findUnique({ where: { cartId: cart.id } }), now);
          if (!unlockedFor(found[0]!, saved)) return { ok: false, reason: "NOT_AVAILABLE" };
        }
      }
      return { ok: true, selection: await save(tx, cart, now, [{ slot, mode, voucherId }]) };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  /**
   * Commits the picker's "Áp dụng": every slot at once, in one transaction, so a shopper never ends up with half a choice. Each
   * manual voucher is validated exactly like `setSlot`; if any is refused nothing is written.
   *
   * A merchandise slot that is absent from `merchandise` and a shipping passed as `null` are KEPT as saved: they are read here,
   * under the cart lock, in the same transaction that writes, so a change another tab saved a moment ago cannot be overwritten
   * from a snapshot taken before the lock. A kept slot is not re-validated (it is not being chosen now; the quote drops a stale
   * one with a notice).
   */
  async function applyAll(input: Readonly<{
    cartId: string;
    merchandise: Readonly<Record<string, VoucherGroupDraft>>;
    shipping: VoucherGroupDraft | null;
    now?: Date;
    /**
     * Runs INSIDE the transaction, under the cart lock, after the vouchers are validated and BEFORE anything is written. A
     * refusal writes nothing. This is where the picker's consent to lose gifts is verified against the server's own quote.
     * It receives every slot as it would be saved (a kept slot already resolved) and the intent saved right now.
     */
    beforeSave?: (tx: Prisma.TransactionClient, resolved: Readonly<{ merchandise: Readonly<Record<string, VoucherGroupDraft>>; shipping: VoucherGroupDraft; saved: VoucherSelectionIntent }>) => Promise<Extract<VoucherSelectionResult, { ok: false }> | null>;
    /** Runs INSIDE the same transaction right after the selection is written: the gift change the consent bought. */
    afterSave?: (tx: Prisma.TransactionClient) => Promise<void>;
  }>): Promise<VoucherSelectionResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const slotDrafts = Object.entries(input.merchandise);
    if (slotDrafts.length > MAX_TYPED_SELECTIONS + 1) return { ok: false, reason: "INVALID_INPUT" };
    const requested: Array<[string, VoucherGroupDraft | null]> = [...slotDrafts, ["SHIPPING_FREE", input.shipping]];
    for (const [slot, draft] of requested) {
      if (!SLOT_PATTERN.test(slot) || (slot !== "SHIPPING_FREE" && !slot.startsWith("MERCHANDISE"))) return { ok: false, reason: "INVALID_INPUT" };
      if (draft === null) continue;
      if ((draft.mode !== "AUTO" && draft.mode !== "MANUAL") || (draft.mode === "AUTO" ? draft.voucherId !== null : draft.voucherId !== null && !ID_PATTERN.test(draft.voucherId))) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
    }
    const result = await withCart<VoucherSelectionResult>(input.cartId, now, async (tx, cart) => {
      const saved = selectionIntentFromRow(await tx.cartVoucherSelection.findUnique({ where: { cartId: cart.id } }), now);
      const keep = (group: GroupSelection | undefined): VoucherGroupDraft => (group !== undefined && group.mode === "MANUAL" ? { mode: "MANUAL", voucherId: group.voucherId } : { mode: "AUTO", voucherId: null });
      const merchandise: Record<string, VoucherGroupDraft> = {};
      for (const [slot, group] of Object.entries(saved.merchandise)) merchandise[slot] = keep(group);
      for (const [slot, draft] of slotDrafts) merchandise[slot] = draft;
      const shipping = input.shipping ?? keep(saved.shipping);
      const chosenNow: Array<[string, VoucherGroupDraft]> = [...slotDrafts, ...(input.shipping === null ? [] : ([["SHIPPING_FREE", input.shipping]] as Array<[string, VoucherGroupDraft]>))];
      const ids = chosenNow.flatMap(([, draft]) => (draft.mode === "MANUAL" && draft.voucherId !== null ? [draft.voucherId] : []));
      const found = ids.length === 0 ? [] : await readSelectedVouchers({ client: tx, shopId, ids, now, env });
      for (const [slot, draft] of chosenNow) {
        if (draft.mode !== "MANUAL" || draft.voucherId === null) continue;
        const campaign = found.find((candidate) => candidate.id === draft.voucherId);
        if (campaign === undefined || voucherSlotOf(campaign) !== slot || !unlockedFor(campaign, saved)) return { ok: false, reason: "NOT_AVAILABLE" };
      }
      if (input.beforeSave) {
        const refusal = await input.beforeSave(tx, { merchandise, shipping, saved });
        if (refusal !== null) return refusal;
      }
      const changes: SlotChange[] = chosenNow.map(([slot, draft]) => ({ slot, mode: draft.mode, voucherId: draft.voucherId }));
      const selection = await save(tx, cart, now, changes);
      if (input.afterSave) await input.afterSave(tx);
      return { ok: true, selection };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  /**
   * Validates a typed or linked code and, if good, either locks that voucher in its slot as the shopper's manual choice (spec
   * §4.2: a valid entered code is a manual lock) or, for a TYPE code, unlocks the type and leaves its slot to the ladder (AUTO).
   * Throttled before the lookup; every failure of a private code answers INVALID_CODE (see the candidate repository). Grants nothing.
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
    beforeSave?: (tx: Prisma.TransactionClient, verified: VoucherCodePending) => Promise<Readonly<{ reason: "CONFIRMATION_REQUIRED" | "QUOTE_CHANGED" | "QUOTE_UNAVAILABLE" }> | null>;
    afterSave?: (tx: Prisma.TransactionClient) => Promise<void>;
  }>): Promise<VoucherCodeResult> {
    const now = input.now ?? new Date();
    if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED" };
    const result = await withCart<VoucherCodeResult>(input.cartId, now, async (tx, cart) => {
      // The attempt is counted before the code is looked at, valid or not.
      if (!(await limiter.consume({ cartId: cart.id, shopId, now }))) return { ok: false, reason: "RATE_LIMITED" };
      const lookup = await lookupVoucherCode({ client: tx, shopId, rawCode: input.rawCode, now, env });
      let verified: VoucherCodePending;
      let card: VoucherCard | null = null;
      let typeName: string | null = null;
      if (lookup.ok) {
        verified = { campaignId: lookup.campaign.id, typeId: null, group: lookup.campaign.kind, slot: voucherSlotOf(lookup.campaign) };
        card = toVoucherCard(lookup.campaign);
      } else if (lookup.reason === "INVALID_CODE") {
        // Not a voucher code: it may be the code of a type. Both answer the very same INVALID_CODE when they fail.
        const typed = await lookupVoucherTypeCode({ client: tx, shopId, rawCode: input.rawCode, now, env });
        if (!typed.ok) return { ok: false, reason: typed.reason };
        verified = { campaignId: null, typeId: typed.type.id, group: "MERCHANDISE", slot: `${TYPED_PREFIX}${typed.type.id}` };
        typeName = typed.type.name;
      } else {
        return { ok: false, reason: lookup.reason };
      }
      if (input.beforeSave) {
        const refusal = await input.beforeSave(tx, verified);
        if (refusal !== null) {
          // With no quote at all there is nothing to show or to confirm: the code is refused outright and nothing is pending.
          if (refusal.reason === "QUOTE_UNAVAILABLE") return { ok: false, reason: "QUOTE_UNAVAILABLE" };
          return { ok: false, reason: refusal.reason, pending: verified };
        }
      }
      const selection =
        verified.typeId !== null
          ? await save(tx, cart, now, [{ slot: verified.slot, mode: "AUTO", voucherId: null }], [verified.typeId])
          : await save(tx, cart, now, [{ slot: verified.slot, mode: "MANUAL", voucherId: verified.campaignId }]);
      if (input.afterSave) await input.afterSave(tx);
      return { ok: true, selection, card, typeName, group: verified.group, slot: verified.slot };
    });
    return result ?? { ok: false, reason: "CART_UNAVAILABLE" };
  }

  return { read, setSlot, applyAll, applyCode };
}
