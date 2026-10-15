/**
 * What the tier rows keep when the admin switches what a ladder counts (pieces <-> order value).
 *
 * A rung's threshold means pieces on one basis and VND on the other, so carrying "3" across would turn
 * "buy 3 pieces" into "an order from 3 ₫", and "500.000 ₫" into "500.000 pieces". Thresholds are therefore
 * cleared when the basis really changes and the admin must type them again; a discount value survives only
 * while its unit still means the same thing (a percentage always does; a fixed amount does not cross).
 * Choosing the basis the form is already on changes nothing.
 */
export type TierRowLike = Readonly<{ key: number; min: string; value: string }>;

export function tiersAfterBasisChange<Row extends TierRowLike>(
  rows: readonly Row[],
  from: string,
  to: string,
  unitCleared: boolean,
): Row[] {
  if (from === to) return [...rows];
  return rows.map((row) => ({ ...row, min: "", value: unitCleared ? "" : row.value }));
}
