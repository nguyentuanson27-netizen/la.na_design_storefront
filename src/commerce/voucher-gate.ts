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

/**
 * ADR 0019 D-6: a shop may be GRANTED a hold only after the operator-run POS probe passed for it
 * (`docs/integrations/pancake-voucher-acceptance.md` §4). Same fail-closed list format as the line-level
 * pricing gate; unset, empty or malformed entries never match. The settle path never consults this.
 */
export const VOUCHER_VERIFIED_SHOPS_ENV = "LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS";

export function readVoucherVerifiedShopIds(env: GateEnvironment = process.env): readonly number[] {
  const raw = env[VOUCHER_VERIFIED_SHOPS_ENV];
  if (typeof raw !== "string") return [];
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (!/^[1-9][0-9]{0,14}$/.test(text)) continue;
    const id = Number(text);
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A NEW hold: the feature gate is on AND this shop's POS acceptance is recorded. */
export function canGrantVoucherHolds(shopId: number, env: GateEnvironment = process.env): boolean {
  return canIssueNewVouchers(env) && readVoucherVerifiedShopIds(env).includes(shopId);
}
