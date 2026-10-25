/**
 * The single server-side gate for Voucher v1 (V04, ADR 0018 D-6, spec §9.2).
 *
 * Exact-match on the string `"true"`, server environment only; unset, empty, malformed, `"false"`, `1`,
 * `TRUE` and a `NEXT_PUBLIC_` copy are all OFF. Default OFF.
 *
 * What OFF means is deliberately narrow (TG-05 A, AC-47): it stops NEW exposure -- campaign reads for
 * shoppers, selections, quotes with a voucher and new holds. It must NOT stop settling what already
 * exists: consuming a still-valid hold, reconciling a pending redemption and refunding a cancelled one keep
 * running. Callers therefore use `canIssueNewVouchers` for the first group and never consult the gate on the
 * settle path.
 */

export const VOUCHER_ENV = "LA_VOUCHER_ENABLED";

type GateEnvironment = Readonly<Record<string, string | undefined>>;

export function isVoucherEnabled(env: GateEnvironment = process.env): boolean {
  return env[VOUCHER_ENV] === "true";
}

/** New campaign reads for shoppers, selections, voucher quotes and holds. Never the settle path. */
export function canIssueNewVouchers(env: GateEnvironment = process.env): boolean {
  return isVoucherEnabled(env);
}
