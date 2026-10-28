import { createHmac } from "node:crypto";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";
import { canIssueNewVouchers, readVoucherVerifiedShopIds } from "./voucher-gate.ts";

/**
 * Voucher v1 (V11, ADR 0019 D-1/D-2/D-3; one hold per SLOT per ADR 0020): the atomic 10-minute hold.
 *
 * The database already enforces the invariants (absolute TTL, one live hold per attempt and slot, quota floor,
 * no early expiry, no late consume). This module only SEQUENCES them:
 *
 *   BEGIN; lock the cart row; lock the chosen campaigns FOR UPDATE in ascending id order; lazily expire due
 *   holds of those campaigns (their uses and VND go back); for each requested voucher reuse / swap / grant;
 *   insert with createdAt and expiresAt from ONE database timestamp; COMMIT.
 *
 * All requested vouchers of a call succeed or none does: a combination is quoted as a whole, so a half-granted
 * one would be a different total than the one the buyer saw. A failed swap therefore leaves the old hold
 * exactly as it was (AC-34). Nothing here is reachable from a GET; V12 owns the intentional POST. The settle
 * path (consume, release by order, refund) is V13/V14 and never consults the feature gate.
 */

export type VoucherGroup = "MERCHANDISE" | "SHIPPING_FREE";

export type VoucherHoldGrant = Readonly<{
  kind: VoucherGroup;
  /** `SHIPPING_FREE`, `MERCHANDISE` (no type) or `MERCHANDISE:<typeId>`: the campaign's own slot. */
  slot: string;
  campaignId: string;
  /** The revision the quote was computed against; a campaign edited since is a re-quote, not a silent grant. */
  campaignRevision: number;
  /** Merchandise: the discount D. Shipping: the fee waived. Whole VND, 1..100_000_000_000. */
  discountVnd: number;
}>;

export type VoucherHoldRequest = Readonly<{
  shopId: number;
  cartId: string;
  /** `paidRevision` the quote was computed at; the locked cart must still be at it. */
  paidRevision: number;
  quoteDigest: string;
  grants: readonly VoucherHoldGrant[];
  /** Release the live hold of each of these slots (no grant may name the same slot). */
  releaseSlots?: readonly string[];
  /**
   * Release every other live hold of this attempt: the slots the quote no longer includes (an explicit NONE, or a combination
   * without that slot). With no grants this releases them all.
   */
  releaseUnlisted?: boolean;
}>;

export type HeldVoucher = Readonly<{
  holdId: string;
  kind: VoucherGroup;
  slot: string;
  campaignId: string;
  campaignRevision: number;
  heldDiscountVnd: number;
  quoteDigest: string;
  paidRevision: number;
  createdAt: Date;
  expiresAt: Date;
  /** True when an existing live hold satisfied the request unchanged (nothing was extended). */
  reused: boolean;
}>;

export type VoucherHoldFailureReason =
  | "FEATURE_DISABLED"
  | "SHOP_NOT_VERIFIED"
  | "INVALID_REQUEST"
  | "CART_NOT_FOUND"
  | "CART_CHANGED"
  | "CAMPAIGN_NOT_FOUND"
  | "CAMPAIGN_NOT_ACTIVE"
  | "CAMPAIGN_CHANGED"
  | "CAPACITY_EXHAUSTED"
  /** The quote recomputed under the cart lock is not the one the buyer agreed to. */
  | "QUOTE_CHANGED"
  /** The `finalize` step (issuing the proof) could not complete, so the whole call was rolled back. */
  | "PROOF_UNAVAILABLE";

export type VoucherHoldResult =
  | Readonly<{ ok: true; holds: readonly HeldVoucher[]; /** The slots whose live hold was released (swapped or dropped). */ released: readonly string[] }>
  | Readonly<{ ok: false; reason: VoucherHoldFailureReason; kind: VoucherGroup | null; campaignId: string | null }>;

const MAX_DISCOUNT_VND = 100_000_000_000;
const SLOT_PATTERN = /^(SHIPPING_FREE|MERCHANDISE(:[A-Za-z0-9_-]{1,64})?)$/;
/** A cart holds at most one voucher per slot; ADR 0020 D-4 bounds the slots. */
const MAX_GRANTS = 9;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_CONTEXT = "voucher-hold-attempt:v1\0";
const MIN_SECRET_LENGTH = 32;

