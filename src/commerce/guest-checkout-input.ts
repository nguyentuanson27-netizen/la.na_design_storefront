import { normalizeAdAttributionNote } from "./ad-attribution.ts";
import { parsePaymentMethod, type PaymentMethod } from "./bank-transfer.ts";
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
  /** `COD` unless the shopper picked bank transfer; the public action refuses it while it is off. */
  paymentMethod: PaymentMethod;
  /**
   * The `[UTM] …` line for an order that came from an ad (see `ad-attribution.ts`). Never typed by
   * the shopper: the public action fills it from the `la_utm` cookie, and it is kept apart from
   * `note` so re-parsing a validated input cannot push the shopper's own note over its length limit.
   */
  attribution: string | null;
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
  const paymentMethod = parsePaymentMethod(input.paymentMethod);

  if (!name || !typedPhone || !provinceRef || !communeRef || !detail || !note.ok || !paymentMethod) {
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
      paymentMethod,
      attribution: normalizeAdAttributionNote(input.attribution),
    },
  };
}
