/**
 * Server Action input parsing for gift / quantity-tier admin drafts (GQ05).
 *
 * Same principles as `promotion-admin-input.ts`: every enum is an exact allowlist with no coercion,
 * identifiers are trimmed but never truncated (an oversized id must reach the validator and be
 * refused, not be silently cut), list inputs are capped at one past their bound so the domain
 * validator can report "too many" instead of the parser hiding it, and dates are strict Vietnam
 * time. The parser only describes what the browser sent; the server validators decide what is
 * allowed, so none of this is trusted for correctness.
 */

import { parseStrictVietnamDateTime } from "./promotion-admin-input.ts";
import {
  MAX_SCOPE_CATEGORIES,
  MAX_SCOPE_EXCLUDED_PRODUCTS,
  MAX_SCOPE_INCLUDED_PRODUCTS,
} from "./gift-quantity-scope.ts";

export const GIFT_QUANTITY_KINDS = ["GIFT_ITEM", "QUANTITY_TIER"] as const;
export type GiftQuantityKind = (typeof GIFT_QUANTITY_KINDS)[number];

export const GIFT_QUANTITY_SCOPE_MODES = ["GLOBAL_ALL_PAID_LINES", "DYNAMIC_CATEGORY", "FIXED_PRODUCT_SET"] as const;
export type GiftQuantityScopeModeValue = (typeof GIFT_QUANTITY_SCOPE_MODES)[number];

export const GIFT_TRIGGERS = ["QUANTITY", "ORDER_SUBTOTAL"] as const;
export const GIFT_SUBTOTAL_SCOPES = ["ALL_PAID_LINES", "ELIGIBLE_PAID_LINES"] as const;

/** What a Draft form carries: identity, window, scope, and the gift fields that decide the scope's shape. */
export type GiftQuantityDraftValues = Readonly<{
  kind: GiftQuantityKind;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  scopeMode: GiftQuantityScopeModeValue;
  categoryKeys: readonly string[];
  includeProductIds: readonly string[];
  excludeProductIds: readonly string[];
  /** GIFT_ITEM only: which trigger the gift uses; null until chosen (and always null for a tier). */
  giftTrigger: (typeof GIFT_TRIGGERS)[number] | null;
  /** GIFT_ITEM + ORDER_SUBTOTAL only. */
  subtotalScope: (typeof GIFT_SUBTOTAL_SCOPES)[number] | null;
}>;

export type GiftQuantityDraftParseReason =
  | "INVALID_KIND"
  | "INVALID_SCOPE_MODE"
  | "INVALID_GIFT_TRIGGER"
  | "INVALID_SUBTOTAL_SCOPE"
  | "INVALID_DATE_TIME";

export type ParsedGiftQuantityDraft =
  | Readonly<{ ok: true; value: GiftQuantityDraftValues }>
  | Readonly<{ ok: false; reason: GiftQuantityDraftParseReason }>;

function allowlisted<T extends string>(raw: FormDataEntryValue | null, allowed: readonly T[]): T | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function strings(formData: FormData, field: string, max: number): string[] {
  return formData
    .getAll(field)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, max + 1);
}

export function parseGiftQuantityDraftForm(formData: FormData): ParsedGiftQuantityDraft {
  const kind = allowlisted(formData.get("kind"), GIFT_QUANTITY_KINDS);
  if (kind === null) return { ok: false, reason: "INVALID_KIND" };

  const scopeMode = allowlisted(formData.get("scopeMode"), GIFT_QUANTITY_SCOPE_MODES);
  if (scopeMode === null) return { ok: false, reason: "INVALID_SCOPE_MODE" };

  let giftTrigger: GiftQuantityDraftValues["giftTrigger"] = null;
  let subtotalScope: GiftQuantityDraftValues["subtotalScope"] = null;
  if (kind === "GIFT_ITEM") {
    const rawTrigger = formData.get("giftTrigger");
    if (typeof rawTrigger === "string" && rawTrigger.trim().length > 0) {
      giftTrigger = allowlisted(rawTrigger, GIFT_TRIGGERS);
      if (giftTrigger === null) return { ok: false, reason: "INVALID_GIFT_TRIGGER" };
    }
    // The subtotal scope only exists for the subtotal trigger; a stray value for any other trigger
    // is ignored rather than stored, so the persisted row never holds two competing readings.
    const rawScope = formData.get("subtotalScope");
    if (giftTrigger === "ORDER_SUBTOTAL" && typeof rawScope === "string" && rawScope.trim().length > 0) {
      subtotalScope = allowlisted(rawScope, GIFT_SUBTOTAL_SCOPES);
      if (subtotalScope === null) return { ok: false, reason: "INVALID_SUBTOTAL_SCOPE" };
    }
  }

  const startsAt = parseStrictVietnamDateTime(formData.get("startsAt"));
  const endsAt = parseStrictVietnamDateTime(formData.get("endsAt"));
  if (!startsAt.ok || !endsAt.ok) return { ok: false, reason: "INVALID_DATE_TIME" };

  const rawName = formData.get("name");
  return {
    ok: true,
    value: {
      kind,
      name: typeof rawName === "string" ? rawName : "",
      startsAt: startsAt.date,
      endsAt: endsAt.date,
      scopeMode,
      // Passed through exactly as sent. A global scope with targets is a contradiction the server
      // validator refuses (spec FR-02); the parser must not quietly repair it.
      categoryKeys: strings(formData, "categoryKey", MAX_SCOPE_CATEGORIES),
      includeProductIds: strings(formData, "includeProductId", MAX_SCOPE_INCLUDED_PRODUCTS),
      excludeProductIds: strings(formData, "excludeProductId", MAX_SCOPE_EXCLUDED_PRODUCTS),
      giftTrigger,
      subtotalScope,
    },
  };
}

/**
 * The admin form edits times at minute precision (`datetime-local`), so saving a campaign whose
 * stored time carries seconds would otherwise turn an untouched field into a one-minute-off "edit".
 * When the submitted value is exactly the stored instant rounded down to its minute, the field was
 * not changed and the stored instant is kept. Any other value is a real edit and is used as sent.
 */
export function keepStoredInstantIfUnchangedAtMinute(submitted: Date | null, stored: Date | null): Date | null {
  if (submitted === null || stored === null) return submitted;
  const storedMinute = Math.floor(stored.getTime() / 60_000) * 60_000;
  return submitted.getTime() === storedMinute ? stored : submitted;
}
