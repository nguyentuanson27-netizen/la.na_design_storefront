import type { Prisma } from "../generated/prisma/client.ts";

import {
  toVoucherCampaign,
  voucherAvailability,
  voucherCampaignSelection,
  voucherLifecycleStatus,
  type VoucherAvailability,
  type VoucherCampaign,
} from "./voucher-campaign.ts";
import { canIssueNewVouchers } from "./voucher-gate.ts";
import { normalizeVoucherCode } from "./voucher-rule-validation.ts";

/**
 * Voucher v1 (V05): the shop-scoped, bounded, read-only candidate model.
 *
 * Gated first: with `LA_VOUCHER_ENABLED` OFF it returns nothing without touching the database. Every read is
 * scoped to one shop in the query itself, bounded before hydration (more rows than the bound fails closed
 * rather than silently dropping a campaign), and idempotent -- nothing here holds, reserves or renews anything
 * (spec §5.1: read and render never mutate).
 *
 * PRIVATE campaigns are never listed. They can only be reached by their code, and every way a code can fail --
 * unknown, other shop, wrong case that is not a code, expired, disabled, not started, a private one that is used
 * up -- answers with the same `INVALID_CODE`, so the response does not reveal which private codes exist. The
 * caller owns rate limiting (V15).
 */

export const MAX_VOUCHER_CANDIDATES = 50;
export const MAX_VOUCHER_SELECTION_LOOKUP = 4;

export type VoucherReadClient = Pick<Prisma.TransactionClient, "voucherCampaign" | "voucherHold">;

function assertShopId(shopId: number): void {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > 2_147_483_647) throw new RangeError("Invalid voucher shop");
}

function assertClock(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("Invalid voucher clock");
}

const activeWindow = (now: Date): Prisma.VoucherCampaignWhereInput => ({
  isEnabled: true,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
});

/** What a shopper may see about a voucher. No internal budget, no ledger counters, and a code only if public. */
export type VoucherCard = Readonly<{
  id: string;
  kind: VoucherCampaign["kind"];
  name: string;
  revision: number;
  discount: VoucherCampaign["discount"];
  minEligibleSubtotalVnd: number | null;
  endsAt: Date | null;
  availability: VoucherAvailability;
  /** Present only for PUBLIC + CODE vouchers. A PRIVATE code is never echoed back by a list. */
  publicCode: string | null;
}>;

export function toVoucherCard(campaign: VoucherCampaign): VoucherCard {
  return Object.freeze({
    id: campaign.id,
    kind: campaign.kind,
    name: campaign.name,
    revision: campaign.revision,
    discount: campaign.discount,
    minEligibleSubtotalVnd: campaign.minEligibleSubtotalVnd,
    endsAt: campaign.endsAt,
    availability: voucherAvailability(campaign),
    publicCode: campaign.visibility === "PUBLIC" && campaign.issuance === "CODE" ? campaign.code : null,
  });
}

