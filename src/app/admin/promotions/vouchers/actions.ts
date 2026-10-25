"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthorizationError } from "@/auth/authorization";
import { requireCurrentAdmin } from "@/auth/current-admin";
import { createVoucherAdminService, type VoucherAdminResult } from "@/commerce/voucher-admin-service";
import { parseVoucherCampaignForm, parseVoucherCopyCode, parseVoucherIdentity } from "@/commerce/voucher-admin-input";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

const PATH = "/admin/promotions/vouchers";
type Operation = "create" | "edit" | "enable" | "disable" | "copy";

async function run(operation: Operation, form: FormData): Promise<void> {
  let destination = `${PATH}?reason=UNAVAILABLE`;
  try {
    // Each action re-authorizes. Hidden ids/revisions express intent, never authority.
    const session = await requireCurrentAdmin();
    const service = createVoucherAdminService(prisma, readPancakeShopId());
    const identity = operation === "create" ? null : parseVoucherIdentity(form);
    const parsed = operation === "create" || operation === "edit" ? parseVoucherCampaignForm(form) : null;

    let result: VoucherAdminResult | { ok: false; reason: string; issues?: readonly { code: string }[] };
    if (parsed && !parsed.ok) result = { ok: false, reason: "VALIDATION", issues: parsed.issues };
    else if (operation === "create" && parsed?.ok) result = await service.create(session, parsed.input);
    else if (identity === null) result = { ok: false, reason: "STALE_REVISION" };
    else if (operation === "edit" && parsed?.ok) result = await service.edit(session, identity.id, identity.revision, parsed.input);
    else if (operation === "copy") result = await service.copy(session, identity.id, { code: parseVoucherCopyCode(form) });
    else result = await service.setEnabled(session, identity.id, identity.revision, operation === "enable");

    if (result.ok) {
      revalidatePath(PATH);
      destination = `${PATH}?status=ok`;
    } else {
      const target = operation === "create" ? "&new=1" : identity ? `&edit=${encodeURIComponent(identity.id)}` : "";
      const issue = "issues" in result && result.issues?.[0] ? `&issue=${encodeURIComponent(result.issues[0].code)}` : "";
      destination = `${PATH}?reason=${encodeURIComponent(result.reason)}${issue}${target}`;
    }
    console.info(JSON.stringify({ event: "voucher_campaign_admin", operation, outcome: result.ok ? "committed" : "refused" }));
  } catch (error) {
    const forbidden = error instanceof AuthorizationError;
    console.warn(JSON.stringify({ event: "voucher_campaign_admin", operation, outcome: forbidden ? "forbidden" : "unavailable" }));
    destination = `${PATH}?reason=${forbidden ? "FORBIDDEN" : "UNAVAILABLE"}`;
  }
  // Next redirects throw intentionally; never catch one and report a successful write as a failure.
  redirect(destination);
}

export async function createVoucherAction(form: FormData): Promise<void> { await run("create", form); }
export async function editVoucherAction(form: FormData): Promise<void> { await run("edit", form); }
export async function enableVoucherAction(form: FormData): Promise<void> { await run("enable", form); }
export async function disableVoucherAction(form: FormData): Promise<void> { await run("disable", form); }
export async function copyVoucherAction(form: FormData): Promise<void> { await run("copy", form); }
