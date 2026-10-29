"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import {
  copyPromotionCampaign,
  createDraftPromotionCampaign,
  disablePromotionCampaign,
  editDraftPromotionCampaign,
  editScheduledPromotionCampaign,
  endPromotionCampaignEarly,
  publishPromotionCampaign,
  type CampaignPatch,
} from "@/commerce/promotion-activation-service";
import { previewListPriceCampaign } from "@/commerce/list-price-campaign-preview";
import { isBoundedPromotionIdentifier } from "@/commerce/promotion-activation";
import { deriveCampaignLifecycle } from "@/commerce/promotion-campaign-lifecycle";
import { createPromotionAdminRepository } from "@/commerce/promotion-admin-repository";
import { parseCampaignFormInput } from "@/commerce/promotion-admin-input";
import {
  evaluateCampaignRuntimeHealth,
  type CampaignRuntimeHealth,
} from "@/commerce/promotion-runtime-health";
import { prisma } from "@/db/prisma";
import {
  runPromotionAdminOperation,
  type PromotionActionOutcome,
  type PromotionOperationContext,
  type PromotionOperationResult,
} from "@/operations/promotion-admin-operation";
import type { PromotionActivationOperation } from "@/operations/promotion-observability";
import { readPancakeShopId } from "@/integrations/pancake/config";

/**
 * Every operation runs the same way: re-authorize on the server, hand the decision to the P4
 * service, and translate whatever comes back. The browser's view of what is enabled or permitted
 * is never an input — a disabled button is a courtesy, not a control.
 *
 * The order of those steps, and the signals they emit, live in `runPromotionAdminOperation` so they
 * can be exercised by a test; this wrapper supplies the three things only a Server Action can: the
 * session lookup, the cache invalidation, and the closed operation label.
 *
 * Outcomes travel back as a redirect rather than a returned value, so the surface keeps working
 * with JavaScript unavailable and a reload never replays a mutation. Only the typed *reason* is put
 * in the URL; the operator-facing sentence is looked up on the server when the page re-renders, so
 * no message text — and nothing derived from a failure payload — is ever client-supplied.
 */
async function runPromotionOperation(
  signalOperation: PromotionActivationOperation,
  operation: (
    session: Awaited<ReturnType<typeof requireCurrentAdmin>>,
    context: PromotionOperationContext,
  ) => Promise<PromotionOperationResult>,
  campaignId?: string,
): Promise<PromotionActionOutcome> {
  return runPromotionAdminOperation({
    operation: signalOperation,
    campaignId,
    authorize: () => requireCurrentAdmin(),
    run: operation,
    onCommitted: () => revalidatePath("/admin/promotions"),
  });
}

function campaignIdFrom(formData: FormData): string {
  const raw = formData.get("campaignId");
  // Bounded by the service before any lookup; this only guarantees a string reaches it.
  return typeof raw === "string" ? raw : "";
}

/**
 * `redirect` throws by design, so it is called after the operation has fully settled — never from
 * inside the catch that translates database errors, which would otherwise swallow the redirect.
 */
function completeWith(outcome: PromotionActionOutcome): never {
  if (outcome.ok) redirect(`/admin/promotions?status=ok${outcome.warningCount ? `&thresholdCount=${outcome.warningCount}&minimumPercent=${outcome.minimumPercent}` : ""}`);
  redirect(`/admin/promotions?status=error&reason=${encodeURIComponent(outcome.failure.reason)}`);
}

export async function publishPromotionAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runPromotionOperation(
    "publish",
    (session, context) => {
      // Publish is the gate-governed operation: `publishPromotionCampaign` refuses with
      // ACTIVATION_DISABLED when the flag is off, so the flag's state explains this outcome.
      context.reportActivationGate();
      return publishPromotionCampaign({ campaignId, now: new Date(), session });
    },
    campaignId,
  );
  completeWith(outcome);
}

export async function disablePromotionAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runPromotionOperation(
    "disable",
    (session) => disablePromotionCampaign({ campaignId, now: new Date(), session }),
    campaignId,
  );
  completeWith(outcome);
}

export async function endPromotionEarlyAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runPromotionOperation(
    "end-early",
    (session) => endPromotionCampaignEarly({ campaignId, now: new Date(), session }),
    campaignId,
  );
  completeWith(outcome);
}

