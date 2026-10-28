import type { Prisma } from "../generated/prisma/client.ts";

import { deriveCampaignLifecycle, type CampaignLifecycleStatus } from "./promotion-campaign-lifecycle.ts";
import { validateVoucherCampaign, type VoucherCampaignValues } from "./voucher-rule-validation.ts";

/**
 * Voucher v1 (V05/V06): the domain view of one persisted campaign.
 *
 * `toVoucherCampaign` re-runs the same validation an Admin write goes through, so a row that no longer
 * satisfies the rules (hand-edited, or from a future writer) fails closed instead of being priced. Lifecycle
 * status is derived from the clock, never stored. The quota helpers are the one definition of "can this
 * campaign take one more use of N VND", shared by the read model, the hold service and the Admin floor.
 */

export const voucherCampaignSelection = {
  id: true,
  pancakeShopId: true,
  name: true,
  kind: true,
  issuance: true,
  visibility: true,
  code: true,
  typeId: true,
  type: { select: { id: true, name: true, priority: true, issuance: true, visibility: true, code: true } },
  discountType: true,
  fixedAmountVnd: true,
  percent: true,
  maxDiscountVnd: true,
  minEligibleSubtotalVnd: true,
  scopeMode: true,
  categoryKeys: true,
  includeProductIds: true,
  excludeProductIds: true,
  isEnabled: true,
  enabledAt: true,
  disabledAt: true,
  startsAt: true,
  endsAt: true,
  revision: true,
  maxUses: true,
  maxBudgetVnd: true,
  redeemedUses: true,
  redeemedVnd: true,
  reservedUses: true,
  reservedVnd: true,
} satisfies Prisma.VoucherCampaignSelect;

export type VoucherCampaignRow = Prisma.VoucherCampaignGetPayload<{ select: typeof voucherCampaignSelection }>;

/** The type a typed tier belongs to (ADR 0020): the unit that decides "only one voucher of this type". */
export type VoucherTypeRef = Readonly<{
  id: string;
  name: string;
  /** Application order across types, smaller first. */
  priority: number;
}>;

export type VoucherLedger = Readonly<{
  redeemedUses: number;
  redeemedVnd: number;
  reservedUses: number;
  reservedVnd: number;
}>;

export type VoucherCampaign = VoucherCampaignValues &
  VoucherLedger &
  Readonly<{
    id: string;
    pancakeShopId: number;
    revision: number;
    isEnabled: boolean;
    enabledAt: Date | null;
    disabledAt: Date | null;
    /** Present for a tier of a type; absent or null for a v1 campaign and for SHIPPING_FREE. */
    type?: VoucherTypeRef | null;
  }>;

/** The one-per-checkout key of a campaign (ADR 0020 D-1). */
export function voucherSlotOf(campaign: Readonly<{ kind: "MERCHANDISE" | "SHIPPING_FREE"; type?: VoucherTypeRef | null }>): string {
  if (campaign.kind === "SHIPPING_FREE") return "SHIPPING_FREE";
  return campaign.type ? `MERCHANDISE:${campaign.type.id}` : "MERCHANDISE";
}

function toSafeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError("Persisted voucher amount is outside the safe range");
  return number;
}

/** The validation input an Admin form would send for this row; the inverse of the write mapping. */
export function voucherRowToInput(row: VoucherCampaignRow): Record<string, unknown> {
  // A tier owns neither a code nor its own distribution: it reads them from its type, and a copy that disagrees with
  // the type is a corrupt row, which validation then refuses (the database keeps them equal by trigger).
  const type = row.type;
  const typeAgrees = type === null || (type.issuance === row.issuance && type.visibility === row.visibility && row.code === null);
  const discount =
    row.kind === "SHIPPING_FREE"
      ? null
      : row.discountType === "FIXED_AMOUNT_VND"
        ? { type: "FIXED_AMOUNT_VND", amountVnd: toSafeNumber(row.fixedAmountVnd) }
        : { type: "PERCENTAGE", percent: row.percent, maxDiscountVnd: toSafeNumber(row.maxDiscountVnd) };
  return {
    name: row.name,
    kind: row.kind,
    issuance: row.issuance,
    visibility: typeAgrees ? row.visibility : "INVALID",
    code: type === null ? row.code : type.code,
    discount,
    minEligibleSubtotalVnd: toSafeNumber(row.minEligibleSubtotalVnd),
    scope:
      row.scopeMode === "ALL_SHOP"
        ? { mode: "ALL_SHOP", excludeProductIds: row.excludeProductIds }
        : { mode: "TARGETED", categoryKeys: row.categoryKeys, includeProductIds: row.includeProductIds, excludeProductIds: row.excludeProductIds },
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    maxUses: row.maxUses,
    maxBudgetVnd: toSafeNumber(row.maxBudgetVnd),
  };
}

