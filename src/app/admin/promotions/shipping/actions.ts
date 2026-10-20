"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthorizationError } from "@/auth/authorization";
import { requireCurrentAdmin } from "@/auth/current-admin";
import { createShippingCampaignAdminService } from "@/commerce/shipping-campaign-admin";
import { parseShippingCampaignForm, parseShippingCampaignIdentity } from "@/commerce/shipping-campaign-admin-input";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

const PATH = "/admin/promotions/shipping";
type Operation = "create" | "edit" | "enable" | "disable";

async function run(operation: Operation, form: FormData): Promise<void> {
  let destination = `${PATH}?reason=UNAVAILABLE`;
  try {
    // Each action re-authorizes. Hidden ids/revisions express intent, never authority.
    const session = await requireCurrentAdmin();
    const service = createShippingCampaignAdminService(prisma, readPancakeShopId());
    const identity = operation === "create" ? null : parseShippingCampaignIdentity(form);
    const parsed = operation === "create" || operation === "edit" ? parseShippingCampaignForm(form) : null;
    const result = parsed && !parsed.ok ? parsed : operation !== "create" && !identity
      ? { ok: false as const, reason: "STALE_REVISION" }
      : operation === "create" && parsed?.ok ? await service.create(session, parsed.value)
      : operation === "edit" && parsed?.ok && identity ? await service.edit(session, identity.id, identity.revision, parsed.value)
      : identity ? await service.setEnabled(session, identity.id, identity.revision, operation === "enable")
      : { ok: false as const, reason: "UNAVAILABLE" };
    if (result.ok) {
      revalidatePath(PATH);
      revalidatePath("/", "layout");
      destination = `${PATH}?status=ok`;
    } else {
      const target = operation === "create" ? "&new=1" : identity ? `&edit=${encodeURIComponent(identity.id)}` : "";
      destination = `${PATH}?reason=${encodeURIComponent(result.reason)}${target}`;
    }
    console.info(JSON.stringify({ event: "shipping_campaign_admin", operation, outcome: result.ok ? "committed" : "refused" }));
  } catch (error) {
    const forbidden = error instanceof AuthorizationError;
    console.warn(JSON.stringify({ event: "shipping_campaign_admin", operation, outcome: forbidden ? "forbidden" : "unavailable" }));
    destination = `${PATH}?reason=${forbidden ? "FORBIDDEN" : "UNAVAILABLE"}`;
  }
  // Next redirects throw intentionally; never catch one and report a successful write as a failure.
  redirect(destination);
}

export async function createShippingCampaignAction(form: FormData): Promise<void> { await run("create", form); }
export async function editShippingCampaignAction(form: FormData): Promise<void> { await run("edit", form); }
export async function enableShippingCampaignAction(form: FormData): Promise<void> { await run("enable", form); }
export async function disableShippingCampaignAction(form: FormData): Promise<void> { await run("disable", form); }