export async function copyPromotionAction(formData: FormData): Promise<void> {
  const campaignId = campaignIdFrom(formData);
  const outcome = await runPromotionOperation(
    "copy",
    (session) => copyPromotionCampaign({ campaignId, session }),
    campaignId,
  );
  completeWith(outcome);
}

export async function createPromotionAction(formData: FormData): Promise<void> {
  const outcome = await runPromotionOperation("create", async (session) => {
    const parseResult = parseCampaignFormInput(formData);
    if (!parseResult.ok) {
      return Promise.resolve({ ok: false, failure: { reason: parseResult.reason } });
    }

    const {
      name,
      kind,
      discountType,
      percentageValue,
      fixedPriceVnd,
      startsAt,
      endsAt,
      targets,
    } = parseResult.value;

    const result = await createDraftPromotionCampaign({
      name,
      kind,
      discountType,
      percentageValue,
      fixedPriceVnd,
      startsAt,
      endsAt,
      targets,
      session,
    });
    return result.ok ? { ...result, ...await previewListPriceCampaign({ client: prisma, session, campaignId: result.campaignId }) } : result;
  });

  completeWith(outcome);
}

export async function editPromotionAction(formData: FormData): Promise<void> {
  const campaignIdInput = campaignIdFrom(formData);
  const outcome = await runPromotionOperation(
    "edit",
    async (session, context) => {
      const parseResult = parseCampaignFormInput(formData);
      if (!parseResult.ok) {
        return { ok: false, failure: { reason: parseResult.reason } };
      }

      const rawId = campaignIdInput.trim();
      if (!isBoundedPromotionIdentifier(rawId)) {
        return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } };
      }
      const campaignId = rawId;

      const existing = await prisma.promotionCampaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          isEnabled: true,
          enabledAt: true,
          disabledAt: true,
          startsAt: true,
          endsAt: true,
        },
      });
      if (!existing) {
        return { ok: false, failure: { reason: "CAMPAIGN_NOT_FOUND" } };
      }

      const now = new Date();
      const lifecycle = deriveCampaignLifecycle({ ...existing, now });

      const patch: CampaignPatch = parseResult.value;

      if (lifecycle.status === "DRAFT") {
        const result = await editDraftPromotionCampaign({ campaignId, now, session, patch });
        return result.ok ? { ...result, ...await previewListPriceCampaign({ client: prisma, session, campaignId }) } : result;
      }

      if (lifecycle.status === "SCHEDULED") {
        // Only this branch reaches the gate. A Draft edit goes to an ungated service function, and
        // an illegal transition never reaches one at all, so neither reports gate state.
        context.reportActivationGate();
        return editScheduledPromotionCampaign({ campaignId, now, session, patch });
      }

      return { ok: false, failure: { reason: "ILLEGAL_TRANSITION", from: lifecycle.status } };
    },
    campaignIdInput,
  );

  completeWith(outcome);
}

export async function searchPromotionTargetsAction(
  search: string,
  scope: "PRODUCT" | "VARIANT",
): Promise<
  Array<{
    id: string;
    label: string;
    scope: "PRODUCT" | "VARIANT";
    productId: string | null;
    variantId: string | null;
  }>
> {
  try {
    await requireCurrentAdmin();
  } catch {
    return [];
  }

  // Promotion targets belong to this storefront's Pancake shop. Configuration is parsed strictly;
  // a missing or invalid shop id fails closed instead of broadening the search to every mirror row.
  const shopId = readPancakeShopId();
  const repository = createPromotionAdminRepository(prisma);

  if (scope === "PRODUCT") {
    const products = await repository.searchTargetProducts({ shopId, search });
    return products.map((p) => ({
      id: p.id,
      label: p.name,
      scope: "PRODUCT" as const,
      productId: p.id,
      variantId: null,
    }));
  }

  const variants = await repository.searchTargetVariants({ shopId, search });
  return variants.map((v) => {
    const details = v.sku || [v.color, v.size].filter(Boolean).join(" / ") || v.id;
    const parent = v.product?.name ? `${v.product.name} — ` : "";
    return {
      id: v.id,
      label: `${parent}${details}`,
      scope: "VARIANT" as const,
      productId: null,
      variantId: v.id,
    };
  });
}

export async function checkPromotionRuntimeHealthAction(
  campaignId: string,
): Promise<CampaignRuntimeHealth | null> {
  try {
    await requireCurrentAdmin();
  } catch {
    return null;
  }
  return evaluateCampaignRuntimeHealth({ campaignId, now: new Date() });
}
