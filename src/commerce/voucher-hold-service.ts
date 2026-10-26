import { createHmac } from "node:crypto";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";
import { canIssueNewVouchers, readVoucherVerifiedShopIds } from "./voucher-gate.ts";

/**
 * Voucher v1 (V11, ADR 0019 D-1/D-2/D-3): the atomic 10-minute hold.
 *
 * The database already enforces the invariants (absolute TTL, one live hold per attempt and kind, quota floor,
 * no early expiry, no late consume). This module only SEQUENCES them:
 *
 *   BEGIN; lock the cart row; lock the chosen campaigns FOR UPDATE in ascending id order; lazily expire due
 *   holds of those campaigns (their uses and VND go back); for each requested voucher reuse / swap / grant;
 *   insert with createdAt and expiresAt from ONE database timestamp; COMMIT.
 *
 * All requested vouchers of a call succeed or none does: a combination is quoted as a pair, so a half-granted
 * pair would be a different total than the one the buyer saw. A failed swap therefore leaves the old hold
 * exactly as it was (AC-34). Nothing here is reachable from a GET; V12 owns the intentional POST. The settle
 * path (consume, release by order, refund) is V13/V14 and never consults the feature gate.
 */

export type VoucherGroup = "MERCHANDISE" | "SHIPPING_FREE";

export type VoucherHoldGrant = Readonly<{
  kind: VoucherGroup;
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
  /** Groups this attempt must no longer hold (explicit NONE, or a combination without that group). */
  releaseKinds?: readonly VoucherGroup[];
}>;

export type HeldVoucher = Readonly<{
  holdId: string;
  kind: VoucherGroup;
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
  /** The `finalize` step (issuing the proof) could not complete, so the whole call was rolled back. */
  | "PROOF_UNAVAILABLE";

export type VoucherHoldResult =
  | Readonly<{ ok: true; holds: readonly HeldVoucher[]; released: readonly VoucherGroup[] }>
  | Readonly<{ ok: false; reason: VoucherHoldFailureReason; kind: VoucherGroup | null; campaignId: string | null }>;

const MAX_DISCOUNT_VND = 100_000_000_000;
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
  quoteDigest: string;
  paidRevision: bigint;
  heldDiscountVnd: bigint;
  createdAt: Date;
  expiresAt: Date;
};

const KINDS: readonly VoucherGroup[] = ["MERCHANDISE", "SHIPPING_FREE"];

