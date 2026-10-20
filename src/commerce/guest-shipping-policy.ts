/** Base delivery price only. Promotions are evaluated by shipping-campaign.ts, never environment thresholds. */
export type GuestShippingPolicy = Readonly<{ feeVnd: number }>;

export const DEFAULT_GUEST_SHIPPING_POLICY: GuestShippingPolicy = Object.freeze({ feeVnd: 30_000 });
export const GUEST_SHIPPING_FEE_VND = DEFAULT_GUEST_SHIPPING_POLICY.feeVnd;

type ShippingPolicyEnvironment = Readonly<Record<string, string | undefined>>;
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

export function readGuestShippingPolicy(env: ShippingPolicyEnvironment = process.env): GuestShippingPolicy {
  const raw = env.LA_SHIPPING_FEE_VND;
  if (raw === undefined) return DEFAULT_GUEST_SHIPPING_POLICY;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new RangeError("LA_SHIPPING_FEE_VND must be a canonical non-negative base-10 integer");
  const feeVnd = Number(raw);
  if (!Number.isSafeInteger(feeVnd)) throw new RangeError("LA_SHIPPING_FEE_VND is outside the supported safe-integer range");
  // Old LA_FREE_SHIPPING_* variables are deliberately not read, even when still present on a VPS.
  return Object.freeze({ feeVnd });
}

/** An unreadable estimate is hidden; checkout uses the throwing reader and refuses an unknown quote. */
export function tryReadGuestShippingPolicy(env: ShippingPolicyEnvironment = process.env): GuestShippingPolicy | undefined {
  try { return readGuestShippingPolicy(env); } catch { return undefined; }
}

/** Retains the quote's safe-integer guards, but quantity and subtotal can no longer waive delivery. */
export function calculateGuestShippingFeeVnd(
  { subtotalVnd, totalQuantity }: { subtotalVnd: number; totalQuantity: number },
  policy: GuestShippingPolicy = readGuestShippingPolicy(),
): number {
  if (!Number.isSafeInteger(subtotalVnd) || subtotalVnd < 0) throw new RangeError("Guest checkout subtotal must be a safe non-negative integer VND amount");
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) throw new RangeError("Guest checkout total quantity must be a positive safe integer");
  if (!Number.isSafeInteger(policy.feeVnd) || policy.feeVnd < 0) throw new RangeError("Guest shipping policy is invalid");
  return policy.feeVnd;
}

/** Base-policy copy only; active promotion copy is supplied separately from the campaign read. */
export function describeGuestShippingPromotionHeadline(policy: GuestShippingPolicy): string {
  calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  return `Phí vận chuyển cơ bản ${currency.format(policy.feeVnd)}`;
}

export function describeGuestShippingPromotion(policy: GuestShippingPolicy): { title: string; detail: string } {
  calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  return {
    title: "Vận chuyển toàn quốc",
    detail: `Phí vận chuyển cơ bản ${currency.format(policy.feeVnd)}. Ưu đãi vận chuyển, nếu có, được kiểm tra theo chiến dịch đang hiệu lực khi đặt hàng.`,
  };
}
