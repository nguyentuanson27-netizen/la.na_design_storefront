/**
 * Draft-level admin writes for gift / quantity-tier campaigns (GQ05).
 *
 * Create, edit-a-Draft and copy. None of them is *effective*: a Draft is never storefront-effective,
 * so they take no revision lock, advance no revision, and are deliberately not behind the feature
 * gate -- an admin may prepare campaigns while the feature is OFF. Everything that can change what
 * a buyer is charged (publish, re-enable, Scheduled edit, disable, end-early) lives in
 * `gift-quantity-activation-service.ts` and is gated there.
 *
 * What a Draft may and may not hold:
 * - It may be incomplete: no categories or products yet, no window, no rule values. Business rules
 *   are validated at publish (GQ09a/GQ13a own the rule-specific parts).
 * - It may not be contradictory or out of bounds, and the server enforces that regardless of what
 *   the form shows: a global scope with targets, a global scope for anything but gift +
 *   `ORDER_SUBTOTAL` + `ALL_PAID_LINES`, a subtotal scope that disagrees with the scope mode,
 *   unknown categories or products, oversized or duplicate lists, a kind change after creation.
 * - Changing the gift trigger clears the fields of the trigger it replaced, so the persisted row
 *   never carries two competing readings.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import { requireAdminSession } from "../auth/authorization.ts";
import { prisma } from "../db/prisma.ts";

import type { GiftQuantityDraftValues } from "./gift-quantity-admin-input.ts";
import { validateScopeConfig, type ScopeIssue } from "./gift-quantity-scope.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";
import { lockRows } from "./promotion-activation-service.ts";
import { buildCopyCampaignName, deriveCampaignLifecycle, type CampaignLifecycleStatus } from "./promotion-campaign-lifecycle.ts";
import { normalizePromotionCampaignName } from "./promotion-campaign-name.ts";

export type GiftQuantityAdminFailure =
  | { reason: "CAMPAIGN_NOT_FOUND" }
  | { reason: "ILLEGAL_TRANSITION"; from: CampaignLifecycleStatus }
  | { reason: "INVALID_INPUT"; errors: readonly string[] }
  | { reason: "INVALID_SCOPE"; issues: readonly ScopeIssue[] }
  | { reason: "KIND_IMMUTABLE" };

export type GiftQuantityAdminOutcome =
  | Readonly<{ ok: true; campaignId: string }>
  | Readonly<{ ok: false; failure: GiftQuantityAdminFailure }>;

export type AdminSessionCandidate =
  | { user: { id: string; role?: string | null }; session: { id: string } }
  | null
  | undefined;

const MAX_COPY_CHILDREN = 1_000;

/** Contradictions the form can produce but the server must still refuse. */
export function validateDraftShape(values: GiftQuantityDraftValues): readonly string[] {
  const errors: string[] = [];
  const name = normalizePromotionCampaignName(values.name);
  if (!name.ok) errors.push(name.error);

  const global = values.scopeMode === "GLOBAL_ALL_PAID_LINES";
  if (values.kind === "QUANTITY_TIER") {
    if (global) errors.push("GLOBAL_SCOPE_NOT_ALLOWED");
    if (values.giftTrigger !== null || values.subtotalScope !== null) errors.push("GIFT_FIELDS_ON_TIER");
    return errors;
  }

  if (values.giftTrigger === "QUANTITY") {
    if (global) errors.push("GLOBAL_SCOPE_NOT_ALLOWED");
    if (values.subtotalScope !== null) errors.push("SUBTOTAL_SCOPE_MISMATCH");
  } else if (values.giftTrigger === "ORDER_SUBTOTAL") {
    // ALL_PAID_LINES is the global scope and ELIGIBLE_PAID_LINES needs a real one; an unset
    // subtotal scope is still a valid, incomplete Draft unless the scope mode already contradicts it.
    if (values.subtotalScope === "ALL_PAID_LINES" && !global) errors.push("SUBTOTAL_SCOPE_MISMATCH");
    if (values.subtotalScope === "ELIGIBLE_PAID_LINES" && global) errors.push("SUBTOTAL_SCOPE_MISMATCH");
    if (global && values.subtotalScope === null) errors.push("SUBTOTAL_SCOPE_MISMATCH");
  } else if (global) {
    // No trigger chosen yet cannot be a global scope: the database only allows global for
    // ORDER_SUBTOTAL + ALL_PAID_LINES.
    errors.push("GLOBAL_SCOPE_NOT_ALLOWED");
  }
  return errors;
}

