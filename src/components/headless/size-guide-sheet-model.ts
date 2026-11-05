import type { SizeChart } from "../../brand/schema.ts";

/**
 * The phone size-guide sheet's table: one row per size, one column per measurement.
 *
 * The approved charts are stored the other way round (a row per measurement, a column per size).
 * This only turns that around; it authors no number, range, unit or recommendation. A measurement a
 * chart does not carry (the form-vừa chart has no hip row) simply produces no column, so nothing is
 * invented to fill a gap.
 */

export type SizeGuideSheetColumn = Readonly<{
  /** The measurement's name without its unit, e.g. "Ngực". */
  label: string;
  /** The unit the chart declared for that row, e.g. "cm" or "kg"; `null` when it declared none. */
  unit: string | null;
}>;

export type SizeGuideSheetRow = Readonly<{
  size: string;
  /** Aligned with `columns`. */
  cells: readonly string[];
}>;

export type SizeGuideSheetTable = Readonly<{
  columns: readonly SizeGuideSheetColumn[];
  rows: readonly SizeGuideSheetRow[];
}>;

const PARAMETER_WITH_UNIT = /^(.*?)\s*\(([^)]+)\)\s*$/;
const WEIGHT_LABEL = /^cân nặng$/i;

function splitParameter(parameter: string): SizeGuideSheetColumn {
  const match = PARAMETER_WITH_UNIT.exec(parameter);
  if (!match) return Object.freeze({ label: parameter.trim(), unit: null });
  return Object.freeze({ label: match[1]!.trim(), unit: match[2]!.trim() });
}

export function buildSizeGuideSheetTable(chart: SizeChart): SizeGuideSheetTable {
  const measurements = chart.rows.map((row) => ({ row, column: splitParameter(row.parameter) }));
  // Weight leads because it is what a shopper finds first; the rest keep the chart's own order.
  const ordered = [
    ...measurements.filter(({ column }) => WEIGHT_LABEL.test(column.label)),
    ...measurements.filter(({ column }) => !WEIGHT_LABEL.test(column.label)),
  ];

  return Object.freeze({
    columns: Object.freeze(ordered.map(({ column }) => column)),
    rows: Object.freeze(
      chart.sizes.map((size) =>
        Object.freeze({
          size,
          cells: Object.freeze(ordered.map(({ row }) => row.values[size] ?? "")),
        }),
      ),
    ),
  });
}

/** Whether a chart row is the size the shopper has chosen; sizes compare ignoring case and spacing. */
export function isSelectedGuideSize(rowSize: string, selectedSize: string | null): boolean {
  if (selectedSize === null) return false;
  return rowSize.trim().toLowerCase() === selectedSize.trim().toLowerCase();
}

/** The sheet's title: the product's own code when it has one, otherwise the guide's name. */
export function buildSizeGuideSheetTitle(chartTitle: string, productCode: string | null): string {
  const code = productCode?.normalize("NFC").trim();
  return code ? `Bảng size ${code}` : `Bảng size ${chartTitle}`;
}

/** One size the product actually sells, as the purchase selector offers it. */
export type GuideSizeChoice = Readonly<{ value: string; disabled: boolean }>;

/**
 * The selector's own size for a chart row, or `null` when the product does not sell that size.
 *
 * Charts and variants name sizes independently, so the match is by the label alone, ignoring case
 * and spacing. A row with no match stays readable but cannot be picked: nothing is guessed.
 */
export function findGuideSizeChoice(
  rowSize: string,
  choices: readonly GuideSizeChoice[],
): GuideSizeChoice | null {
  const wanted = rowSize.trim().toLowerCase();
  return choices.find((choice) => choice.value.trim().toLowerCase() === wanted) ?? null;
}

export type SizeGuideSheetAction = Readonly<{
  /** The label on the primary button. */
  label: string;
  /** The selector value that button would choose; `null` when it can choose nothing. */
  value: string | null;
  enabled: boolean;
  /** Why the button is off, when the shopper can do something about it or deserves a reason. */
  note: string | null;
}>;

/**
 * What the sheet's primary button does for the row the shopper has picked out.
 *
 * `canChoose` is false while the product still wants a kind first: its sizes are locked then, and
 * choosing one here would bypass the order the selector enforces. `isPending` is true while an add
 * or buy-now is in flight: the selector's own size chips are locked for that time, because the
 * request has already captured the variant it was sent for, and the sheet must not be a way around
 * that. It gets its own sentence so it is never mistaken for the missing-kind case.
 */
export function resolveSizeGuideAction(input: {
  pickedSize: string | null;
  choices: readonly GuideSizeChoice[];
  canChoose: boolean;
  isPending: boolean;
}): SizeGuideSheetAction {
  if (input.pickedSize === null) {
    return Object.freeze({ label: "Chọn một dòng size", value: null, enabled: false, note: null });
  }

  const label = `Chọn size ${input.pickedSize}`;
  const choice = findGuideSizeChoice(input.pickedSize, input.choices);
  if (choice === null) {
    return Object.freeze({ label, value: null, enabled: false, note: "Sản phẩm này không có size này." });
  }
  if (!input.canChoose) {
    return Object.freeze({
      label,
      value: null,
      enabled: false,
      note: "Chọn loại sản phẩm trước, rồi quay lại chọn size.",
    });
  }
  if (input.isPending) {
    return Object.freeze({
      label,
      value: null,
      enabled: false,
      note: "Đang xử lý đơn của nàng, chờ một chút rồi chọn size.",
    });
  }
  if (choice.disabled) {
    return Object.freeze({
      label,
      value: null,
      enabled: false,
      note: "Lựa chọn này hiện chưa mua được.",
    });
  }
  return Object.freeze({ label, value: choice.value, enabled: true, note: null });
}