function toHeld(row: HoldRow, reused: boolean): HeldVoucher {
  return Object.freeze({
    holdId: row.id,
    kind: row.kind,
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
  const release = request.releaseKinds ?? [];
  if (!Array.isArray(request.grants) || !Array.isArray(release) || request.grants.length + release.length === 0) return false;
  const seen = new Set<string>();
  for (const grant of request.grants) {
    if (grant === null || typeof grant !== "object" || !KINDS.includes(grant.kind) || seen.has(grant.kind)) return false;
    seen.add(grant.kind);
    if (typeof grant.campaignId !== "string" || grant.campaignId.length === 0 || grant.campaignId.length > 64) return false;
    if (!Number.isSafeInteger(grant.campaignRevision) || grant.campaignRevision <= 0) return false;
    if (!Number.isSafeInteger(grant.discountVnd) || grant.discountVnd < 1 || grant.discountVnd > MAX_DISCOUNT_VND) return false;
  }
  for (const kind of release) {
    if (!KINDS.includes(kind) || seen.has(kind)) return false;
    seen.add(kind);
  }
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
      SELECT "id", "pancakeShopId", "kind", "isEnabled", "enabledAt", "disabledAt", "startsAt", "endsAt", "revision",
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

  async function liveHold(tx: Prisma.TransactionClient, attemptKey: string, kind: VoucherGroup): Promise<HoldRow | null> {
    const rows = await tx.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "kind"::text = ${kind} AND "state" = 'HELD'`;
    return rows[0] ?? null;
  }

  /** Only after the campaign locks are held: campaign row first, hold rows second, the same order as the sweeper. */
  async function liveHoldLocked(tx: Prisma.TransactionClient, attemptKey: string, kind: VoucherGroup): Promise<HoldRow | null> {
    const rows = await tx.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "kind"::text = ${kind} AND "state" = 'HELD' FOR UPDATE`;
    return rows[0] ?? null;
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
    /**
     * Runs INSIDE the transaction after every hold exists and before COMMIT. Returning a reason rolls everything
     * back (a swap keeps its old hold, nothing is reserved): a buyer never ends up with quota held and no proof
     * to spend it with.
     */
    finalize?: (holds: readonly HeldVoucher[]) => VoucherHoldFailureReason | null,
  ): Promise<VoucherHoldResult> {
    if (!validRequest(request)) return { ok: false, reason: "INVALID_REQUEST", kind: null, campaignId: null };
    const releaseKinds = request.releaseKinds ?? [];
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

        // 2  every campaign involved (requested, or already held for a group in play), ascending id. The hold
        //    rows are only peeked at here (a hold's campaign never changes, and only this cart's lock creates one);
        //    they are locked after the campaigns so no path takes hold-then-campaign.
        const inPlay = KINDS.filter((kind) => request.grants.some((g) => g.kind === kind) || releaseKinds.includes(kind));
        const peeked: HoldRow[] = [];
        for (const kind of inPlay) {
          const row = await liveHold(tx, attemptKey, kind);
          if (row !== null) peeked.push(row);
        }
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
        const existing = new Map<VoucherGroup, HoldRow | null>();
        for (const kind of inPlay) existing.set(kind, await liveHoldLocked(tx, attemptKey, kind));

        const held: HeldVoucher[] = [];
        const released: VoucherGroup[] = [];
        const pendingReleases: Array<{ hold: HoldRow; campaign: CampaignLock }> = [];
        const plan: Array<{ grant: VoucherHoldGrant; campaign: CampaignLock; old: HoldRow | null }> = [];

        for (const kind of releaseKinds) {
          const old = existing.get(kind) ?? null;
          if (old === null) continue;
          const campaign = locks.get(old.campaignId);
          if (campaign) pendingReleases.push({ hold: old, campaign });
        }

        for (const grant of request.grants) {
          const old = existing.get(grant.kind) ?? null;

          // Reuse: same campaign, revision, discount, digest and cart revision => the original hold, untouched.
          if (
            old !== null && old.campaignId === grant.campaignId && old.campaignRevision === grant.campaignRevision &&
            Number(old.heldDiscountVnd) === grant.discountVnd && old.quoteDigest === request.quoteDigest && Number(old.paidRevision) === request.paidRevision
          ) {
            held.push(toHeld(old, true));
            continue;
          }

          const campaign = locks.get(grant.campaignId);
          if (!campaign || campaign.pancakeShopId !== request.shopId || campaign.kind !== grant.kind) throw fail("CAMPAIGN_NOT_FOUND", grant.kind, grant.campaignId);
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

        // 4  every check passed: mutate. Releases first (the partial unique index allows one live hold per kind).
        for (const entry of pendingReleases) {
          await releaseHold(tx, entry.hold, entry.campaign, now);
          released.push(entry.hold.kind);
        }
        for (const { grant, campaign, old } of plan) {
          if (old !== null) {
            await releaseHold(tx, old, locks.get(old.campaignId)!, now);
            released.push(old.kind);
          }
          const inserted = await tx.$queryRaw<HoldRow[]>`
            INSERT INTO "VoucherHold" ("id", "campaignId", "campaignRevision", "pancakeShopId", "kind", "attemptKey", "quoteDigest", "paidRevision", "heldDiscountVnd", "state", "createdAt", "expiresAt")
            VALUES (${`vh_${crypto.randomUUID()}`}, ${campaign.id}, ${grant.campaignRevision}, ${request.shopId}, ${grant.kind}::"VoucherKind", ${attemptKey}, ${request.quoteDigest},
                    ${BigInt(request.paidRevision)}, ${BigInt(grant.discountVnd)}, 'HELD', ${now}, ${now}::timestamptz + interval '10 minutes')
            RETURNING "id", "campaignId", "campaignRevision", "kind", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"`;
          await tx.$executeRaw`UPDATE "VoucherCampaign" SET "reservedUses" = "reservedUses" + 1, "reservedVnd" = "reservedVnd" + ${BigInt(grant.discountVnd)} WHERE "id" = ${campaign.id}`;
          campaign.reservedUses += 1;
          campaign.reservedVnd += BigInt(grant.discountVnd);
          held.push(toHeld(inserted[0]!, false));
        }
        const sorted = held.sort((a, b) => a.kind.localeCompare(b.kind));
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
  async function readOwnLiveHolds(cartId: string): Promise<readonly Readonly<{ kind: VoucherGroup; campaignId: string; campaignRevision: number; heldDiscountVnd: number }>[]> {
    const attemptKey = voucherAttemptKey(cartId, options.attemptSecret);
    const rows = await client.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' AND "expiresAt" > clock_timestamp()`;
    return rows.map((row) => ({ kind: row.kind, campaignId: row.campaignId, campaignRevision: row.campaignRevision, heldDiscountVnd: Number(row.heldDiscountVnd) }));
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
   * ADR 0019 D-3, the read half used at submit: the live hold of this attempt and group iff it is HELD, not
   * past `expiresAt` by the DATABASE clock, and its facts equal the signed ones. The campaign's own state
   * (ended, disabled, edited, full) is deliberately not consulted: a held entitlement survives them (TG-05 A).
   */
  async function findHonourableHold(input: Readonly<{ cartId: string; kind: VoucherGroup; campaignId: string; campaignRevision: number; discountVnd: number; quoteDigest: string; paidRevision: number }>): Promise<HeldVoucher | null> {
    const attemptKey = voucherAttemptKey(input.cartId, options.attemptSecret);
    const rows = await client.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "kind", "quoteDigest", "paidRevision", "heldDiscountVnd", "createdAt", "expiresAt"
      FROM "VoucherHold"
      WHERE "attemptKey" = ${attemptKey} AND "kind"::text = ${input.kind} AND "state" = 'HELD' AND "expiresAt" > clock_timestamp()
        AND "campaignId" = ${input.campaignId} AND "campaignRevision" = ${input.campaignRevision}
        AND "heldDiscountVnd" = ${BigInt(input.discountVnd)} AND "quoteDigest" = ${input.quoteDigest} AND "paidRevision" = ${BigInt(input.paidRevision)}`;
    return rows[0] ? toHeld(rows[0], true) : null;
  }

  return { hold, sweepExpired, findHonourableHold, readOwnLiveHolds };
}

export type VoucherHoldService = ReturnType<typeof createVoucherHoldService>;