export function toVoucherCampaign(row: VoucherCampaignRow): VoucherCampaign {
  const parsed = validateVoucherCampaign(voucherRowToInput(row));
  if (!parsed.ok) throw new RangeError("Invalid persisted voucher campaign");
  if ((row.typeId === null) !== (row.type === null) || (row.type !== null && row.kind !== "MERCHANDISE")) throw new RangeError("Invalid persisted voucher tier");
  return Object.freeze({
    ...parsed.value,
    type: row.type === null ? null : Object.freeze({ id: row.type.id, name: row.type.name, priority: row.type.priority }),
    id: row.id,
    pancakeShopId: row.pancakeShopId,
    revision: row.revision,
    isEnabled: row.isEnabled,
    enabledAt: row.enabledAt,
    disabledAt: row.disabledAt,
    redeemedUses: row.redeemedUses,
    redeemedVnd: toSafeNumber(row.redeemedVnd) ?? 0,
    reservedUses: row.reservedUses,
    reservedVnd: toSafeNumber(row.reservedVnd) ?? 0,
  });
}

export function voucherLifecycleStatus(campaign: VoucherCampaign, now: Date): CampaignLifecycleStatus {
  return deriveCampaignLifecycle({
    isEnabled: campaign.isEnabled,
    enabledAt: campaign.enabledAt,
    disabledAt: campaign.disabledAt,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    now,
  }).status;
}

export type VoucherAvailability = "AVAILABLE" | "EXHAUSTED";

/** What is still free to grant: `null` means unlimited on that axis. Never negative. */
export function voucherRemaining(campaign: VoucherCampaign): Readonly<{ uses: number | null; vnd: number | null }> {
  const committedUses = campaign.redeemedUses + campaign.reservedUses;
  const committedVnd = campaign.redeemedVnd + campaign.reservedVnd;
  return {
    uses: campaign.maxUses === null ? null : Math.max(0, campaign.maxUses - committedUses),
    vnd: campaign.maxBudgetVnd === null ? null : Math.max(0, campaign.maxBudgetVnd - committedVnd),
  };
}

/** One more use of `discountVnd` fits under both caps. */
export function canGrantVoucher(campaign: VoucherCampaign, discountVnd: number): boolean {
  const remaining = voucherRemaining(campaign);
  return (remaining.uses === null || remaining.uses >= 1) && (remaining.vnd === null || remaining.vnd >= discountVnd);
}

/**
 * Whether a campaign shows as takeable. A budget smaller than any one grant cannot be read here (the grant
 * size depends on the cart), so only the uses axis and an empty budget mark it exhausted; the exact budget
 * test happens per candidate through `canGrantVoucher`.
 */
export function voucherAvailability(campaign: VoucherCampaign): VoucherAvailability {
  const remaining = voucherRemaining(campaign);
  return (remaining.uses !== null && remaining.uses < 1) || (remaining.vnd !== null && remaining.vnd < 1) ? "EXHAUSTED" : "AVAILABLE";
}

/**
 * The minimum a cap may be set to without cutting under what is committed (spec §3.1, TG-05 A): consumed and
 * not refunded plus every live hold. Equal to the floor is allowed; below it is refused.
 */
export function voucherCapFloor(campaign: VoucherLedger): Readonly<{ uses: number; vnd: number }> {
  return { uses: campaign.redeemedUses + campaign.reservedUses, vnd: campaign.redeemedVnd + campaign.reservedVnd };
}