/** HMAC of the cart id: the stored identity of a checkout attempt. The cart id itself is never stored or logged. */
export function voucherAttemptKey(cartId: string, secret: string): string {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) throw new TypeError("Voucher attempt key requires the validated server secret");
  if (typeof cartId !== "string" || cartId.length === 0 || cartId.length > 64) throw new TypeError("Voucher attempt key requires a cart id");
  return createHmac("sha256", secret).update(KEY_CONTEXT).update(cartId).digest("hex");
}

type CampaignLock = {
  id: string;
  pancakeShopId: number;
  kind: VoucherGroup;
  typeId: string | null;
  isEnabled: boolean;
  enabledAt: Date | null;
  disabledAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  revision: number;
  maxUses: number | null;
  maxBudgetVnd: bigint | null;
  redeemedUses: number;
  redeemedVnd: bigint;
  reservedUses: number;
  reservedVnd: bigint;
};

type HoldRow = {
  id: string;
  campaignId: string;
  campaignRevision: number;
  kind: VoucherGroup;
  slot: string;
  quoteDigest: string;
  paidRevision: bigint;
  heldDiscountVnd: bigint;
  createdAt: Date;
  expiresAt: Date;
};

const KINDS: readonly VoucherGroup[] = ["MERCHANDISE", "SHIPPING_FREE"];

/** The slot a campaign's holds live in (mirrors `voucherSlotOf`, over the raw columns of the locked row). */
const slotOfLock = (lock: Pick<CampaignLock, "kind" | "typeId">) => (lock.kind === "SHIPPING_FREE" ? "SHIPPING_FREE" : lock.typeId === null ? "MERCHANDISE" : `MERCHANDISE:${lock.typeId}`);

function toHeld(row: HoldRow, reused: boolean): HeldVoucher {
  return Object.freeze({
    holdId: row.id,
    kind: row.kind,
    slot: row.slot,
    campaignId: row.campaignId,
    campaignRevision: row.campaignRevision,
    heldDiscountVnd: Number(row.heldDiscountVnd),
    quoteDigest: row.quoteDigest,
    paidRevision: Number(row.paidRevision),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    reused,
  });
}

class HoldRollback extends Error {
  readonly result: Extract<VoucherHoldResult, { ok: false }>;
  constructor(result: Extract<VoucherHoldResult, { ok: false }>) {
    super(result.reason);
    this.result = result;
  }
}

const fail = (reason: VoucherHoldFailureReason, kind: VoucherGroup | null = null, campaignId: string | null = null): HoldRollback =>
  new HoldRollback({ ok: false, reason, kind, campaignId });

function validRequest(request: VoucherHoldRequest): boolean {
  if (!Number.isSafeInteger(request.shopId) || request.shopId <= 0) return false;
  if (typeof request.cartId !== "string" || request.cartId.length === 0 || request.cartId.length > 64) return false;
  if (!Number.isSafeInteger(request.paidRevision) || request.paidRevision < 0) return false;
  if (typeof request.quoteDigest !== "string" || !HEX64.test(request.quoteDigest)) return false;
  if (!Array.isArray(request.grants) || request.grants.length > MAX_GRANTS) return false;
  if (request.releaseUnlisted !== undefined && typeof request.releaseUnlisted !== "boolean") return false;
  const releaseSlots = request.releaseSlots ?? [];
  if (!Array.isArray(releaseSlots) || releaseSlots.length > MAX_GRANTS || releaseSlots.some((slot) => typeof slot !== "string" || !SLOT_PATTERN.test(slot))) return false;
  if (request.grants.length + releaseSlots.length + (request.releaseUnlisted === true ? 1 : 0) === 0) return false;
  const slots = new Set<string>();
  for (const grant of request.grants) {
    if (grant === null || typeof grant !== "object" || !KINDS.includes(grant.kind) || typeof grant.slot !== "string" || !SLOT_PATTERN.test(grant.slot) || slots.has(grant.slot)) return false;
    // A kind has its own slots: shipping has one, merchandise has the untyped one and one per type.
    if ((grant.kind === "SHIPPING_FREE") !== (grant.slot === "SHIPPING_FREE")) return false;
    slots.add(grant.slot);
    if (typeof grant.campaignId !== "string" || grant.campaignId.length === 0 || grant.campaignId.length > 64) return false;
    if (!Number.isSafeInteger(grant.campaignRevision) || grant.campaignRevision <= 0) return false;
    if (!Number.isSafeInteger(grant.discountVnd) || grant.discountVnd < 1 || grant.discountVnd > MAX_DISCOUNT_VND) return false;
  }
  if (releaseSlots.some((slot) => slots.has(slot)) || new Set(releaseSlots).size !== releaseSlots.length) return false;
  return new Set(request.grants.map((g) => g.campaignId)).size === request.grants.length;
}

