"use client";

import {
  applyStorefrontLinkedVoucherCode,
  applyStorefrontVoucherCode,
  commitStorefrontVoucherDraft,
  previewStorefrontVoucherDraft,
} from "@/commerce/voucher-selection-actions";

/**
 * The picker's only door to the server (Voucher v1). Brand markup takes props and callbacks; the commerce reads and
 * writes stay on this headless side of the seam. Every call is a Server Action: POST-only, origin-checked, driven by
 * the HttpOnly cart cookie, and answering with the model the server derived. None of them holds quota or budget.
 */
export function useVoucherPickerActions() {
  return {
    /** The server's numbers for a draft, WITHOUT saving it. */
    previewDraft: previewStorefrontVoucherDraft,
    /** "Áp dụng": commit both groups of the draft in one transaction. */
    commitDraft: commitStorefrontVoucherDraft,
    /** Validate a typed or linked code and, if good, lock it as the manual choice. */
    applyCode: applyStorefrontVoucherCode,
    /** The code a marketing link left on the server (never sent by the browser): same verify, quote and consent as a typed one. */
    applyLinkedCode: applyStorefrontLinkedVoucherCode,
  } as const;
}
