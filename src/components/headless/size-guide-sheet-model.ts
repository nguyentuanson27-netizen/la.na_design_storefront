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
