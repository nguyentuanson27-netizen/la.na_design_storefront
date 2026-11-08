/** Columns of the gift grid (`grid-cols-3`), at every width. */
export const GIFT_COLUMNS = 3;

/**
 * The gift grid's cells in reading order: every tile where it is, and the open tile's details as one full row right after the
 * last tile of that tile's row. Nothing is reordered (no dense packing), so what is seen, the DOM and the Tab order agree.
 */
export function giftGridCells<T>(cells: readonly Readonly<{ tile: T; detail: T | null }>[], columns = GIFT_COLUMNS): T[] {
  const open = cells.findIndex((cell) => cell.detail !== null);
  const rowEnd = open < 0 ? -1 : Math.min(open - (open % columns) + columns - 1, cells.length - 1);
  return cells.flatMap((cell, index) => (index === rowEnd ? [cell.tile, cells[open]!.detail!] : [cell.tile]));
}
