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

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * "Áp dụng" of the picker: the draft, the version of the saved choice it was built on (the server handed it out with the model;
 * a draft built on a choice another tab changed since is refused), plus -- only when the shopper explicitly confirmed losing gifts
 * -- the digest of the quote they confirmed. The consent is a digest and a yes, never a price or a list of gifts: the server
 * recomputes what is lost.
 */
export function parseVoucherCommitInput(input: unknown): Readonly<{ draft: VoucherDraftInput; consentDigest: string | null; selectionVersion: string }> | null {
  if (!exact(input, ["merchandise", "shipping", "selection", "consent"])) return null;
  const draft = parseVoucherDraftInput({ merchandise: (input as { merchandise?: unknown }).merchandise, shipping: (input as { shipping?: unknown }).shipping });
  if (draft === null) return null;
  const { selection, consent } = input as { selection?: unknown; consent?: unknown };
  if (typeof selection !== "string" || !DIGEST.test(selection)) return null;
  if (consent === undefined) return { draft, consentDigest: null, selectionVersion: selection };
  if (!exact(consent, ["acknowledged", "expectedQuoteDigest"])) return null;
  const { acknowledged, expectedQuoteDigest } = consent as { acknowledged?: unknown; expectedQuoteDigest?: unknown };
  if (acknowledged !== true || typeof expectedQuoteDigest !== "string" || !DIGEST.test(expectedQuoteDigest)) return null;
  return { draft, consentDigest: expectedQuoteDigest, selectionVersion: selection };
}

/**
 * A typed code, plus -- only when the shopper explicitly confirmed what the code's choice costs them -- the digest of the quote
 * they confirmed (the same consent as a draft's commit). Anything else, extra keys included, is refused whole.
 */
export function parseVoucherCodeCommitInput(input: unknown): Readonly<{ code: string; consentDigest: string | null }> | null {
  if (!exact(input, ["code", "consent"])) return null;
  const code = parseVoucherCodeInput({ code: (input as { code?: unknown }).code });
  if (code === null) return null;
  const { consent } = input as { consent?: unknown };
  if (consent === undefined) return { code, consentDigest: null };
  if (!exact(consent, ["acknowledged", "expectedQuoteDigest"])) return null;
  const { acknowledged, expectedQuoteDigest } = consent as { acknowledged?: unknown; expectedQuoteDigest?: unknown };
  if (acknowledged !== true || typeof expectedQuoteDigest !== "string" || !DIGEST.test(expectedQuoteDigest)) return null;
  return { code, consentDigest: expectedQuoteDigest };
}
