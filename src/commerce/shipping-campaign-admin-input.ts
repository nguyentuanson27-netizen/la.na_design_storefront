import { parseStrictVietnamDateTime } from "./promotion-admin-input.ts";
import { validateShippingCampaign } from "./shipping-campaign.ts";

/** Duplicate scalar fields and uploaded files are invalid, never a second configuration authority. */
function single(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 0 ? "" : values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

export function parseShippingCampaignForm(form: FormData) {
  const starts = parseStrictVietnamDateTime(single(form, "startsAt"));
  const ends = parseStrictVietnamDateTime(single(form, "endsAt"));
  if (single(form, "startsAt") === null || single(form, "endsAt") === null || !starts.ok || !ends.ok) {
    return { ok: false, reason: "WINDOW_INVALID" } as const;
  }
  const min = single(form, "minimumQuantity");
  const priority = single(form, "priority");
  const stacking = single(form, "stackingEnabled");
  return validateShippingCampaign({
    name: single(form, "name"), startsAt: starts.date, endsAt: ends.date,
    minimumQuantity: min !== null && /^[1-9][0-9]{0,4}$/.test(min) ? Number(min) : NaN,
    priority: priority !== null && /^(0|[1-9][0-9]{0,6})$/.test(priority) ? Number(priority) : NaN,
    stackingEnabled: stacking === "on" ? true : stacking === "" ? false : null,
    scope: { mode: "DYNAMIC_CATEGORY", categoryKeys: form.getAll("categoryKey"),
      includeProductIds: form.getAll("includeProductId"), excludeProductIds: form.getAll("excludeProductId") },
  });
}

export function parseShippingCampaignIdentity(form: FormData): { id: string; revision: number } | null {
  const id = single(form, "campaignId");
  const revision = single(form, "revision");
  if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || revision === null || !/^[1-9][0-9]{0,9}$/.test(revision)) return null;
  const number = Number(revision);
  return number < 2_147_483_647 ? { id, revision: number } : null;
}
