import type { VoucherAllocation } from "./voucher-allocation.ts";
import type { VoucherQuote } from "./voucher-quote.ts";

/**
 * Voucher v1 (V10): the voucher part of an accepted order, frozen as plain data (spec §3.2 "Order audit").
 *
 * It records what was applied -- which voucher, at which revision, for how many VND, where the discount landed and
 * how shipping resolved -- so an old order never reads current campaign configuration to explain its price. It is
 * versioned (`v: 1`) and parsed strictly: an unknown version or shape is refused, never half-read. The money
 * authority is still the order's own quote snapshot; this is provenance, and it is stored at acceptance (V13) in
 * the same transaction that consumes the hold.
 */

export const VOUCHER_ORDER_SNAPSHOT_VERSION = 1;

export type VoucherOrderSnapshot = Readonly<{
  v: typeof VOUCHER_ORDER_SNAPSHOT_VERSION;
  merchandise: Readonly<{ campaignId: string; campaignRevision: number; amountVnd: number; allocation: readonly Readonly<{ lineId: string; deductionVnd: number }>[] }> | null;
  shipping: Readonly<{ campaignId: string; campaignRevision: number; waivedFeeVnd: number }> | null;
  paidBeforeVnd: number;
  paidAfterVnd: number;
  shippingFeeBeforeVoucherVnd: number;
  shippingFeeVnd: number;
  totalVnd: number;
}>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LINE_ID = /^[A-Za-z0-9_|-]{1,80}$/;
const isVnd = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

export function buildVoucherOrderSnapshot(input: Readonly<{
  quote: Extract<VoucherQuote, { ok: true }>;
  revisions: ReadonlyMap<string, number>;
}>): VoucherOrderSnapshot {
  const { quote, revisions } = input;
  const revision = (id: string) => {
    const value = revisions.get(id);
    if (value === undefined) throw new TypeError("Voucher snapshot references a voucher without a revision");
    return value;
  };
  const allocation: VoucherAllocation | null = quote.allocation;
  const snapshot: VoucherOrderSnapshot = {
    v: VOUCHER_ORDER_SNAPSHOT_VERSION,
    merchandise:
      quote.selection.merchandiseId === null
        ? null
        : {
            campaignId: quote.selection.merchandiseId,
            campaignRevision: revision(quote.selection.merchandiseId),
            amountVnd: quote.merchandiseDiscountVnd,
            allocation: (allocation?.lines ?? []).filter((entry) => entry.deductionVnd > 0).map((entry) => ({ lineId: entry.lineId, deductionVnd: entry.deductionVnd })),
          },
    shipping:
      quote.selection.shippingId === null
        ? null
        : { campaignId: quote.selection.shippingId, campaignRevision: revision(quote.selection.shippingId), waivedFeeVnd: quote.shippingDiscountVnd },
    paidBeforeVnd: quote.paidBeforeVnd,
    paidAfterVnd: quote.paidAfterVnd,
    shippingFeeBeforeVoucherVnd: quote.shippingFeeBeforeVoucherVnd,
    shippingFeeVnd: quote.shippingFeeVnd,
    totalVnd: quote.totalPayableVnd,
  };
  if (parseVoucherOrderSnapshot(snapshot) === null) throw new TypeError("Voucher snapshot is not internally consistent");
  return Object.freeze(snapshot);
}

/** Strict parse of stored/untrusted JSON: an unknown version, extra key, or inconsistent sum returns null. */
export function parseVoucherOrderSnapshot(value: unknown): VoucherOrderSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ["v", "merchandise", "shipping", "paidBeforeVnd", "paidAfterVnd", "shippingFeeBeforeVoucherVnd", "shippingFeeVnd", "totalVnd"];
  if (raw.v !== VOUCHER_ORDER_SNAPSHOT_VERSION || Object.keys(raw).length !== keys.length || !keys.every((key) => key in raw)) return null;
  if (!isVnd(raw.paidBeforeVnd, 1) || !isVnd(raw.paidAfterVnd, 1) || !isVnd(raw.shippingFeeBeforeVoucherVnd) || !isVnd(raw.shippingFeeVnd) || !isVnd(raw.totalVnd, 1)) return null;

  let merchandise: VoucherOrderSnapshot["merchandise"] = null;
  if (raw.merchandise !== null) {
    const m = raw.merchandise as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || !ID.test(String(m.campaignId)) || !isVnd(m.campaignRevision, 1) || !isVnd(m.amountVnd, 1) || !Array.isArray(m.allocation)) return null;
    let deducted = 0;
    const lines: { lineId: string; deductionVnd: number }[] = [];
    for (const entry of m.allocation as unknown[]) {
      const e = entry as Record<string, unknown>;
      if (!e || typeof e.lineId !== "string" || !LINE_ID.test(e.lineId) || !isVnd(e.deductionVnd, 1)) return null;
      deducted += e.deductionVnd;
      lines.push({ lineId: e.lineId, deductionVnd: e.deductionVnd });
    }
    if (deducted !== m.amountVnd) return null;
    merchandise = { campaignId: String(m.campaignId), campaignRevision: m.campaignRevision, amountVnd: m.amountVnd, allocation: lines };
  }
  let shipping: VoucherOrderSnapshot["shipping"] = null;
  if (raw.shipping !== null) {
    const s = raw.shipping as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object" || !ID.test(String(s.campaignId)) || !isVnd(s.campaignRevision, 1) || !isVnd(s.waivedFeeVnd, 1)) return null;
    shipping = { campaignId: String(s.campaignId), campaignRevision: s.campaignRevision, waivedFeeVnd: s.waivedFeeVnd };
  }
  const discount = merchandise?.amountVnd ?? 0;
  if (raw.paidBeforeVnd - discount !== raw.paidAfterVnd) return null;
  if (raw.shippingFeeBeforeVoucherVnd - (shipping?.waivedFeeVnd ?? 0) !== raw.shippingFeeVnd) return null;
  if (raw.paidAfterVnd + raw.shippingFeeVnd !== raw.totalVnd) return null;
  return {
    v: VOUCHER_ORDER_SNAPSHOT_VERSION,
    merchandise,
    shipping,
    paidBeforeVnd: raw.paidBeforeVnd,
    paidAfterVnd: raw.paidAfterVnd,
    shippingFeeBeforeVoucherVnd: raw.shippingFeeBeforeVoucherVnd,
    shippingFeeVnd: raw.shippingFeeVnd,
    totalVnd: raw.totalVnd,
  };
}
