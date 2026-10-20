export type GuestShippingPolicy = Readonly<{
  feeVnd: number;
  freeShippingSubtotalVnd: number;
  freeShippingMinQuantity: number;
  freeShippingMinSetQuantity?: number;
}>;

export const DEFAULT_GUEST_SHIPPING_POLICY: GuestShippingPolicy = Object.freeze({
  feeVnd: 30_000,
  freeShippingSubtotalVnd: 0,
  freeShippingMinQuantity: 0,
  freeShippingMinSetQuantity: 2,
});

export const GUEST_SHIPPING_FEE_VND = DEFAULT_GUEST_SHIPPING_POLICY.feeVnd;
export const GUEST_FREE_SHIPPING_SUBTOTAL_VND =
  DEFAULT_GUEST_SHIPPING_POLICY.freeShippingSubtotalVnd;
export const GUEST_FREE_SHIPPING_MIN_QUANTITY =
  DEFAULT_GUEST_SHIPPING_POLICY.freeShippingMinQuantity;
export const GUEST_FREE_SHIPPING_MIN_SET_QUANTITY = 2;

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
      0,
    ),
    freeShippingMinSetQuantity: parseConfiguredInteger(
      "LA_FREE_SHIPPING_MIN_SET_QUANTITY",
      env.LA_FREE_SHIPPING_MIN_SET_QUANTITY,
      GUEST_FREE_SHIPPING_MIN_SET_QUANTITY,
      0,
    ),
  });
}

/**
 * The policy, or `undefined` when the environment holds an invalid one. For display surfaces that show an
 * estimate: a misconfigured fee must hide the estimate, not take the cart page down. Checkout and the order
 * path keep calling `readGuestShippingPolicy`, which fails loudly.
 */
export function tryReadGuestShippingPolicy(env: ShippingPolicyEnvironment = process.env): GuestShippingPolicy | undefined {
  try {
    return readGuestShippingPolicy(env);
  } catch {
    return undefined;
  }
}

function resolveMinSetQuantity(policy: GuestShippingPolicy): number {
  if (policy.freeShippingMinSetQuantity !== undefined) {
    return policy.freeShippingMinSetQuantity;
  }
  return policy.freeShippingMinQuantity > 0 || policy.freeShippingSubtotalVnd > 0
    ? 0
    : GUEST_FREE_SHIPPING_MIN_SET_QUANTITY;
}

export function calculateGuestShippingFeeVnd(
  {
    subtotalVnd,
    totalQuantity,
    qualifyingSetQuantity = 0,
  }: {
    subtotalVnd: number;
    totalQuantity: number;
    qualifyingSetQuantity?: number;
  },
  policy: GuestShippingPolicy = readGuestShippingPolicy(),
): number {
  if (!Number.isSafeInteger(subtotalVnd) || subtotalVnd < 0) {
    throw new RangeError("Guest checkout subtotal must be a safe non-negative integer VND amount");
  }
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) {
    throw new RangeError("Guest checkout total quantity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(qualifyingSetQuantity) || qualifyingSetQuantity < 0) {
    throw new RangeError("Guest checkout qualifying set quantity must be a non-negative safe integer");
  }
  const minSetQuantity = resolveMinSetQuantity(policy);
  if (
    !Number.isSafeInteger(policy.feeVnd) ||
    policy.feeVnd < 0 ||
    !Number.isSafeInteger(policy.freeShippingSubtotalVnd) ||
    policy.freeShippingSubtotalVnd < 0 ||
    !Number.isSafeInteger(policy.freeShippingMinQuantity) ||
    policy.freeShippingMinQuantity < 0 ||
    !Number.isSafeInteger(minSetQuantity) ||
    minSetQuantity < 0
  ) {
    throw new RangeError("Guest shipping policy is invalid");
  }

  if (
    minSetQuantity > 0 &&
    qualifyingSetQuantity >= minSetQuantity
  ) {
    return 0;
  }
  if (policy.freeShippingSubtotalVnd > 0 && subtotalVnd > policy.freeShippingSubtotalVnd) {
    return 0;
  }
  if (policy.freeShippingMinQuantity > 0 && totalQuantity >= policy.freeShippingMinQuantity) {
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
  const minSetQuantity = resolveMinSetQuantity(policy);
  if (minSetQuantity > 0) {
    return `Free ship khi mua từ ${minSetQuantity} Set`;
  }
  if (policy.freeShippingMinQuantity > 0 && policy.freeShippingSubtotalVnd > 0) {
    return `Free ship từ ${policy.freeShippingMinQuantity} sản phẩm hoặc đơn trên ${describeCompactVnd(policy.freeShippingSubtotalVnd)}`;
  }
  if (policy.freeShippingSubtotalVnd > 0) {
    return `Free ship cho đơn trên ${describeCompactVnd(policy.freeShippingSubtotalVnd)}`;
  }
  if (policy.freeShippingMinQuantity > 0) {
    return `Free ship từ ${policy.freeShippingMinQuantity} sản phẩm`;
  }
  return "Phí ship 30.000 ₫ toàn quốc";
}

export function describeGuestShippingPromotion(policy: GuestShippingPolicy): {
  title: string;
  detail: string;
} {
  calculateGuestShippingFeeVnd({ subtotalVnd: 0, totalQuantity: 1 }, policy);
  const minSetQuantity = resolveMinSetQuantity(policy);
  if (minSetQuantity > 0) {
    return {
      title: "Miễn phí vận chuyển",
      detail: `Miễn phí vận chuyển khi mua từ ${minSetQuantity} Set.`,
    };
  }
  if (policy.freeShippingMinQuantity > 0 && policy.freeShippingSubtotalVnd > 0) {
    return {
      title: "Miễn phí vận chuyển",
      detail: `Đơn trên ${currency.format(policy.freeShippingSubtotalVnd)} hoặc từ ${policy.freeShippingMinQuantity} sản phẩm.`,
    };
  }
  return {
    title: "Vận chuyển toàn quốc",
    detail: `Phí vận chuyển ${currency.format(policy.feeVnd)} trên toàn quốc.`,
  };
}
