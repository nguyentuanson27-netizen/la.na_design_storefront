"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import { parseGiftQuantityDraftForm } from "@/commerce/gift-quantity-admin-input";
import {
  copyGiftQuantityCampaign,
  createDraftGiftQuantityCampaign,
  editDraftGiftQuantityCampaign,
} from "@/commerce/gift-quantity-admin-service";
import {
  disableGiftQuantityCampaign,
  editScheduledGiftQuantityCampaign,
  endGiftQuantityCampaignEarly,
  publishGiftQuantityCampaign,
} from "@/commerce/gift-quantity-activation-service";
import { createGiftQuantityAdminRepository, type AdminScopePreview } from "@/commerce/gift-quantity-admin-repository";
import { isBoundedPromotionIdentifier } from "@/commerce/promotion-activation";
import { createPromotionAdminRepository } from "@/commerce/promotion-admin-repository";
import { deriveCampaignLifecycle } from "@/commerce/promotion-campaign-lifecycle";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";
import {
  runGiftQuantityAdminOperation,
  type GiftQuantityActionOutcome,
  type GiftQuantityAdminOperation,
  type GiftQuantityOperationResult,
} from "@/operations/gift-quantity-admin-operation";

const LIST_PATH = "/admin/promotions/gift-quantity";

/**
 * Every operation runs the same way: re-authorize on the server, hand the decision to the domain
 * service, translate what comes back. The browser's idea of what is enabled or allowed is never an
 * input. Outcomes travel back as a redirect, carrying only a typed reason, so the surface works
 * without JavaScript and a reload never replays a mutation.
 */
async function runOperation(
  operation: GiftQuantityAdminOperation,
  run: (session: Awaited<ReturnType<typeof requireCurrentAdmin>>) => Promise<GiftQuantityOperationResult>,
): Promise<GiftQuantityActionOutcome> {
  return runGiftQuantityAdminOperation({
    operation,
    authorize: () => requireCurrentAdmin(),
    run,
    onCommitted: () => revalidatePath(LIST_PATH),
  });
}

function campaignIdFrom(formData: FormData): string {
  const raw = formData.get("campaignId");
  return typeof raw === "string" ? raw.trim() : "";
}

/** `redirect` throws by design, so it is called only after the operation has fully settled. */
function completeWith(outcome: GiftQuantityActionOutcome): never {
  if (outcome.ok) redirect(`${LIST_PATH}?status=ok`);
  redirect(`${LIST_PATH}?status=error&reason=${encodeURIComponent(outcome.failure.reason)}`);
}

export async function createGiftQuantityAction(formData: FormData): Promise<void> {
  const outcome = await runOperation("create", async (session) => {
    const parsed = parseGiftQuantityDraftForm(formData);
    if (!parsed.ok) return { ok: false, failure: { reason: parsed.reason } };
    return createDraftGiftQuantityCampaign({ values: parsed.value, session });
  });
  completeWith(outcome);
}

export async function editGiftQuantityAction(formData: FormData): Promise<void> {
  const rawId = campaignIdFrom(formData);
  const outcome = await runOperation("edit", async (session) => {
    const parsed = parseGiftQuantityDraftForm(formData);
    if (!parsed.ok) return { ok: false, failure: { reason: parsed.reason } };
    if (!isBoundedPromotionIdentifier(rawId)) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } };

    const existing = await prisma.giftQuantityCampaign.findUnique({
      where: { id: rawId },
      select: { id: true, isEnabled: true, enabledAt: true, disabledAt: true, startsAt: true, endsAt: true },
    });
    if (existing === null) return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } };

    const now = new Date();
    const lifecycle = deriveCampaignLifecycle({ ...existing, now });
    if (lifecycle.status === "DRAFT") {
      return editDraftGiftQuantityCampaign({ campaignId: rawId, values: parsed.value, now, session });
    }
    if (lifecycle.status === "SCHEDULED") {
      // Scheduled edits are effective and gated; the service refuses with FEATURE_DISABLED when OFF.
      return editScheduledGiftQuantityCampaign({
        campaignId: rawId,
        now,
        session,
        patch: {
          name: parsed.value.name,
          startsAt: parsed.value.startsAt,
          endsAt: parsed.value.endsAt,
          scope: {
            scopeMode: parsed.value.scopeMode,
            categoryKeys: parsed.value.categoryKeys,
            includeProductIds: parsed.value.includeProductIds,
            excludeProductIds: parsed.value.excludeProductIds,
          },
        },
      });
    }
    return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } };
  });
  completeWith(outcome);
}

export async function publishGiftQuantityAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runOperation("publish", (session) =>
    publishGiftQuantityCampaign({ campaignId, now: new Date(), session }),
  );
  completeWith(outcome);
}

export async function disableGiftQuantityAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runOperation("disable", (session) =>
    disableGiftQuantityCampaign({ campaignId, now: new Date(), session }),
  );
  completeWith(outcome);
}

export async function endGiftQuantityEarlyAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runOperation("end-early", (session) =>
    endGiftQuantityCampaignEarly({ campaignId, now: new Date(), session }),
  );
  completeWith(outcome);
}

export async function copyGiftQuantityAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runOperation("copy", (session) => copyGiftQuantityCampaign({ campaignId, session }));
  completeWith(outcome);
}

/** Bounded product search for the scope pickers. Admin-only; an unauthorized caller gets nothing. */
export async function searchGiftQuantityProductsAction(
  search: string,
): Promise<Array<{ id: string; label: string }>> {
  try {
    await requireCurrentAdmin();
  } catch {
    return [];
  }
  const repository = createPromotionAdminRepository(prisma);
  const products = await repository.searchTargetProducts({ shopId: readPancakeShopId(), search });
  return products.map((product) => ({ id: product.id, label: product.name }));
}

/** Read-only preview of what a scope matches now. Admin-only; persists nothing. */
export async function previewGiftQuantityScopeAction(input: {
  scopeMode: string;
  categoryKeys: string[];
  includeProductIds: string[];
  excludeProductIds: string[];
  global: boolean;
}): Promise<AdminScopePreview | null> {
  try {
    await requireCurrentAdmin();
  } catch {
    return null;
  }
  const mode = input.scopeMode;
  if (mode !== "GLOBAL_ALL_PAID_LINES" && mode !== "DYNAMIC_CATEGORY" && mode !== "FIXED_PRODUCT_SET") return null;
  const repository = createGiftQuantityAdminRepository(prisma);
  return repository.previewScope(
    mode === "GLOBAL_ALL_PAID_LINES"
      ? { mode }
      : {
          mode,
          categoryKeys: input.categoryKeys,
          includeProductIds: input.includeProductIds,
          excludeProductIds: input.excludeProductIds,
        },
    input.global === true,
  );
}
