export type GuestShippingPolicy = Readonly<{
  feeVnd: number;
  freeShippingSubtotalVnd: number;
  freeShippingMinQuantity: number;
}>;

export const DEFAULT_GUEST_SHIPPING_POLICY: GuestShippingPolicy = Object.freeze({
  feeVnd: 30_000,
  freeShippingSubtotalVnd: 1_000_000,
  freeShippingMinQuantity: 3,
});

export const GUEST_SHIPPING_FEE_VND = DEFAULT_GUEST_SHIPPING_POLICY.feeVnd;
export const GUEST_FREE_SHIPPING_SUBTOTAL_VND =
  DEFAULT_GUEST_SHIPPING_POLICY.freeShippingSubtotalVnd;
export const GUEST_FREE_SHIPPING_MIN_QUANTITY =
  DEFAULT_GUEST_SHIPPING_POLICY.freeShippingMinQuantity;

const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});
const plainInteger = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

type ShippingPolicyEnvironment = Readonly<Record<string, string | undefined>>;

function parseConfiguredInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  if (!DECIMAL_INTEGER.test(value)) {
    throw new RangeError(`${name} must be a canonical non-negative base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(`${name} is outside the supported safe-integer range`);
  }
  return parsed;
}

export function readGuestShippingPolicy(
  env: ShippingPolicyEnvironment = process.env,
): GuestShippingPolicy {
  return Object.freeze({
    feeVnd: parseConfiguredInteger(
      "LA_SHIPPING_FEE_VND",
      env.LA_SHIPPING_FEE_VND,
      DEFAULT_GUEST_SHIPPING_POLICY.feeVnd,
      0,
    ),
    freeShippingSubtotalVnd: parseConfiguredInteger(
      "LA_FREE_SHIPPING_SUBTOTAL_VND",
      env.LA_FREE_SHIPPING_SUBTOTAL_VND,
      DEFAULT_GUEST_SHIPPING_POLICY.freeShippingSubtotalVnd,
      0,
    ),
    freeShippingMinQuantity: parseConfiguredInteger(
      "LA_FREE_SHIPPING_MIN_QUANTITY",
      env.LA_FREE_SHIPPING_MIN_QUANTITY,
      DEFAULT_GUEST_SHIPPING_POLICY.freeShippingMinQuantity,
      1,
    ),
  });
}

export function calculateGuestShippingFeeVnd(
  {
    subtotalVnd,
    totalQuantity,
  }: {
    subtotalVnd: number;
    totalQuantity: number;
  },
  policy: GuestShippingPolicy = readGuestShippingPolicy(),
): number {
  if (!Number.isSafeInteger(subtotalVnd) || subtotalVnd < 0) {
    throw new RangeError("Guest checkout subtotal must be a safe non-negative integer VND amount");
  }
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) {
    throw new RangeError("Guest checkout total quantity must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(policy.feeVnd) ||
    policy.feeVnd < 0 ||
    !Number.isSafeInteger(policy.freeShippingSubtotalVnd) ||
    policy.freeShippingSubtotalVnd < 0 ||
    !Number.isSafeInteger(policy.freeShippingMinQuantity) ||
    policy.freeShippingMinQuantity <= 0
  ) {
    throw new RangeError("Guest shipping policy is invalid");
  }

  if (subtotalVnd > policy.freeShippingSubtotalVnd) {
    return 0;
  }
  if (totalQuantity >= policy.freeShippingMinQuantity) {
    return 0;
  }

  return policy.feeVnd;
}

/**
 * Rounds a threshold to the shortest phrase that still states it exactly, so the promotion bar
 * can say "1 triệu" instead of "1.000.000 ₫". Anything without an exact short form keeps the
 * full currency format rather than being rounded into a claim the policy does not make. Once the
 * amount reaches a million the thousands form is off the table even when it would be exact:
 * 1.500.000 as "1.500 nghìn" is longer than the number it replaces and misreads as 1.500 ₫.
 */
function describeCompactVnd(amountVnd: number): string {
  if (amountVnd >= 1_000_000) {
    return amountVnd % 1_000_000 === 0
      ? `${plainInteger.format(amountVnd / 1_000_000)} triệu`
      : currency.format(amountVnd);
  }
  if (amountVnd >= 1_000 && amountVnd % 1_000 === 0) {
    return `${plainInteger.format(amountVnd / 1_000)} nghìn`;
  }
  return currency.format(amountVnd);
}

/**
 * Single-line headline for the promotion bar, which is pinned above every page and therefore has
 * one line to spend. The footer and the shipping page keep the full sentence from
 * describeGuestShippingPromotion, where there is room for the exact amount.
 */
export function describeGuestShippingPromotionHeadline(policy: GuestShippingPolicy): string {
  calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  return `Free ship từ ${policy.freeShippingMinQuantity} sản phẩm hoặc đơn trên ${describeCompactVnd(policy.freeShippingSubtotalVnd)}`;
}

export function describeGuestShippingPromotion(policy: GuestShippingPolicy): {
  title: string;
  detail: string;
} {
  calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  return {
    title: "Miễn phí vận chuyển",
    detail: `Đơn trên ${currency.format(policy.freeShippingSubtotalVnd)} hoặc từ ${policy.freeShippingMinQuantity} sản phẩm.`,
  };
}