export function createVoucherHoldService(client: PrismaClient, options: Readonly<{
  attemptSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
}>) {
  const env = options.env ?? process.env;

  /** The database clock, truncated to the column's precision: the one timestamp a grant uses. */
  async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`;
    return rows[0]!.now;
  }

  async function lockCampaign(tx: Prisma.TransactionClient, id: string): Promise<CampaignLock | null> {
    const rows = await tx.$queryRaw<CampaignLock[]>`
      SELECT "id", "pancakeShopId", "kind", "typeId", "isEnabled", "enabledAt", "disabledAt", "startsAt", "endsAt", "revision",
             "maxUses", "maxBudgetVnd", "redeemedUses", "redeemedVnd", "reservedUses", "reservedVnd"
      FROM "VoucherCampaign" WHERE "id" = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Marks every due live hold of a locked campaign EXPIRED and gives its uses and VND back. */
  async function expireDue(tx: Prisma.TransactionClient, campaign: CampaignLock, now: Date): Promise<void> {
    const expired = await tx.$queryRaw<Array<{ heldDiscountVnd: bigint }>>`
      UPDATE "VoucherHold" SET "state" = 'EXPIRED', "releasedAt" = ${now}
      WHERE "campaignId" = ${campaign.id} AND "state" = 'HELD' AND "expiresAt" <= ${now}
      RETURNING "heldDiscountVnd"`;
    if (expired.length === 0) return;
    const vnd = expired.reduce((sum, row) => sum + row.heldDiscountVnd, BigInt(0));
    await giveBack(tx, campaign, expired.length, vnd);
  }

  async function giveBack(tx: Prisma.TransactionClient, campaign: CampaignLock, uses: number, vnd: bigint): Promise<void> {
    await tx.$executeRaw`UPDATE "VoucherCampaign" SET "reservedUses" = "reservedUses" - ${uses}, "reservedVnd" = "reservedVnd" - ${vnd} WHERE "id" = ${campaign.id}`;
    campaign.reservedUses -= uses;
    campaign.reservedVnd -= vnd;
  }

  /** Every live hold of the attempt (at most one per slot). Peeked WITHOUT a row lock; see `liveHoldsLocked`. */
  async function liveHolds(tx: Prisma.TransactionClient, attemptKey: string): Promise<HoldRow[]> {
    return tx.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' ORDER BY "slot"`;
  }

  /** Only after the campaign locks are held: campaign row first, hold rows second, the same order as the sweeper. */
  async function liveHoldsLocked(tx: Prisma.TransactionClient, attemptKey: string): Promise<HoldRow[]> {
    return tx.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' ORDER BY "slot" FOR UPDATE`;
  }

  async function releaseHold(tx: Prisma.TransactionClient, hold: HoldRow, campaign: CampaignLock, now: Date): Promise<void> {
    await tx.$executeRaw`UPDATE "VoucherHold" SET "state" = 'RELEASED', "releasedAt" = ${now} WHERE "id" = ${hold.id} AND "state" = 'HELD'`;
    await giveBack(tx, campaign, 1, hold.heldDiscountVnd);
  }

  /**
   * Grants, reuses or swaps the requested holds and releases the listed groups, all or nothing. Never throws
   * for an ordinary refusal; a refusal leaves every hold and counter as it was.
   */
  async function hold(
    request: VoucherHoldRequest,
    hooks: Readonly<{
      /**
       * Runs INSIDE the transaction right after the cart row is locked (selection writers take the same lock, so
       * they are excluded from here on) and before anything is granted, swapped or released. Returning a reason rolls
       * the call back untouched: this is where the flow proves the quote is still the one the buyer agreed to.
       */
      verifyUnderCartLock?: (tx: Prisma.TransactionClient) => Promise<VoucherHoldFailureReason | null>;
      /**
       * Runs INSIDE the transaction after every hold exists and before COMMIT. Returning a reason rolls everything
       * back (a swap keeps its old hold, nothing is reserved): a buyer never ends up with quota held and no proof
       * to spend it with.
       */
      finalize?: (holds: readonly HeldVoucher[]) => VoucherHoldFailureReason | null;
      /**
       * Runs INSIDE the transaction after every hold exists (a reused hold counts) and before `finalize`, with the cart row
       * still locked. This is where the buyer's explicit consent to lose a gift is carried out: the stored gift choice is
       * repaired in the same transaction, so a refusal anywhere rolls the voucher AND the gift change back together.
       */
      afterGrant?: (tx: Prisma.TransactionClient, holds: readonly HeldVoucher[]) => Promise<VoucherHoldFailureReason | null>;
    }> = {},
  ): Promise<VoucherHoldResult> {
    const { finalize, verifyUnderCartLock, afterGrant } = hooks;
    if (!validRequest(request)) return { ok: false, reason: "INVALID_REQUEST", kind: null, campaignId: null };
    const attemptKey = voucherAttemptKey(request.cartId, options.attemptSecret);
    // A request that only releases is settle-like and must work with the feature off; only NEW holds are gated.
    if (request.grants.length > 0) {
      if (!canIssueNewVouchers(env)) return { ok: false, reason: "FEATURE_DISABLED", kind: null, campaignId: null };
      if (!readVoucherVerifiedShopIds(env).includes(request.shopId)) return { ok: false, reason: "SHOP_NOT_VERIFIED", kind: null, campaignId: null };
    }

    try {
      return await client.$transaction(async (tx) => {
        // 1  the cart row first: selection writers and the cart take the same lock.
        const carts = await tx.$queryRaw<Array<{ paidRevision: bigint }>>`
          SELECT "paidRevision" FROM "Cart" WHERE "id" = ${request.cartId} AND "userId" IS NULL AND "expiresAt" > now() FOR UPDATE`;
        if (carts.length !== 1) throw fail("CART_NOT_FOUND");
        if (request.grants.length > 0 && Number(carts[0]!.paidRevision) !== request.paidRevision) throw fail("CART_CHANGED");
        if (verifyUnderCartLock) {
          const refusal = await verifyUnderCartLock(tx);
          if (refusal !== null) throw fail(refusal);
        }

        // 2  every campaign involved (requested, or already held in a slot in play), ascending id. The hold rows are only
        //    peeked at here (a hold's campaign never changes, and only this cart's lock creates one); they are locked after
        //    the campaigns so no path takes hold-then-campaign.
        const grantSlots = new Set(request.grants.map((grant) => grant.slot));
        const releaseSlots = new Set(request.releaseSlots ?? []);
        const inPlay = (slot: string) => request.releaseUnlisted === true || grantSlots.has(slot) || releaseSlots.has(slot);
        const peeked = (await liveHolds(tx, attemptKey)).filter((row) => inPlay(row.slot));
        const ids = [...new Set([...request.grants.map((g) => g.campaignId), ...peeked.map((h) => h.campaignId)])].sort();
        const locks = new Map<string, CampaignLock>();
        for (const id of ids) {
          const lock = await lockCampaign(tx, id);
          if (lock !== null) locks.set(id, lock);
        }

        // 3  lazy expiry: the request, not a sweeper, is the authority on what is still held.
        const now = await databaseNow(tx);
        for (const lock of locks.values()) await expireDue(tx, lock, now);
        // Under the campaign locks, what is still HELD is final for this request.
        const existing = new Map<string, HoldRow>();
        for (const row of await liveHoldsLocked(tx, attemptKey)) if (inPlay(row.slot)) existing.set(row.slot, row);

        const held: HeldVoucher[] = [];
        const released: string[] = [];
        const pendingReleases: Array<{ hold: HoldRow; campaign: CampaignLock }> = [];
        const plan: Array<{ grant: VoucherHoldGrant; campaign: CampaignLock; old: HoldRow | null }> = [];

        if (request.releaseUnlisted === true || releaseSlots.size > 0) {
          for (const [slot, old] of existing) {
            if (grantSlots.has(slot) || (request.releaseUnlisted !== true && !releaseSlots.has(slot))) continue;
            const campaign = locks.get(old.campaignId);
            if (campaign) pendingReleases.push({ hold: old, campaign });
          }
        }

        for (const grant of request.grants) {
          const old = existing.get(grant.slot) ?? null;

          // Reuse: same campaign, revision, discount, digest and cart revision => the original hold, untouched.
          if (
            old !== null && old.campaignId === grant.campaignId && old.campaignRevision === grant.campaignRevision &&
            Number(old.heldDiscountVnd) === grant.discountVnd && old.quoteDigest === request.quoteDigest && Number(old.paidRevision) === request.paidRevision
          ) {
            held.push(toHeld(old, true));
            continue;
          }

          const campaign = locks.get(grant.campaignId);
          if (!campaign || campaign.pancakeShopId !== request.shopId || campaign.kind !== grant.kind || slotOfLock(campaign) !== grant.slot) throw fail("CAMPAIGN_NOT_FOUND", grant.kind, grant.campaignId);
          if (campaign.revision !== grant.campaignRevision) throw fail("CAMPAIGN_CHANGED", grant.kind, grant.campaignId);
          const lifecycle = deriveCampaignLifecycle({ isEnabled: campaign.isEnabled, enabledAt: campaign.enabledAt, disabledAt: campaign.disabledAt, startsAt: campaign.startsAt, endsAt: campaign.endsAt, now });
          if (lifecycle.status !== "ACTIVE") throw fail("CAMPAIGN_NOT_ACTIVE", grant.kind, grant.campaignId);

          // Capacity. Whatever THIS attempt already holds of the same campaign is its own: it is credited back.
          const own = old !== null && old.campaignId === campaign.id ? old : null;
          const creditUses = own ? 1 : 0;
          const creditVnd = own ? own.heldDiscountVnd : BigInt(0);
          const usedUses = campaign.redeemedUses + campaign.reservedUses - creditUses;
          const usedVnd = campaign.redeemedVnd + campaign.reservedVnd - creditVnd;
          if (campaign.maxUses !== null && usedUses + 1 > campaign.maxUses) throw fail("CAPACITY_EXHAUSTED", grant.kind, grant.campaignId);
          if (campaign.maxBudgetVnd !== null && usedVnd + BigInt(grant.discountVnd) > campaign.maxBudgetVnd) throw fail("CAPACITY_EXHAUSTED", grant.kind, grant.campaignId);
          plan.push({ grant, campaign, old });
        }

        // 4  every check passed: mutate. Releases first (the partial unique index allows one live hold per slot).
        for (const entry of pendingReleases) {
          await releaseHold(tx, entry.hold, entry.campaign, now);
          released.push(entry.hold.slot);
        }
        for (const { grant, campaign, old } of plan) {
          if (old !== null) {
            await releaseHold(tx, old, locks.get(old.campaignId)!, now);
            released.push(old.slot);
          }
          const inserted = await tx.$queryRaw<HoldRow[]>`
            INSERT INTO "VoucherHold" ("id", "campaignId", "campaignRevision", "pancakeShopId", "kind", "slot", "attemptKey", "quoteDigest", "paidRevision", "heldDiscountVnd", "state", "createdAt", "expiresAt")
            VALUES (${`vh_${crypto.randomUUID()}`}, ${campaign.id}, ${grant.campaignRevision}, ${request.shopId}, ${grant.kind}::"VoucherKind", ${grant.slot}, ${attemptKey}, ${request.quoteDigest},
                    ${BigInt(request.paidRevision)}, ${BigInt(grant.discountVnd)}, 'HELD', ${now}, ${now}::timestamptz + interval '10 minutes')
            RETURNING "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"`;
          await tx.$executeRaw`UPDATE "VoucherCampaign" SET "reservedUses" = "reservedUses" + 1, "reservedVnd" = "reservedVnd" + ${BigInt(grant.discountVnd)} WHERE "id" = ${campaign.id}`;
          campaign.reservedUses += 1;
          campaign.reservedVnd += BigInt(grant.discountVnd);
          held.push(toHeld(inserted[0]!, false));
        }
        const sorted = held.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
        if (afterGrant) {
          const afterRefusal = await afterGrant(tx, sorted);
          if (afterRefusal !== null) throw fail(afterRefusal);
        }
        const refusal = finalize ? finalize(sorted) : null;
        if (refusal !== null) throw fail(refusal);
        return { ok: true as const, holds: sorted, released };
      });
    } catch (error) {
      if (error instanceof HoldRollback) return error.result;
      throw error;
    }
  }

  /**
   * The live holds of this attempt (HELD and not past `expiresAt` by the database clock), for a preview that must
   * not lose an entitlement the buyer already holds. Read-only; ignores the feature gate like the other settle reads.
   */
  async function readOwnLiveHoldsIn(db: Pick<PrismaClient, "$queryRaw">, cartId: string): Promise<readonly Readonly<{ kind: VoucherGroup; slot: string; campaignId: string; campaignRevision: number; heldDiscountVnd: number }>[]> {
    const attemptKey = voucherAttemptKey(cartId, options.attemptSecret);
    const rows = await db.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' AND "expiresAt" > clock_timestamp() ORDER BY "slot"`;
    return rows.map((row) => ({ kind: row.kind, slot: row.slot, campaignId: row.campaignId, campaignRevision: row.campaignRevision, heldDiscountVnd: Number(row.heldDiscountVnd) }));
  }

  /** The same live holds with the facts a checkout must verify them against (what each promised and until when). */
  async function readOwnLiveHoldFactsIn(db: Pick<PrismaClient, "$queryRaw">, cartId: string): Promise<readonly Readonly<{
    kind: VoucherGroup; slot: string; campaignId: string; campaignRevision: number; heldDiscountVnd: number; quoteDigest: string; paidRevision: bigint; expiresAt: Date;
  }>[]> {
    const attemptKey = voucherAttemptKey(cartId, options.attemptSecret);
    const rows = await db.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' AND "expiresAt" > clock_timestamp() ORDER BY "slot"`;
    return rows.map((row) => ({ kind: row.kind, slot: row.slot, campaignId: row.campaignId, campaignRevision: row.campaignRevision, heldDiscountVnd: Number(row.heldDiscountVnd), quoteDigest: row.quoteDigest, paidRevision: BigInt(row.paidRevision), expiresAt: row.expiresAt }));
  }

  /**
   * Convenience sweeper: expires due holds so the table stays small. Correctness never depends on it (every
   * grant expires lazily under the campaign lock). Settle-like, so it ignores the feature gate. Returns the
   * number of holds expired.
   */
  async function sweepExpired(limit = 200): Promise<number> {
    const due = await client.$queryRaw<Array<{ campaignId: string }>>`
      SELECT DISTINCT "campaignId" FROM "VoucherHold" WHERE "state" = 'HELD' AND "expiresAt" <= clock_timestamp() LIMIT ${Math.max(1, Math.min(limit, 1000))}`;
    let total = 0;
    for (const { campaignId } of due.sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1))) {
      total += await client.$transaction(async (tx) => {
        const campaign = await lockCampaign(tx, campaignId);
        if (campaign === null) return 0;
        const before = campaign.reservedUses;
        await expireDue(tx, campaign, await databaseNow(tx));
        return before - campaign.reservedUses;
      });
    }
    return total;
  }

  /**
   * ADR 0019 D-3, the read half used at submit: the live hold of this attempt and slot iff it is HELD, not
   * past `expiresAt` by the DATABASE clock, and its facts equal the signed ones. The campaign's own state
   * (ended, disabled, edited, full) is deliberately not consulted: a held entitlement survives them (TG-05 A).
   */
  async function findHonourableHold(input: Readonly<{ cartId: string; slot: string; campaignId: string; campaignRevision: number; discountVnd: number; quoteDigest: string; paidRevision: number }>): Promise<HeldVoucher | null> {
    const attemptKey = voucherAttemptKey(input.cartId, options.attemptSecret);
    const rows = await client.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold"
      WHERE "attemptKey" = ${attemptKey} AND "slot" = ${input.slot} AND "state" = 'HELD' AND "expiresAt" > clock_timestamp()
        AND "campaignId" = ${input.campaignId} AND "campaignRevision" = ${input.campaignRevision}
        AND "heldDiscountVnd" = ${BigInt(input.discountVnd)} AND "quoteDigest" = ${input.quoteDigest} AND "paidRevision" = ${BigInt(input.paidRevision)}`;
    return rows[0] ? toHeld(rows[0], true) : null;
  }

  const readOwnLiveHolds = (cartId: string) => readOwnLiveHoldsIn(client, cartId);

  return { hold, sweepExpired, findHonourableHold, readOwnLiveHolds, readOwnLiveHoldsIn, readOwnLiveHoldFactsIn };
}

export type VoucherHoldService = ReturnType<typeof createVoucherHoldService>;
