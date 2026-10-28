"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthorizationError } from "@/auth/authorization";
import { requireCurrentAdmin } from "@/auth/current-admin";
import { createVoucherAdminService, type VoucherAdminResult } from "@/commerce/voucher-admin-service";
import { parseVoucherCampaignForm, parseVoucherCopyCode, parseVoucherIdentity, parseVoucherTypeForm, parseVoucherTypeIdentity } from "@/commerce/voucher-admin-input";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

const PATH = "/admin/promotions/vouchers";
type Operation = "create" | "edit" | "enable" | "disable" | "copy" | "createType" | "editType";

/** A refused create/edit is ANSWERED to the form, not redirected: a redirect remounts the page and empties what the Admin typed. */
export type VoucherFormRefusal = Readonly<{ reason: string; issue?: string }>;

async function run(operation: Operation, form: FormData): Promise<VoucherFormRefusal | undefined> {
  let destination = `${PATH}?reason=UNAVAILABLE`;
  let refusal: VoucherFormRefusal | undefined;
  try {
    // Each action re-authorizes. Hidden ids/revisions express intent, never authority.
    const session = await requireCurrentAdmin();
    const service = createVoucherAdminService(prisma, readPancakeShopId());
    const isType = operation === "createType" || operation === "editType";
    const identity = operation === "create" || isType ? null : parseVoucherIdentity(form);
    const parsed = operation === "create" || operation === "edit" ? parseVoucherCampaignForm(form) : isType ? parseVoucherTypeForm(form) : null;

    let result: VoucherAdminResult | { ok: false; reason: string; issues?: readonly { code: string }[] };
    if (parsed && !parsed.ok) result = { ok: false, reason: "VALIDATION", issues: parsed.issues };
    else if (operation === "createType" && parsed?.ok) result = await service.createType(session, parsed.input);
    else if (operation === "editType" && parsed?.ok) {
      const typeIdentity = parseVoucherTypeIdentity(form);
      result = typeIdentity === null ? { ok: false, reason: "TYPE_NOT_FOUND" } : await service.editType(session, typeIdentity.id, parsed.input);
    } else if (operation === "create" && parsed?.ok) result = await service.create(session, parsed.input);
    else if (identity === null) result = { ok: false, reason: "STALE_REVISION" };
    else if (operation === "edit" && parsed?.ok) result = await service.edit(session, identity.id, identity.revision, parsed.input);
    else if (operation === "copy") result = await service.copy(session, identity.id, { code: parseVoucherCopyCode(form) });
    else result = await service.setEnabled(session, identity.id, identity.revision, operation === "enable");

    if (result.ok) {
      revalidatePath(PATH);
      destination = `${PATH}?status=ok`;
    } else if (operation === "create" || operation === "edit" || isType) {
      refusal = { reason: result.reason, ...("issues" in result && result.issues?.[0] ? { issue: result.issues[0].code } : {}) };
    } else {
      const target = identity ? `&edit=${encodeURIComponent(identity.id)}` : "";
      destination = `${PATH}?reason=${encodeURIComponent(result.reason)}${target}`;
    }
    console.info(JSON.stringify({ event: "voucher_campaign_admin", operation, outcome: result.ok ? "committed" : "refused" }));
  } catch (error) {
    const forbidden = error instanceof AuthorizationError;
    console.warn(JSON.stringify({ event: "voucher_campaign_admin", operation, outcome: forbidden ? "forbidden" : "unavailable" }));
    destination = `${PATH}?reason=${forbidden ? "FORBIDDEN" : "UNAVAILABLE"}`;
  }
  if (refusal) return refusal;
  // Next redirects throw intentionally; never catch one and report a successful write as a failure.
  redirect(destination);
}

export async function createVoucherTypeAction(form: FormData): Promise<VoucherFormRefusal | undefined> { return run("createType", form); }
export async function editVoucherTypeAction(form: FormData): Promise<VoucherFormRefusal | undefined> { return run("editType", form); }
export async function createVoucherAction(form: FormData): Promise<VoucherFormRefusal | undefined> { return run("create", form); }
export async function editVoucherAction(form: FormData): Promise<VoucherFormRefusal | undefined> { return run("edit", form); }
export async function enableVoucherAction(form: FormData): Promise<void> { await run("enable", form); }
export async function disableVoucherAction(form: FormData): Promise<void> { await run("disable", form); }
export async function copyVoucherAction(form: FormData): Promise<void> { await run("copy", form); }