/** Scope validation for a Draft: structure and bounds are enforced, completeness is not. */
function validateDraftScope(values: GiftQuantityDraftValues): readonly ScopeIssue[] {
  const result = validateScopeConfig(
    {
      mode: values.scopeMode,
      categoryKeys: values.categoryKeys,
      includeProductIds: values.includeProductIds,
      excludeProductIds: values.excludeProductIds,
    },
    { allowGlobal: values.kind === "GIFT_ITEM" && values.giftTrigger === "ORDER_SUBTOTAL" && values.subtotalScope === "ALL_PAID_LINES" },
  );
  if (result.ok) return [];
  // An empty selection is an unfinished Draft, not a contradiction.
  return result.issues.filter((issue) => issue.code !== "scope-empty");
}

async function unknownProductIds(
  client: Pick<PrismaClient, "productMirror">,
  ids: readonly string[],
): Promise<readonly string[]> {
  if (ids.length === 0) return [];
  const found = await client.productMirror.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
  const known = new Set(found.map((row) => row.id));
  return ids.filter((id) => !known.has(id));
}

function triggerFieldReset(values: GiftQuantityDraftValues) {
  if (values.kind === "QUANTITY_TIER") return {};
  if (values.giftTrigger === null) {
    return { minimumQuantity: null, minimumSubtotalVnd: null, subtotalScope: null, awardMode: null };
  }
  if (values.giftTrigger === "QUANTITY") {
    return { minimumSubtotalVnd: null, subtotalScope: null, awardMode: null };
  }
  return { minimumQuantity: null };
}

function validateAll(values: GiftQuantityDraftValues): GiftQuantityAdminFailure | null {
  const shape = validateDraftShape(values);
  if (shape.length > 0) return { reason: "INVALID_INPUT", errors: shape };
  const issues = validateDraftScope(values);
  if (issues.length > 0) return { reason: "INVALID_SCOPE", issues };
  return null;
}

export async function createDraftGiftQuantityCampaign({
  values,
  session,
  client = prisma,
}: Readonly<{
  values: GiftQuantityDraftValues;
  session: AdminSessionCandidate;
  client?: PrismaClient;
}>): Promise<GiftQuantityAdminOutcome> {
  requireAdminSession(session);
  const invalid = validateAll(values);
  if (invalid !== null) return { ok: false, failure: invalid };
  const unknown = await unknownProductIds(client, [...values.includeProductIds, ...values.excludeProductIds]);
  if (unknown.length > 0) return { ok: false, failure: { reason: "INVALID_SCOPE", issues: [{ code: "scope-product-id-invalid", field: "productIds" }] } };

  const name = normalizePromotionCampaignName(values.name);
  if (!name.ok) return { ok: false, failure: { reason: "INVALID_INPUT", errors: [name.error] } };

  const created = await client.giftQuantityCampaign.create({
    data: {
      kind: values.kind,
      name: name.name,
      startsAt: values.startsAt,
      endsAt: values.endsAt,
      scopeMode: values.scopeMode,
      categoryKeys: [...values.categoryKeys],
      giftTrigger: values.kind === "GIFT_ITEM" ? values.giftTrigger : null,
      subtotalScope: values.kind === "GIFT_ITEM" && values.giftTrigger === "ORDER_SUBTOTAL" ? values.subtotalScope : null,
      targets: {
        create: [
          ...values.includeProductIds.map((productId) => ({ productId, role: "INCLUDE" as const })),
          ...values.excludeProductIds.map((productId) => ({ productId, role: "EXCLUDE" as const })),
        ],
      },
    },
    select: { id: true },
  });
  return { ok: true, campaignId: created.id };
}

/**
 * Edit a Draft. The campaign row is locked before its lifecycle is read, so "this is a Draft" holds
 * until commit and a concurrent publish cannot land between the check and the write.
 */
