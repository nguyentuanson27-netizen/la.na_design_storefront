import { requireAdminSession } from "../auth/authorization.ts";
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { keepStoredInstantIfUnchangedAtMinute } from "./gift-quantity-admin-input.ts";
import { buildCopyCampaignName, deriveCampaignLifecycle } from "./promotion-campaign-lifecycle.ts";
import {
  toVoucherCampaign,
  voucherCampaignSelection,
  voucherCapFloor,
  voucherRowToInput,
  type VoucherCampaignRow,
} from "./voucher-campaign.ts";
import { validateVoucherCampaign, type VoucherCampaignValues, type VoucherRuleIssue } from "./voucher-rule-validation.ts";
import { findLadderConflict, validateVoucherType, type LadderTier } from "./voucher-type-rules.ts";

/**
 * Voucher v1 (V06; types and tiers per ADR 0020): Admin writes, lifecycle and the committed-floor cap rule (spec §3.1, TG-05 A).
 *
 * Every entry re-authorizes (ADMIN role) and is scoped to one shop in every query. A campaign is created as an
 * inactive draft and never activates itself. Edits and enable/disable are optimistic on `revision` and run
 * under the campaign's row lock, which is the same lock a hold grant takes (V11), so a cap edit and a grant
 * serialize instead of racing: the floor is read from the locked row, and the table's CHECK constraints are the
 * backstop if anything ever bypasses this service. Disabling or editing never revokes a live hold -- it only
 * stops new ones (TG-05 A); the service does not touch holds at all.
 */

export const MAX_ENABLED_VOUCHERS_PER_SHOP = 50;
/** Kept under the optimizer's slot bound (8) so the untyped group and every type can always be in play together. */
export const MAX_VOUCHER_TYPES_PER_SHOP = 6;
/** Separate from catalog-sync (1277934572), product-slug (1277934573) and shipping campaigns (1277934574). */
export const VOUCHER_ADMIN_LOCK_NAMESPACE = 1_277_934_575;

type Session = { user: { id: string; role?: string | null }; session: { id: string } } | null | undefined;

export type VoucherAdminReason =
  | "VALIDATION"
  | "NOT_FOUND"
  | "STALE_REVISION"
  | "TARGET_INVALID"
  | "LIMIT_REACHED"
  | "WINDOW_ENDED"
  | "CODE_TAKEN"
  | "TYPE_NOT_FOUND"
  | "TYPE_LIMIT_REACHED"
  | "IDENTITY_LOCKED"
  | "NOT_EDITABLE"
  | "NOT_RE_ENABLEABLE"
  | "CAP_BELOW_COMMITTED"
  | "ALREADY_IN_STATE";

export type VoucherAdminResult =
  | Readonly<{ ok: true; id: string; revision: number }>
  | Readonly<{
      ok: false;
      reason: VoucherAdminReason;
      issues?: readonly VoucherRuleIssue[];
      /** CAP_BELOW_COMMITTED: the smallest cap that is still allowed. */
      floor?: Readonly<{ uses: number; vnd: number }>;
    }>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function validRevision(revision: number): boolean {
  return Number.isInteger(revision) && revision >= 1 && revision < 2_147_483_647;
}

export function voucherColumns(value: VoucherCampaignValues) {
  const discount = value.discount;
  return {
    name: value.name,
    kind: value.kind,
    issuance: value.issuance,
    visibility: value.visibility,
    code: value.code,
    discountType: discount === null ? null : discount.type,
    fixedAmountVnd: discount?.type === "FIXED_AMOUNT_VND" ? BigInt(discount.amountVnd) : null,
    percent: discount?.type === "PERCENTAGE" ? discount.percent : null,
    maxDiscountVnd: discount?.type === "PERCENTAGE" && discount.maxDiscountVnd !== null ? BigInt(discount.maxDiscountVnd) : null,
    minEligibleSubtotalVnd: value.minEligibleSubtotalVnd === null ? null : BigInt(value.minEligibleSubtotalVnd),
    scopeMode: value.scope.mode,
    categoryKeys: value.scope.mode === "TARGETED" ? [...value.scope.categoryKeys] : [],
    includeProductIds: value.scope.mode === "TARGETED" ? [...value.scope.includeProductIds] : [],
    excludeProductIds: [...value.scope.excludeProductIds],
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    maxUses: value.maxUses,
    maxBudgetVnd: value.maxBudgetVnd === null ? null : BigInt(value.maxBudgetVnd),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : ""} ${(error as { code?: string })?.code ?? ""} ${(error as { cause?: { message?: string } })?.cause?.message ?? ""}`;
  // The code namespace trigger (a code is a campaign's or a type's, never both) answers like a unique key.
  return /P2002|unique constraint|duplicate key|already used by a (campaign|type)/i.test(text);
}

function isCheckViolation(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : ""} ${(error as { cause?: { message?: string } })?.cause?.message ?? ""}`;
  return /check constraint|23514/i.test(text);
}

