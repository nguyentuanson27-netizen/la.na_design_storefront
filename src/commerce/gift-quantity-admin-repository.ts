/**
 * Bounded reads for the gift / quantity-tier admin surface (GQ05). Read-only: every mutation goes
 * through `gift-quantity-admin-service.ts` or `gift-quantity-activation-service.ts`.
 *
 * Lifecycle is derived from persisted intent plus the caller's instant, never stored, so a window
 * that opened while nobody was looking is reported correctly on the next load.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";

import { readMembershipSnapshot } from "./gift-quantity-activation-service.ts";
import {
  computeFrozenProductIds,
  FIXED_PRODUCT_SET,
  validateScopeConfig,
  type ScopeConfig,
} from "./gift-quantity-scope.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import { MAX_ADMIN_PROMOTION_PAGE_SIZE, parseAdminPromotionPageSize } from "./promotion-admin-feedback.ts";
import { deriveCampaignLifecycle, type CampaignLifecycleStatus } from "./promotion-campaign-lifecycle.ts";

const MAX_ADMIN_SEARCH_LENGTH = 120;
/** How many product names a preview or a frozen summary shows. */
export const ADMIN_SCOPE_PREVIEW_NAMES = 20;

export type AdminGiftQuantityCampaignRow = Readonly<{
  id: string;
  name: string;
  kind: "GIFT_ITEM" | "QUANTITY_TIER";
  status: CampaignLifecycleStatus;
  canReEnable: boolean;
  isTerminal: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  scopeMode: "GLOBAL_ALL_PAID_LINES" | "DYNAMIC_CATEGORY" | "FIXED_PRODUCT_SET";
  categoryCount: number;
  includeCount: number;
  excludeCount: number;
  frozenAt: Date | null;
  revision: number;
}>;

export type AdminProductRef = Readonly<{ id: string; name: string }>;

export type AdminGiftQuantityCampaignDetail = AdminGiftQuantityCampaignRow &
  Readonly<{
    giftTrigger: "QUANTITY" | "ORDER_SUBTOTAL" | null;
    subtotalScope: "ALL_PAID_LINES" | "ELIGIBLE_PAID_LINES" | null;
    categoryKeys: readonly string[];
    includes: readonly AdminProductRef[];
    excludes: readonly AdminProductRef[];
    /** Fixed scopes: the frozen set as audited at publish. */
    frozenCount: number;
    frozenPreview: readonly AdminProductRef[];
  }>;

export type AdminScopePreview =
  | Readonly<{ kind: "GLOBAL"; message: "ALL_PAID_LINES" }>
  | Readonly<{ kind: "COUNT"; matchCount: number; names: readonly AdminProductRef[]; frozenAtPublish: boolean }>
  | Readonly<{ kind: "INVALID"; codes: readonly string[] }>
  | Readonly<{ kind: "UNAVAILABLE"; code: string }>;

