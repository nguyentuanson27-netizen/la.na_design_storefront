import { createHash } from "node:crypto";

import type { VoucherSelectionIntent } from "./voucher-optimizer.ts";

/**
 * The version of the voucher choice a cart has SAVED: a digest of the two groups' intents (mode and voucher id). The server hands
 * it to the picker with every model; the picker sends back the one it last saw when it commits, and the commit compares it with
 * the saved choice under the cart lock. A draft built on a choice another tab has since changed is then refused whole
 * (`SELECTION_CHANGED`), instead of silently writing its stale half of the choice over the newer one. It derives from the choice
 * itself, not from a timestamp, so two different choices with the same price never share a version.
 */
export function selectionVersionOf(intent: VoucherSelectionIntent): string {
  const part = (group: VoucherSelectionIntent["merchandise"]) => (group.mode === "MANUAL" ? ["MANUAL", group.voucherId ?? null] : ["AUTO", null]);
  return createHash("sha256").update(JSON.stringify([part(intent.merchandise), part(intent.shipping)])).digest("hex");
}
