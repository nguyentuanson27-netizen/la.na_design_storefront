import { SHIPPING_CAMPAIGN_LOCK_NAMESPACE } from "./shipping-campaign-lock.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { keepStoredInstantIfUnchangedAtMinute } from "./gift-quantity-admin-input.ts";
import { shippingCampaignSelection, toShippingCampaign } from "./shipping-campaign-repository.ts";
import { MAX_SHIPPING_CAMPAIGNS, validateShippingCampaign, type ShippingCampaignIssue, type ShippingCampaignValues } from "./shipping-campaign.ts";

type Session = { user: { id: string; role?: string | null }; session: { id: string } } | null | undefined;
export type ShippingAdminReason = ShippingCampaignIssue | "NOT_FOUND" | "STALE_REVISION" | "TARGET_INVALID" | "LIMIT_REACHED" | "WINDOW_ENDED";
export type ShippingAdminResult = { ok: true; id: string } | { ok: false; reason: ShippingAdminReason };
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

function columns(value: ShippingCampaignValues) {
  return { name: value.name, startsAt: value.startsAt, endsAt: value.endsAt,
    minimumQuantity: value.minimumQuantity, priority: value.priority, stackingEnabled: value.stackingEnabled,
    categoryKeys: [...value.scope.categoryKeys], includeProductIds: [...value.scope.includeProductIds],
    excludeProductIds: [...value.scope.excludeProductIds] };
}

export function createShippingCampaignAdminService(client: PrismaClient, shopId: number) {
  function authorize(session: Session, now: Date) {
    requireAdminSession(session);
    if (!Number.isInteger(shopId) || shopId < 1 || shopId > 2_147_483_647 || !Number.isFinite(now.getTime())) throw new RangeError("Invalid shipping admin context");
  }
  async function lock(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SHIPPING_CAMPAIGN_LOCK_NAMESPACE}, ${shopId})`;
  }
  async function validTargets(tx: Prisma.TransactionClient, value: ShippingCampaignValues) {
    const ids = [...new Set([...value.scope.includeProductIds, ...value.scope.excludeProductIds])];
    if (ids.length === 0) return true;
    const products = await tx.productMirror.findMany({ where: { id: { in: ids }, pancakeShopId: shopId }, select: { id: true } });
    return products.length === ids.length;
  }
  async function create(session: Session, input: unknown, now = new Date()): Promise<ShippingAdminResult> {
    authorize(session, now);
    const parsed = validateShippingCampaign(input);
    if (!parsed.ok) return parsed;
    return client.$transaction(async (tx) => {
      if (!await validTargets(tx, parsed.value)) return { ok: false, reason: "TARGET_INVALID" };
      const row = await tx.shippingPromotionCampaign.create({ data: { ...columns(parsed.value), pancakeShopId: shopId, isEnabled: false }, select: { id: true } });
      return { ok: true, id: row.id };
    });
  }
  async function edit(session: Session, id: string, revision: number, input: unknown, now = new Date()): Promise<ShippingAdminResult> {
    authorize(session, now);
    const parsed = validateShippingCampaign(input);
    if (!parsed.ok) return parsed;
    if (!idPattern.test(id)) return { ok: false, reason: "NOT_FOUND" };
    if (!Number.isInteger(revision) || revision < 1 || revision >= 2_147_483_647) return { ok: false, reason: "STALE_REVISION" };
    return client.$transaction(async (tx) => {
      await lock(tx);
      const old = await tx.shippingPromotionCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: shippingCampaignSelection });
      if (!old) return { ok: false, reason: "NOT_FOUND" };
      if (old.revision !== revision) return { ok: false, reason: "STALE_REVISION" };
      if (!await validTargets(tx, parsed.value)) return { ok: false, reason: "TARGET_INVALID" };
      const value = { ...parsed.value,
        startsAt: keepStoredInstantIfUnchangedAtMinute(parsed.value.startsAt, old.startsAt),
        endsAt: keepStoredInstantIfUnchangedAtMinute(parsed.value.endsAt, old.endsAt) };
      const rechecked = validateShippingCampaign(value);
      if (!rechecked.ok) return rechecked;
      const result = await tx.shippingPromotionCampaign.updateMany({ where: { id, pancakeShopId: shopId, revision }, data: { ...columns(rechecked.value), revision: { increment: 1 } } });
      return result.count === 1 ? { ok: true, id } : { ok: false, reason: "STALE_REVISION" };
    });
  }
  async function setEnabled(session: Session, id: string, revision: number, enabled: boolean, now = new Date()): Promise<ShippingAdminResult> {
    authorize(session, now);
    if (!idPattern.test(id)) return { ok: false, reason: "NOT_FOUND" };
    if (!Number.isInteger(revision) || revision < 1 || revision >= 2_147_483_647) return { ok: false, reason: "STALE_REVISION" };
    if (typeof enabled !== "boolean") throw new RangeError("Invalid shipping enable state");
    return client.$transaction(async (tx) => {
      await lock(tx);
      const row = await tx.shippingPromotionCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: shippingCampaignSelection });
      if (!row) return { ok: false, reason: "NOT_FOUND" };
      if (row.revision !== revision) return { ok: false, reason: "STALE_REVISION" };
      if (enabled) {
        const campaign = toShippingCampaign(row);
        if (campaign.endsAt !== null && campaign.endsAt <= now) return { ok: false, reason: "WINDOW_ENDED" };
        if (!await validTargets(tx, campaign)) return { ok: false, reason: "TARGET_INVALID" };
        // Count scheduled campaigns too: enabling future windows cannot exceed the bounded reader later.
        const count = await tx.shippingPromotionCampaign.count({ where: { pancakeShopId: shopId, isEnabled: true, id: { not: id } } });
        if (count >= MAX_SHIPPING_CAMPAIGNS) return { ok: false, reason: "LIMIT_REACHED" };
      }
      const result = await tx.shippingPromotionCampaign.updateMany({ where: { id, pancakeShopId: shopId, revision }, data: {
        isEnabled: enabled, enabledAt: enabled ? now : row.enabledAt, disabledAt: enabled ? null : now, revision: { increment: 1 },
      } });
      return result.count === 1 ? { ok: true, id } : { ok: false, reason: "STALE_REVISION" };
    });
  }
  async function list(session: Session, beforeId?: string) {
    authorize(session, new Date());
    if (beforeId !== undefined && !idPattern.test(beforeId)) throw new RangeError("Invalid shipping cursor");
    return client.shippingPromotionCampaign.findMany({ where: { pancakeShopId: shopId, ...(beforeId ? { id: { lt: beforeId } } : {}) }, select: shippingCampaignSelection, orderBy: { id: "desc" }, take: 21 });
  }
  async function get(session: Session, id: string) {
    authorize(session, new Date());
    if (!idPattern.test(id)) return null;
    return client.shippingPromotionCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: shippingCampaignSelection });
  }
  return { create, edit, setEnabled, list, get };
}