export function createVoucherAdminService(client: PrismaClient, shopId: number) {
  function authorize(session: Session, now: Date) {
    requireAdminSession(session);
    if (!Number.isInteger(shopId) || shopId < 1 || shopId > 2_147_483_647 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new RangeError("Invalid voucher admin context");
    }
  }

  async function lockShop(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VOUCHER_ADMIN_LOCK_NAMESPACE}, ${shopId})`;
  }

  /** The campaign's row lock: the same one a hold grant takes, so cap edits and grants serialize. */
  async function lockCampaign(tx: Prisma.TransactionClient, id: string): Promise<VoucherCampaignRow | null> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "VoucherCampaign" WHERE "id" = ${id} AND "pancakeShopId" = ${shopId} FOR UPDATE`;
    if (locked.length === 0) return null;
    return tx.voucherCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: voucherCampaignSelection });
  }

  /** The type a typed tier belongs to, in this shop. */
  async function readType(tx: Pick<Prisma.TransactionClient, "voucherType">, typeId: string) {
    return tx.voucherType.findFirst({ where: { id: typeId, pancakeShopId: shopId }, select: { id: true, name: true, priority: true, issuance: true, visibility: true, code: true } });
  }

  /** A tier owns neither its distribution nor its code: it takes both from its type, whatever the form sent. */
  function withTypeDistribution(input: unknown, type: { issuance: string; visibility: string; code: string | null }, typeId: string): Record<string, unknown> {
    return { ...(input as Record<string, unknown>), typeId, issuance: type.issuance, visibility: type.visibility, code: type.code };
  }

  const ladderTierOf = (id: string, value: VoucherCampaignValues): LadderTier => ({
    id,
    minEligibleSubtotalVnd: value.minEligibleSubtotalVnd,
    discount: value.discount,
    scopeKey: JSON.stringify([value.scope.mode, ...(value.scope.mode === "TARGETED" ? [[...value.scope.categoryKeys].sort(), [...value.scope.includeProductIds].sort()] : []), [...value.scope.excludeProductIds].sort()]),
  });

  /**
   * ADR 0020 D-7: among the ENABLED, not-yet-ended tiers of one type, a higher threshold gives a strictly higher discount. Draft tiers
   * are free (a Copy of a rung starts with the same threshold); the rule bites when a tier would be live next to another.
   */
  async function ladderIssue(tx: Prisma.TransactionClient, typeId: string, candidate: LadderTier, now: Date): Promise<VoucherRuleIssue | null> {
    const siblings = await tx.voucherCampaign.findMany({ where: { pancakeShopId: shopId, typeId, isEnabled: true, id: { not: candidate.id } }, select: voucherCampaignSelection });
    const live: LadderTier[] = [];
    for (const row of siblings) {
      if (deriveCampaignLifecycle({ ...row, now }).status === "ENDED") continue;
      try {
        live.push(ladderTierOf(row.id, toVoucherCampaign(row)));
      } catch {
        // A sibling that no longer validates is not part of any quote either.
      }
    }
    return findLadderConflict(candidate, live) === null ? null : { code: "ladder-conflict", field: "minEligibleSubtotalVnd" };
  }

  async function validTargets(tx: Prisma.TransactionClient, value: VoucherCampaignValues) {
    const ids = [...new Set([...(value.scope.mode === "TARGETED" ? value.scope.includeProductIds : []), ...value.scope.excludeProductIds])];
    if (ids.length === 0) return true;
    const products = await tx.productMirror.findMany({ where: { id: { in: ids }, pancakeShopId: shopId }, select: { id: true } });
    return products.length === ids.length;
  }

  async function create(session: Session, input: unknown, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    const typeId = typeof (input as { typeId?: unknown } | null)?.typeId === "string" ? ((input as { typeId: string }).typeId) : null;
    let prepared: unknown = input;
    if (typeId !== null) {
      if (!ID_PATTERN.test(typeId)) return { ok: false, reason: "TYPE_NOT_FOUND" };
      const type = await readType(client, typeId);
      if (type === null) return { ok: false, reason: "TYPE_NOT_FOUND" };
      prepared = withTypeDistribution(input, type, typeId);
    }
    const parsed = validateVoucherCampaign(prepared);
    if (!parsed.ok) return { ok: false, reason: "VALIDATION", issues: parsed.issues };
    try {
      return await client.$transaction(async (tx) => {
        await lockShop(tx);
        if (!(await validTargets(tx, parsed.value))) return { ok: false, reason: "TARGET_INVALID" } as const;
        // A new campaign is a disabled draft, so the ladder rule is checked when it is enabled.
        const row = await tx.voucherCampaign.create({
          data: { ...voucherColumns(parsed.value), code: parsed.value.typeId === null ? parsed.value.code : null, typeId: parsed.value.typeId, pancakeShopId: shopId, isEnabled: false },
          select: { id: true, revision: true },
        });
        return { ok: true, id: row.id, revision: row.revision } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: "CODE_TAKEN" };
      throw error;
    }
  }

  async function edit(session: Session, id: string, revision: number, input: unknown, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    if (!ID_PATTERN.test(id)) return { ok: false, reason: "NOT_FOUND" };
    if (!validRevision(revision)) return { ok: false, reason: "STALE_REVISION" };
    // A tier never changes type, so its type is known before the lock; the form's own issuance/visibility/code are ignored for it.
    const existing = await client.voucherCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: voucherCampaignSelection });
    if (existing === null) return { ok: false, reason: "NOT_FOUND" };
    const prepared = existing.type ? withTypeDistribution(input, existing.type, existing.type.id) : { ...(input as Record<string, unknown>), typeId: null };
    const parsed = validateVoucherCampaign(prepared);
    if (!parsed.ok) return { ok: false, reason: "VALIDATION", issues: parsed.issues };
    try {
      return await client.$transaction(async (tx) => {
        await lockShop(tx);
        const old = await lockCampaign(tx, id);
        if (old === null) return { ok: false, reason: "NOT_FOUND" } as const;
        if (old.revision !== revision) return { ok: false, reason: "STALE_REVISION" } as const;
        const lifecycle = deriveCampaignLifecycle({ ...old, now });
        // Ended or disabled-after-running campaigns are history: Copy is the only way forward.
        if (lifecycle.isTerminal || lifecycle.status === "ENDED") return { ok: false, reason: "NOT_EDITABLE" } as const;
        // Once a campaign has ever been enabled its identity is fixed, so a code printed on a flyer keeps meaning one thing.
        const storedCode = old.type ? old.type.code : old.code;
        if (old.enabledAt !== null && (old.kind !== parsed.value.kind || old.issuance !== parsed.value.issuance || old.visibility !== parsed.value.visibility || storedCode !== parsed.value.code)) {
          return { ok: false, reason: "IDENTITY_LOCKED" } as const;
        }
        const value: VoucherCampaignValues = {
          ...parsed.value,
          startsAt: keepStoredInstantIfUnchangedAtMinute(parsed.value.startsAt, old.startsAt),
          endsAt: keepStoredInstantIfUnchangedAtMinute(parsed.value.endsAt, old.endsAt),
        };
        const rechecked = validateVoucherCampaign({ ...value });
        if (!rechecked.ok) return { ok: false, reason: "VALIDATION", issues: rechecked.issues } as const;
        // TG-05 A: a cap may equal what is committed (redeemed not refunded + live holds), never go under it.
        const floor = voucherCapFloor({ redeemedUses: old.redeemedUses, reservedUses: old.reservedUses, redeemedVnd: Number(old.redeemedVnd), reservedVnd: Number(old.reservedVnd) });
        if ((rechecked.value.maxUses !== null && rechecked.value.maxUses < floor.uses) || (rechecked.value.maxBudgetVnd !== null && rechecked.value.maxBudgetVnd < floor.vnd)) {
          return { ok: false, reason: "CAP_BELOW_COMMITTED", floor } as const;
        }
        if (!(await validTargets(tx, rechecked.value))) return { ok: false, reason: "TARGET_INVALID" } as const;
        if (old.type && old.isEnabled) {
          const conflict = await ladderIssue(tx, old.type.id, ladderTierOf(id, rechecked.value), now);
          if (conflict !== null) return { ok: false, reason: "VALIDATION", issues: [conflict] } as const;
        }
        const updated = await tx.voucherCampaign.updateMany({
          where: { id, pancakeShopId: shopId, revision },
          data: { ...voucherColumns(rechecked.value), code: old.type ? null : rechecked.value.code, revision: { increment: 1 } },
        });
        return updated.count === 1 ? ({ ok: true, id, revision: revision + 1 } as const) : ({ ok: false, reason: "STALE_REVISION" } as const);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: "CODE_TAKEN" };
      if (isCheckViolation(error)) return { ok: false, reason: "CAP_BELOW_COMMITTED" };
      throw error;
    }
  }

  async function setEnabled(session: Session, id: string, revision: number, enabled: boolean, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    if (typeof enabled !== "boolean") throw new RangeError("Invalid voucher enable state");
    if (!ID_PATTERN.test(id)) return { ok: false, reason: "NOT_FOUND" };
    if (!validRevision(revision)) return { ok: false, reason: "STALE_REVISION" };
    return client.$transaction(async (tx) => {
      await lockShop(tx);
      const row = await lockCampaign(tx, id);
      if (row === null) return { ok: false, reason: "NOT_FOUND" } as const;
      if (row.revision !== revision) return { ok: false, reason: "STALE_REVISION" } as const;
      if (row.isEnabled === enabled) return { ok: false, reason: "ALREADY_IN_STATE" } as const;
      const lifecycle = deriveCampaignLifecycle({ ...row, now });
      if (enabled) {
        if (row.endsAt !== null && row.endsAt <= now) return { ok: false, reason: "WINDOW_ENDED" } as const;
        // A campaign that ran and was switched off is history; a fresh Copy is the way back.
        if (lifecycle.status === "DISABLED" && !lifecycle.canReEnable) return { ok: false, reason: "NOT_RE_ENABLEABLE" } as const;
        const campaign = toVoucherCampaign(row); // fails closed if the persisted rule is no longer valid
        if (!(await validTargets(tx, campaign))) return { ok: false, reason: "TARGET_INVALID" } as const;
        const count = await tx.voucherCampaign.count({ where: { pancakeShopId: shopId, isEnabled: true, id: { not: id } } });
        if (count >= MAX_ENABLED_VOUCHERS_PER_SHOP) return { ok: false, reason: "LIMIT_REACHED" } as const;
        if (row.type) {
          const conflict = await ladderIssue(tx, row.type.id, ladderTierOf(id, campaign), now);
          if (conflict !== null) return { ok: false, reason: "VALIDATION", issues: [conflict] } as const;
        }
      }
      const updated = await tx.voucherCampaign.updateMany({
        where: { id, pancakeShopId: shopId, revision },
        data: { isEnabled: enabled, enabledAt: enabled ? now : row.enabledAt, disabledAt: enabled ? null : now, revision: { increment: 1 } },
      });
      return updated.count === 1 ? ({ ok: true, id, revision: revision + 1 } as const) : ({ ok: false, reason: "STALE_REVISION" } as const);
    });
  }

  /** A new inactive draft from any campaign; the ledger starts at zero. A CODE voucher needs its own new code. */
  async function copy(session: Session, id: string, overrides: Readonly<{ code?: string | null }> = {}, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    if (!ID_PATTERN.test(id)) return { ok: false, reason: "NOT_FOUND" };
    const source = await client.voucherCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: voucherCampaignSelection });
    if (source === null) return { ok: false, reason: "NOT_FOUND" };
    const input = voucherRowToInput(source);
    // A tier is copied into the same type (it takes the type's code); anything else needs its own new code if it is a CODE voucher.
    return create(session, { ...input, name: buildCopyCampaignName(source.name), code: source.type ? source.type.code : source.issuance === "CODE" ? (overrides.code ?? null) : null, startsAt: null, endsAt: null }, now);
  }

  async function list(session: Session, beforeId?: string) {
    authorize(session, new Date());
    if (beforeId !== undefined && !ID_PATTERN.test(beforeId)) throw new RangeError("Invalid voucher cursor");
    return client.voucherCampaign.findMany({
      where: { pancakeShopId: shopId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      select: voucherCampaignSelection,
      orderBy: { id: "desc" },
      take: 21,
    });
  }

  async function get(session: Session, id: string) {
    authorize(session, new Date());
    if (!ID_PATTERN.test(id)) return null;
    return client.voucherCampaign.findFirst({ where: { id, pancakeShopId: shopId }, select: voucherCampaignSelection });
  }

  // --- types (ADR 0020) -----------------------------------------------------------------------------------------------------

  async function createType(session: Session, input: unknown, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    const parsed = validateVoucherType(input);
    if (!parsed.ok) return { ok: false, reason: "VALIDATION", issues: parsed.issues };
    try {
      return await client.$transaction(async (tx) => {
        await lockShop(tx);
        if ((await tx.voucherType.count({ where: { pancakeShopId: shopId } })) >= MAX_VOUCHER_TYPES_PER_SHOP) return { ok: false, reason: "TYPE_LIMIT_REACHED" } as const;
        const row = await tx.voucherType.create({ data: { pancakeShopId: shopId, ...parsed.value }, select: { id: true } });
        return { ok: true, id: row.id, revision: 1 } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: "CODE_TAKEN" };
      throw error;
    }
  }

  /**
   * Renames a type or moves it in the stack. Its distribution (AUTO/CODE, visibility) is fixed once it has tiers, because they carry
   * copies of it, and its code is fixed once any tier has been enabled (a code printed on a flyer keeps meaning one thing).
   */
  async function editType(session: Session, id: string, input: unknown, now = new Date()): Promise<VoucherAdminResult> {
    authorize(session, now);
    if (!ID_PATTERN.test(id)) return { ok: false, reason: "TYPE_NOT_FOUND" };
    const parsed = validateVoucherType(input);
    if (!parsed.ok) return { ok: false, reason: "VALIDATION", issues: parsed.issues };
    try {
      return await client.$transaction(async (tx) => {
        await lockShop(tx);
        const old = await readType(tx, id);
        if (old === null) return { ok: false, reason: "TYPE_NOT_FOUND" } as const;
        const distributionChanged = old.issuance !== parsed.value.issuance || old.visibility !== parsed.value.visibility || old.code !== parsed.value.code;
        if (distributionChanged) {
          const tiers = await tx.voucherCampaign.count({ where: { typeId: id, pancakeShopId: shopId } });
          if (tiers > 0) {
            const everEnabled = await tx.voucherCampaign.count({ where: { typeId: id, pancakeShopId: shopId, enabledAt: { not: null } } });
            const onlyCodeChanged = old.issuance === parsed.value.issuance && old.visibility === parsed.value.visibility;
            if (!onlyCodeChanged || everEnabled > 0) return { ok: false, reason: "IDENTITY_LOCKED" } as const;
          }
        }
        await tx.voucherType.update({ where: { id }, data: parsed.value });
        return { ok: true, id, revision: 1 } as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: "CODE_TAKEN" };
      throw error;
    }
  }

  async function listTypes(session: Session) {
    authorize(session, new Date());
    return client.voucherType.findMany({
      where: { pancakeShopId: shopId },
      select: { id: true, name: true, priority: true, issuance: true, visibility: true, code: true, _count: { select: { tiers: true } } },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
      take: MAX_VOUCHER_TYPES_PER_SHOP,
    });
  }

  async function getType(session: Session, id: string) {
    authorize(session, new Date());
    if (!ID_PATTERN.test(id)) return null;
    return readType(client, id);
  }

  return { create, edit, setEnabled, copy, list, get, createType, editType, listTypes, getType };
}