export function createGiftQuantityAdminRepository(client: PrismaClient) {
  async function listCampaigns({
    search,
    pageSize = MAX_ADMIN_PROMOTION_PAGE_SIZE,
    now = new Date(),
  }: Readonly<{ search?: string | null; pageSize?: number; now?: Date }> = {}): Promise<readonly AdminGiftQuantityCampaignRow[]> {
    const take = parseAdminPromotionPageSize(pageSize);
    const trimmed = typeof search === "string" ? search.trim().slice(0, MAX_ADMIN_SEARCH_LENGTH) : "";
    const rows = await client.giftQuantityCampaign.findMany({
      where: trimmed.length > 0 ? { name: { contains: trimmed, mode: "insensitive" } } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take,
      select: {
        id: true, name: true, kind: true, startsAt: true, endsAt: true, isEnabled: true, enabledAt: true, disabledAt: true,
        scopeMode: true, categoryKeys: true, frozenAt: true, revision: true,
        targets: { select: { role: true } },
      },
    });
    return rows.map((row): AdminGiftQuantityCampaignRow => {
      const lifecycle = deriveCampaignLifecycle({ ...row, now });
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        status: lifecycle.status,
        canReEnable: lifecycle.canReEnable,
        isTerminal: lifecycle.isTerminal,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        scopeMode: row.scopeMode,
        categoryCount: row.categoryKeys.length,
        includeCount: row.targets.filter((target) => target.role === "INCLUDE").length,
        excludeCount: row.targets.filter((target) => target.role === "EXCLUDE").length,
        frozenAt: row.frozenAt,
        revision: row.revision,
      };
    });
  }

  async function getCampaignForEdit(campaignId: string, now: Date = new Date()): Promise<AdminGiftQuantityCampaignDetail | null> {
    if (!isBoundedPromotionIdentifier(campaignId)) return null;
    const row = await client.giftQuantityCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, name: true, kind: true, startsAt: true, endsAt: true, isEnabled: true, enabledAt: true, disabledAt: true,
        scopeMode: true, categoryKeys: true, frozenAt: true, revision: true, giftTrigger: true, subtotalScope: true,
        targets: { select: { role: true, product: { select: { id: true, name: true } } }, orderBy: { productId: "asc" } },
      },
    });
    if (row === null) return null;

    const [frozenCount, frozenRows] = await Promise.all([
      client.giftQuantityFrozenProduct.count({ where: { campaignId } }),
      client.giftQuantityFrozenProduct.findMany({
        where: { campaignId },
        orderBy: { productId: "asc" },
        take: ADMIN_SCOPE_PREVIEW_NAMES,
        select: { product: { select: { id: true, name: true } } },
      }),
    ]);

    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: lifecycle.status,
      canReEnable: lifecycle.canReEnable,
      isTerminal: lifecycle.isTerminal,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      scopeMode: row.scopeMode,
      categoryCount: row.categoryKeys.length,
      includeCount: row.targets.filter((target) => target.role === "INCLUDE").length,
      excludeCount: row.targets.filter((target) => target.role === "EXCLUDE").length,
      frozenAt: row.frozenAt,
      revision: row.revision,
      giftTrigger: row.giftTrigger,
      subtotalScope: row.subtotalScope,
      categoryKeys: row.categoryKeys,
      includes: row.targets.filter((target) => target.role === "INCLUDE").map((target) => target.product),
      excludes: row.targets.filter((target) => target.role === "EXCLUDE").map((target) => target.product),
      frozenCount,
      frozenPreview: frozenRows.map((entry) => entry.product),
    };
  }

  /**
   * What a scope would match right now, for the editor's preview. Never persists anything and never
   * promises the same set later: a Fixed scope freezes at publish, a Dynamic one keeps reading
   * membership. Uses the same single-statement snapshot as the freeze itself.
   */
  async function previewScope(scope: ScopeConfig, allowGlobal: boolean): Promise<AdminScopePreview> {
    const validated = validateScopeConfig(scope, { allowGlobal });
    if (!validated.ok) return { kind: "INVALID", codes: validated.issues.map((issue) => issue.code) };
    if (validated.scope.mode === "GLOBAL_ALL_PAID_LINES") return { kind: "GLOBAL", message: "ALL_PAID_LINES" };

    const snapshot = await readMembershipSnapshot(client, validated.scope);
    // The same computation as the freeze; for Dynamic it only counts what matches today.
    const computed = computeFrozenProductIds({ ...validated.scope, mode: FIXED_PRODUCT_SET }, snapshot);
    if (!computed.ok) return { kind: "UNAVAILABLE", code: computed.code };

    const ids = computed.productIds.slice(0, ADMIN_SCOPE_PREVIEW_NAMES);
    const products = ids.length === 0
      ? []
      : await client.productMirror.findMany({ where: { id: { in: [...ids] } }, orderBy: { id: "asc" }, select: { id: true, name: true } });
    return {
      kind: "COUNT",
      matchCount: computed.productIds.length,
      names: products,
      frozenAtPublish: validated.scope.mode === FIXED_PRODUCT_SET,
    };
  }

  return { listCampaigns, getCampaignForEdit, previewScope };
}
