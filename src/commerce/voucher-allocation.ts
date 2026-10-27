import type { VoucherProductFacts, VoucherScopeResolver } from "./voucher-scope.ts";

/**
 * Voucher v1 (V02): split a merchandise discount `D` over the in-scope paid units (spec §4.1 step 3).
 *
 * The POS only takes line prices, so `D` has to land on units exactly, to the VND, without ever driving
 * a unit under 1đ and without depending on the order the lines arrive in. The rule follows ADR 0016
 * D-13 (the order-value ladder): each line takes `floor(D x lineTotal / S)`; the `R < lines` VND still
 * owed go one apiece to the lines with the largest fractional share (ties: dearer unit, then `lineId`);
 * inside a line the deduction is spread as evenly as whole VND allow, so a line becomes at most two
 * price segments. A line that would fall under 1đ per unit is capped at `quantity x (price - 1)` and the
 * excess is redistributed over the other lines, so `D` is conserved or the allocation is refused.
 *
 * Pure. Lines are post-legacy, post-tier paid lines only; gifts and shipping never arrive here.
 */

export type VoucherPaidLine = Readonly<{
  /** Stable key within the cart (a stacked group key works); the tie-break and the result key. */
  lineId: string;
  product: VoucherProductFacts;
  quantity: number;
  /** Per-unit price after every legacy/tier discount, before the voucher, in whole VND. */
  unitPriceVnd: number;
}>;

export type VoucherSegment = Readonly<{ quantity: number; unitPriceVnd: number }>;

export type VoucherLineAllocation = Readonly<{
  lineId: string;
  /** Total VND taken off this line; 0 when the line is out of scope or takes no share. */
  deductionVnd: number;
  /** The line's units after the deduction, dearer price first; quantities add up to the line quantity. */
  segments: readonly VoucherSegment[];
}>;

export type VoucherAllocation = Readonly<{
  discountVnd: number;
  /** In-scope lines only, ordered by `lineId`. */
  lines: readonly VoucherLineAllocation[];
}>;

export type VoucherAllocationResult =
  | Readonly<{ ok: true; allocation: VoucherAllocation }>
  | Readonly<{ ok: false; reason: "INVALID_INPUT" | "UNIT_PRICE_FLOOR" }>;

export const MAX_VOUCHER_PAID_LINES = 200;
/** Same alphabet as a stacked group key (`line|disc`), so a stack group maps to a voucher line unchanged. */
const LINE_ID_PATTERN = /^[A-Za-z0-9_|-]{1,80}$/;

function isPositiveSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Validates the paid lines once; shared by every voucher calculation so they reject the same input. */
export function validateVoucherPaidLines(lines: readonly VoucherPaidLine[]): boolean {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_VOUCHER_PAID_LINES) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const line of lines) {
    if (
      line === null ||
      typeof line !== "object" ||
      typeof line.lineId !== "string" ||
      !LINE_ID_PATTERN.test(line.lineId) ||
      seen.has(line.lineId) ||
      line.product === null ||
      typeof line.product !== "object" ||
      !isPositiveSafe(line.quantity) ||
      !isPositiveSafe(line.unitPriceVnd)
    ) {
      return false;
    }
    seen.add(line.lineId);
    total += line.quantity * line.unitPriceVnd;
    if (!Number.isSafeInteger(total)) return false;
  }
  return true;
}

type Work = { line: VoucherPaidLine; total: bigint; cap: bigint; share: bigint; capped: boolean };

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function segmentsFor(line: VoucherPaidLine, deduction: number): readonly VoucherSegment[] {
  const { quantity, unitPriceVnd } = line;
  const base = Math.floor(deduction / quantity);
  const dearer = quantity - (deduction - base * quantity); // units that take only `base`
  const cheaper = quantity - dearer; // units that take `base + 1`
  const out: VoucherSegment[] = [];
  if (dearer > 0) out.push({ quantity: dearer, unitPriceVnd: unitPriceVnd - base });
  if (cheaper > 0) out.push({ quantity: cheaper, unitPriceVnd: unitPriceVnd - base - 1 });
  return Object.freeze(out.map((segment) => Object.freeze(segment)));
}

/**
 * Allocates `discountVnd` over the lines the resolver covers. Returns `UNIT_PRICE_FLOOR` when the scope
 * cannot absorb it while keeping every unit at 1đ or more -- never a clamp, never silent rounding.
 */
export function allocateMerchandiseDiscount(input: Readonly<{
  lines: readonly VoucherPaidLine[];
  resolver: VoucherScopeResolver;
  discountVnd: number;
}>): VoucherAllocationResult {
  const { lines, resolver, discountVnd } = input;
  if (!validateVoucherPaidLines(lines) || !isPositiveSafe(discountVnd)) return { ok: false, reason: "INVALID_INPUT" };

  const work: Work[] = lines
    .filter((line) => resolver(line.product))
    .sort((left, right) => compareId(left.lineId, right.lineId))
    .map((line) => ({
      line,
      total: BigInt(line.quantity) * BigInt(line.unitPriceVnd),
      cap: BigInt(line.quantity) * BigInt(line.unitPriceVnd - 1),
      share: BigInt(0),
      capped: false,
    }));

  const target = BigInt(discountVnd);
  if (work.reduce((sum, entry) => sum + entry.cap, BigInt(0)) < target) return { ok: false, reason: "UNIT_PRICE_FLOOR" };

  // Cap every line whose proportional share would breach its floor, then re-share what is left.
  let remaining = target;
  for (;;) {
    const active = work.filter((entry) => !entry.capped && entry.cap > BigInt(0));
    const sum = active.reduce((acc, entry) => acc + entry.total, BigInt(0));
    const breached = active.find((entry) => remaining * entry.total >= entry.cap * sum);
    if (breached === undefined) {
      const fractions = active.map((entry) => {
        entry.share = (remaining * entry.total) / sum;
        return { entry, fraction: (remaining * entry.total) % sum };
      });
      let leftover = remaining - fractions.reduce((acc, item) => acc + item.entry.share, BigInt(0));
      fractions.sort(
        (left, right) =>
          (left.fraction === right.fraction ? 0 : left.fraction > right.fraction ? -1 : 1) ||
          right.entry.line.unitPriceVnd - left.entry.line.unitPriceVnd ||
          compareId(left.entry.line.lineId, right.entry.line.lineId),
      );
      for (const item of fractions) {
        if (leftover === BigInt(0)) break;
        item.entry.share += BigInt(1);
        leftover -= BigInt(1);
      }
      break;
    }
    breached.share = breached.cap;
    breached.capped = true;
    remaining -= breached.cap;
  }

  const allocated: VoucherLineAllocation[] = work.map((entry) => {
    const deductionVnd = Number(entry.share);
    return Object.freeze({
      lineId: entry.line.lineId,
      deductionVnd,
      segments: segmentsFor(entry.line, deductionVnd),
    });
  });
  const total = allocated.reduce((sum, entry) => sum + entry.deductionVnd, 0);
  if (total !== discountVnd) return { ok: false, reason: "INVALID_INPUT" };
  return { ok: true, allocation: Object.freeze({ discountVnd, lines: Object.freeze(allocated) }) };
}
