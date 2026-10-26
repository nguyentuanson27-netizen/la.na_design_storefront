"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { buildVoucherPickerModel } from "../routes/voucher-picker-model.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { parseVoucherCodeInput, parseVoucherDraftInput, parseVoucherSelectionInput } from "./voucher-selection-input.ts";
import { createVoucherSelectionService } from "./voucher-selection-service.ts";
import { readCartOwnVoucherHolds } from "./voucher-own-holds.ts";
import { readVoucherPreview } from "./voucher-preview.ts";
import type { VoucherSelectionIntent } from "./voucher-optimizer.ts";

/**
 * Voucher v1 (V15): the public mutations of the picker. Next Server Actions give POST-only, origin-checked
 * calls; the cart is the HttpOnly bearer cookie, never an argument. These write voucher INTENT only -- they never
 * hold quota or budget and never return a signed quote -- and answer with the freshly derived picker model so the
 * UI shows what the server decided, not what the browser expected (spec §7.3: "không báo thành công chỉ từ click").
 */

async function respond(selected: { ok: boolean }, cartId: string, selectionOverride?: VoucherSelectionIntent) {
  const preview = await readVoucherPreview({ client: prisma, cartId, shopId: readPancakeShopId(), now: new Date(), ownHolds: await readCartOwnVoucherHolds(prisma, cartId), ...(selectionOverride ? { selectionOverride } : {}) });
  if (selected.ok) refresh();
  if (!preview.enabled || !preview.ok) return { picker: null } as const;
  return { picker: buildVoucherPickerModel({ quote: preview.quote, entries: preview.entries, intent: preview.selectionIntent, quoteDigest: preview.quoteDigest }) } as const;
}

export async function setStorefrontVoucherSelection(input: unknown) {
  const parsed = parseVoucherSelectionInput(input);
  const cartId = readAnonymousCartCookie(await cookies());
  if (parsed === null) return { ok: false, reason: "INVALID_INPUT" } as const;
  if (cartId === null) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
  const result = await createVoucherSelectionService(prisma, { shopId: readPancakeShopId() }).setGroup({ cartId, ...parsed });
  if (!result.ok) return { ok: false, reason: result.reason } as const;
  return { ok: true, ...(await respond(result, cartId)) } as const;
}

export async function applyStorefrontVoucherCode(input: unknown) {
  const code = parseVoucherCodeInput(input);
  const cartId = readAnonymousCartCookie(await cookies());
  if (code === null) return { ok: false, reason: "INVALID_CODE" } as const;
  if (cartId === null) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
  const result = await createVoucherSelectionService(prisma, { shopId: readPancakeShopId() }).applyCode({ cartId, rawCode: code });
  if (!result.ok) return { ok: false, reason: result.reason } as const;
  return { ok: true, group: result.group, ...(await respond(result, cartId)) } as const;
}

/** Resolve an ambiguous write by reading the cookie-owned cart; never repeat the write. */
export async function readStorefrontVoucherPicker() {
  const cartId = readAnonymousCartCookie(await cookies());
  if (cartId === null) return { ok: false, picker: null } as const;
  const { picker } = await respond({ ok: false }, cartId);
  return { ok: picker !== null, picker } as const;
}

const intentOf = (draft: { mode: "AUTO" | "MANUAL"; voucherId: string | null }) =>
  draft.mode === "AUTO" ? ({ mode: "AUTO" } as const) : ({ mode: "MANUAL", voucherId: draft.voucherId } as const);

/**
 * Previews the picker's draft as if it were chosen, WITHOUT saving it (spec §7.3: closing or going back keeps the
 * old selection). Nothing is written; the server derives the numbers, the browser only names the intent.
 */
export async function previewStorefrontVoucherDraft(input: unknown) {
  const draft = parseVoucherDraftInput(input);
  const cartId = readAnonymousCartCookie(await cookies());
  if (draft === null) return { ok: false, reason: "INVALID_INPUT" } as const;
  if (cartId === null) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
  const { picker } = await respond({ ok: false }, cartId, { merchandise: intentOf(draft.merchandise), shipping: intentOf(draft.shipping) });
  return picker === null ? ({ ok: false, reason: "QUOTE_UNAVAILABLE" } as const) : ({ ok: true, picker } as const);
}

/** "Áp dụng": commit both groups of the draft in one transaction, then answer with what the server now computes. */
export async function commitStorefrontVoucherDraft(input: unknown) {
  const draft = parseVoucherDraftInput(input);
  const cartId = readAnonymousCartCookie(await cookies());
  if (draft === null) return { ok: false, reason: "INVALID_INPUT" } as const;
  if (cartId === null) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
  const result = await createVoucherSelectionService(prisma, { shopId: readPancakeShopId() }).applyBoth({ cartId, ...draft });
  if (!result.ok) return { ok: false, reason: result.reason } as const;
  return { ok: true, ...(await respond(result, cartId)) } as const;
}
