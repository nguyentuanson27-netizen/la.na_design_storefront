/**
 * I7 — immutable preorder facts derived at successful system confirmation.
 *
 * The project authority fixes the storefront business timezone at UTC+7. Vietnam has no DST, so
 * adding a calendar day in that authority timezone is exactly one 24-hour interval. Keeping the
 * operation here, rather than in a UI projection, makes the confirmation-time fact deterministic
 * and testable across month/year/leap boundaries.
 */
export const PREORDER_PREPARATION_DAYS = 15;

const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;

export type PreorderSnapshotLineInput = Readonly<{
  variantId: string;
  quantity: number;
  /** Canonical I4/I5/I6 sellability projection at confirmation time. */
  isPreorderSale: boolean;
}>;

export type PreorderSnapshotLine = Readonly<{
  variantId: string;
  quantity: number;
  state: "READY" | "PREORDER";
  preorderReadyAt: Date | null;
}>;

export type PreorderOrderSnapshot = Readonly<{
  confirmedAt: Date;
  preorderReadyAt: Date | null;
  lines: readonly PreorderSnapshotLine[];
}>;

function requireValidConfirmationTime(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("I7 confirmation time must be a valid Date");
  }
  return value;
}

function requireValidLine(line: PreorderSnapshotLineInput): void {
  if (typeof line.variantId !== "string" || line.variantId.length === 0) {
    throw new TypeError("I7 snapshot variant id must be a non-empty string");
  }
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
    throw new TypeError("I7 snapshot quantity must be a positive safe integer");
  }
  if (typeof line.isPreorderSale !== "boolean") {
    throw new TypeError("I7 snapshot preorder state must be boolean");
  }
}

function addCalendarDays(confirmedAt: Date, days: number): Date {
  const result = new Date(confirmedAt.getTime() + days * CALENDAR_DAY_MS);
  if (Number.isNaN(result.getTime())) {
    throw new TypeError("I7 preorder readiness is outside the supported Date range");
  }
  return result;
}

/**
 * Build the one immutable snapshot that is persisted when the order first becomes CONFIRMED.
 *
 * isPreorderSale is the classification persisted by the canonical capacity authority when the
 * basket was accepted. Confirmation supplies only the clock instant. This function never reads
 * policy, stock or Merchant availability and therefore cannot
 * accidentally turn a later I9 availability date into an order ETA.
 */
export function buildPreorderOrderSnapshot({
  confirmedAt,
  lines,
}: Readonly<{
  confirmedAt: Date;
  lines: readonly PreorderSnapshotLineInput[];
}>): PreorderOrderSnapshot {
  const safeConfirmedAt = requireValidConfirmationTime(confirmedAt);
  if (lines.length === 0) {
    throw new TypeError("I7 preorder snapshot requires at least one order line");
  }

  const preorderReadyAt = lines.some((line) => line.isPreorderSale)
    ? addCalendarDays(safeConfirmedAt, PREORDER_PREPARATION_DAYS)
    : null;

  const snapshotLines = lines.map((line) => {
    requireValidLine(line);
    return Object.freeze({
      variantId: line.variantId,
      quantity: line.quantity,
      state: line.isPreorderSale ? ("PREORDER" as const) : ("READY" as const),
      preorderReadyAt: line.isPreorderSale ? preorderReadyAt : null,
    });
  });

  return Object.freeze({
    confirmedAt: new Date(safeConfirmedAt.getTime()),
    preorderReadyAt,
    lines: Object.freeze(snapshotLines),
  });
}
