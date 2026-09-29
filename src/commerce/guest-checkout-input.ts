import { normalizeVietnamPhone } from "./vietnam-phone.ts";

const MAX_GUEST_CHECKOUT_TEXT_LENGTH = 2_048;

type GuestCheckoutValue = {
  name: string;
  /** National form, e.g. `0912345678` — see `vietnam-phone.ts`. */
  phone: string;
  /**
   * The post-2025 two-level address: a province and a ward/commune inside it, no district. The
   * field is kept (always `null` for new checkouts) so an order row still says which shape it is.
   */
  provinceRef: string;
  districtRef: null;
  communeRef: string;
  detail: string;
  note: string | null;
};

type GuestCheckoutInputResult =
  | { ok: true; value: GuestCheckoutValue }
  | { ok: false; reason: "INVALID_INPUT" | "INVALID_PHONE" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequiredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GUEST_CHECKOUT_TEXT_LENGTH) return null;
  return trimmed;
}

function parseOptionalNote(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_GUEST_CHECKOUT_TEXT_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
}

export function parseGuestCheckoutInput(input: unknown): GuestCheckoutInputResult {
  if (!isRecord(input)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const name = parseRequiredText(input.name);
  const typedPhone = parseRequiredText(input.phone);
  const provinceRef = parseRequiredText(input.provinceRef);
  const communeRef = parseRequiredText(input.communeRef);
  const detail = parseRequiredText(input.detail);
  const note = parseOptionalNote(input.note);

  if (!name || !typedPhone || !provinceRef || !communeRef || !detail || !note.ok) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const phone = normalizeVietnamPhone(typedPhone);
  if (!phone) {
    return { ok: false, reason: "INVALID_PHONE" };
  }

  return {
    ok: true,
    value: {
      name,
      phone,
      provinceRef,
      districtRef: null,
      communeRef,
      detail,
      note: note.value,
    },
  };
}
