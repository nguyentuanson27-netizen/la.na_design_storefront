/**
 * Voucher v1 (V15): strict parsing of what the browser may send about vouchers. Only intent crosses the wire:
 * a group, AUTO/manual, a voucher id (or null for "no voucher"), or a code. No price, no revision, no cart id, no
 * eligibility -- the server derives all of that, and rejects any extra key rather than ignoring it.
 */

export type VoucherSelectionInput = Readonly<{ group: "MERCHANDISE" | "SHIPPING_FREE"; mode: "AUTO" | "MANUAL"; voucherId: string | null }>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseVoucherSelectionInput(input: unknown): VoucherSelectionInput | null {
  if (!exact(input, ["group", "mode", "voucherId"])) return null;
  const { group, mode } = input;
  if (group !== "MERCHANDISE" && group !== "SHIPPING_FREE") return null;
  if (mode !== "AUTO" && mode !== "MANUAL") return null;
  const voucherId = input.voucherId === undefined ? null : input.voucherId;
  if (voucherId !== null && (typeof voucherId !== "string" || !ID.test(voucherId))) return null;
  if (mode === "AUTO" && voucherId !== null) return null;
  return { group, mode, voucherId };
}

export function parseVoucherCodeInput(input: unknown): string | null {
  if (!exact(input, ["code"])) return null;
  const { code } = input;
  return typeof code === "string" && code.trim().length > 0 && code.length <= 64 ? code : null;
}

export type VoucherDraftInput = Readonly<{
  merchandise: Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;
  shipping: Readonly<{ mode: "AUTO" | "MANUAL"; voucherId: string | null }>;
}>;

function group(value: unknown): VoucherDraftInput["merchandise"] | null {
  if (!exact(value, ["mode", "voucherId"])) return null;
  const { mode } = value;
  if (mode !== "AUTO" && mode !== "MANUAL") return null;
  const voucherId = value.voucherId === undefined ? null : value.voucherId;
  if (voucherId !== null && (typeof voucherId !== "string" || !ID.test(voucherId))) return null;
  if (mode === "AUTO" && voucherId !== null) return null;
  return { mode, voucherId };
}

/** The picker's whole draft: one intent per group, nothing else. */
export function parseVoucherDraftInput(input: unknown): VoucherDraftInput | null {
  if (!exact(input, ["merchandise", "shipping"])) return null;
  const merchandise = group(input.merchandise);
  const shipping = group(input.shipping);
  return merchandise === null || shipping === null ? null : { merchandise, shipping };
}