export async function editDraftGiftQuantityCampaign({
  campaignId,
  values,
  now,
  session,
  client = prisma,
}: Readonly<{
  campaignId: string;
  values: GiftQuantityDraftValues;
  now: Date;
  session: AdminSessionCandidate;
  client?: PrismaClient;
}>): Promise<GiftQuantityAdminOutcome> {
  requireAdminSession(session);
  if (!isBoundedPromotionIdentifier(campaignId)) return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] } };
  const invalid = validateAll(values);
  if (invalid !== null) return { ok: false, failure: invalid };
  const unknown = await unknownProductIds(client, [...values.includeProductIds, ...values.excludeProductIds]);
  if (unknown.length > 0) return { ok: false, failure: { reason: "INVALID_SCOPE", issues: [{ code: "scope-product-id-invalid", field: "productIds" }] } };
  const name = normalizePromotionCampaignName(values.name);
  if (!name.ok) return { ok: false, failure: { reason: "INVALID_INPUT", errors: [name.error] } };

  return client.$transaction(async (tx) => {
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);
    const row = await tx.giftQuantityCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, kind: true, isEnabled: true, enabledAt: true, disabledAt: true, startsAt: true, endsAt: true },
    });
    if (row === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;
    const lifecycle = deriveCampaignLifecycle({ ...row, now });
    if (lifecycle.status !== "DRAFT") return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } } as const;
    if (row.kind !== values.kind) return { ok: false, failure: { reason: "KIND_IMMUTABLE" } } as const;

    await tx.giftQuantityTarget.deleteMany({ where: { campaignId } });
    await tx.giftQuantityTarget.createMany({
      data: [
        ...values.includeProductIds.map((productId) => ({ campaignId, productId, role: "INCLUDE" as const })),
        ...values.excludeProductIds.map((productId) => ({ campaignId, productId, role: "EXCLUDE" as const })),
      ],
    });
    await tx.giftQuantityCampaign.update({
      where: { id: campaignId },
      data: {
        name: name.name,
        startsAt: values.startsAt,
        endsAt: values.endsAt,
        scopeMode: values.scopeMode,
        categoryKeys: [...values.categoryKeys],
        ...(values.kind === "GIFT_ITEM"
          ? {
              giftTrigger: values.giftTrigger,
              subtotalScope: values.giftTrigger === "ORDER_SUBTOTAL" ? values.subtotalScope : null,
              ...triggerFieldReset(values),
            }
          : {}),
      },
    });
    return { ok: true, campaignId } as const;
  });
}

/**
 * Copy to a new Draft: configuration and child rows verbatim, lifecycle and frozen snapshot not.
 * A copy never inherits a frozen set: it must be re-captured by its own publish.
 */
export async function copyGiftQuantityCampaign({
  campaignId,
  session,
  client = prisma,
}: Readonly<{
  campaignId: string;
  session: AdminSessionCandidate;
  client?: PrismaClient;
}>): Promise<GiftQuantityAdminOutcome> {
  requireAdminSession(session);
  if (!isBoundedPromotionIdentifier(campaignId)) return { ok: false, failure: { reason: "INVALID_INPUT", errors: ["IDENTIFIER_TOO_LONG"] } };

  return client.$transaction(async (tx) => {
    await lockRows(tx, "GiftQuantityCampaign", [campaignId]);
    const source = await tx.giftQuantityCampaign.findUnique({
      where: { id: campaignId },
      include: {
        targets: { take: MAX_COPY_CHILDREN },
        tiers: { take: MAX_COPY_CHILDREN },
        giftOptions: { take: MAX_COPY_CHILDREN },
        stackPeers: { take: MAX_COPY_CHILDREN },
      },
    });
    if (source === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } } as const;

    const copy = await tx.giftQuantityCampaign.create({
      data: {
        kind: source.kind,
        name: buildCopyCampaignName(source.name),
        startsAt: source.startsAt,
        endsAt: source.endsAt,
        isEnabled: false,
        enabledAt: null,
        disabledAt: null,
        stackPriority: source.stackPriority,
        stackingEnabled: source.stackingEnabled,
        scopeMode: source.scopeMode,
        categoryKeys: source.categoryKeys,
        giftTrigger: source.giftTrigger,
        minimumQuantity: source.minimumQuantity,
        minimumSubtotalVnd: source.minimumSubtotalVnd,
        subtotalScope: source.subtotalScope,
        awardMode: source.awardMode,
        maxGiftsPerOrder: source.maxGiftsPerOrder,
        allowDuplicateGifts: source.allowDuplicateGifts,
        tierUnit: source.tierUnit,
        tierDiscountedUnits: source.tierDiscountedUnits,
        tierSelectionPriority: source.tierSelectionPriority,
        targets: { create: source.targets.map((target) => ({ productId: target.productId, role: target.role })) },
        tiers: { create: source.tiers.map((tier) => ({ minQuantity: tier.minQuantity, discountValue: tier.discountValue })) },
        giftOptions: { create: source.giftOptions.map((option) => ({ variantId: option.variantId })) },
        // The database forbids a campaign naming itself, so no peer can point at the source.
        stackPeers: { create: source.stackPeers.map((peer) => ({ peerKind: peer.peerKind, peerCampaignId: peer.peerCampaignId })) },
      },
      select: { id: true },
    });
    return { ok: true, campaignId: copy.id } as const;
  });
}