/** Active PUBLIC campaigns of one shop (AUTO and public CODE), in a stable order. */
export async function readPublicVoucherCandidates(input: Readonly<{
  client: VoucherReadClient;
  shopId: number;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<readonly VoucherCampaign[]> {
  const { client, shopId, now } = input;
  assertShopId(shopId);
  assertClock(now);
  if (!canIssueNewVouchers(input.env ?? process.env)) return [];
  const rows = await client.voucherCampaign.findMany({
    where: { pancakeShopId: shopId, visibility: "PUBLIC", ...activeWindow(now) },
    select: voucherCampaignSelection,
    orderBy: [{ kind: "asc" }, { id: "asc" }],
    take: MAX_VOUCHER_CANDIDATES + 1,
  });
  if (rows.length > MAX_VOUCHER_CANDIDATES) throw new RangeError("Voucher candidate read exceeds its bound");
  return rows.map(toVoucherCampaign).filter((campaign) => voucherLifecycleStatus(campaign, now) === "ACTIVE");
}

export type VoucherCodeLookup =
  | Readonly<{ ok: true; campaign: VoucherCampaign }>
  | Readonly<{ ok: false; reason: "INVALID_CODE" | "VOUCHER_UNAVAILABLE" }>;

/**
 * Resolves a typed or linked code. `VOUCHER_UNAVAILABLE` (used up) is only ever returned for a PUBLIC code, whose
 * existence is already visible in the list; a PRIVATE code that cannot be used answers `INVALID_CODE`.
 */
export async function lookupVoucherCode(input: Readonly<{
  client: VoucherReadClient;
  shopId: number;
  rawCode: unknown;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<VoucherCodeLookup> {
  const { client, shopId, now } = input;
  assertShopId(shopId);
  assertClock(now);
  if (!canIssueNewVouchers(input.env ?? process.env)) return { ok: false, reason: "INVALID_CODE" };
  const code = normalizeVoucherCode(input.rawCode);
  if (code === null) return { ok: false, reason: "INVALID_CODE" };
  const row = await client.voucherCampaign.findFirst({
    where: { pancakeShopId: shopId, code, issuance: "CODE", ...activeWindow(now) },
    select: voucherCampaignSelection,
  });
  if (row === null) return { ok: false, reason: "INVALID_CODE" };
  const campaign = toVoucherCampaign(row);
  if (voucherLifecycleStatus(campaign, now) !== "ACTIVE") return { ok: false, reason: "INVALID_CODE" };
  if (voucherAvailability(campaign) === "EXHAUSTED") {
    return { ok: false, reason: campaign.visibility === "PUBLIC" ? "VOUCHER_UNAVAILABLE" : "INVALID_CODE" };
  }
  return { ok: true, campaign };
}

/**
 * Re-reads the campaigns a cart's saved selection points at, so a stale id is revalidated against the live row
 * (a PRIVATE campaign is allowed here: the selection is server-held and was validated when the code was entered).
 * Missing, disabled or expired ids are simply absent from the result.
 */
export async function readSelectedVouchers(input: Readonly<{
  client: VoucherReadClient;
  shopId: number;
  ids: readonly string[];
  now: Date;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<readonly VoucherCampaign[]> {
  const { client, shopId, now } = input;
  assertShopId(shopId);
  assertClock(now);
  const ids = [...new Set(input.ids)];
  if (ids.length > MAX_VOUCHER_SELECTION_LOOKUP || ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 64)) {
    throw new RangeError("Invalid voucher selection lookup");
  }
  if (ids.length === 0 || !canIssueNewVouchers(input.env ?? process.env)) return [];
  const rows = await client.voucherCampaign.findMany({
    where: { id: { in: ids }, pancakeShopId: shopId, ...activeWindow(now) },
    select: voucherCampaignSelection,
  });
  return rows.map(toVoucherCampaign).filter((campaign) => voucherLifecycleStatus(campaign, now) === "ACTIVE");
}

export type HeldVoucher = Readonly<{
  holdId: string;
  expiresAt: Date;
  heldDiscountVnd: number;
  campaignRevision: number;
  quoteDigest: string;
  paidRevision: bigint;
  campaign: VoucherCampaign;
}>;

/**
 * The attempt's own still-valid holds, whatever the campaign's lifecycle is now. This deliberately does NOT
 * consult the feature gate or the campaign's current state (spec §5.1, EX-08, AC-31, AC-47): a hold the shopper
 * already owns stays recognisable after the campaign expires, is disabled, or the flag goes OFF. It reads holds
 * only; it never extends, renews or releases one.
 */
export async function readOwnHeldVouchers(input: Readonly<{
  client: VoucherReadClient;
  shopId: number;
  attemptKey: string;
  now: Date;
}>): Promise<readonly HeldVoucher[]> {
  const { client, shopId, attemptKey, now } = input;
  assertShopId(shopId);
  assertClock(now);
  if (!/^[0-9a-f]{64}$/.test(attemptKey)) throw new RangeError("Invalid voucher attempt key");
  const holds = await client.voucherHold.findMany({
    where: { attemptKey, pancakeShopId: shopId, state: "HELD", expiresAt: { gt: now } },
    select: {
      id: true,
      expiresAt: true,
      heldDiscountVnd: true,
      campaignRevision: true,
      quoteDigest: true,
      paidRevision: true,
      campaign: { select: voucherCampaignSelection },
    },
    orderBy: [{ kind: "asc" }, { id: "asc" }],
    take: 3,
  });
  return holds.map((hold) => ({
    holdId: hold.id,
    expiresAt: hold.expiresAt,
    heldDiscountVnd: Number(hold.heldDiscountVnd),
    campaignRevision: hold.campaignRevision,
    quoteDigest: hold.quoteDigest,
    paidRevision: hold.paidRevision,
    campaign: toVoucherCampaign(hold.campaign),
  }));
}
