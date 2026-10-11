type JsonRecord = Record<string, unknown>;

export type PancakeCreateOrderLineInput = {
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
};

export type PancakeCreateOrderInput = {
  shopId: number;
  /** Pancake order source ID, sent as `account`. Omitted from the request when absent. */
  orderSourceId?: number;
  guestName: string;
  guestPhone: string;
  provinceRef: string;
  /**
   * `null` for the post-2025 two-level address (province → ward/commune), which Pancake takes as
   * `render_type: "new"` with the new ids in `province_id` / `commune_id`. A string only for a checkout snapshotted before the
   * switch, which still carries the old province → district → commune triple.
   */
  districtRef: string | null;
  communeRef: string;
  /**
   * Display names of the province and ward/commune. Required for the two-level address, where
   * Pancake POS shows the "Địa chỉ mới" tab from `province_name` / `commune_name` alongside the ids;
   * ignored for the old three-level triple.
   */
  provinceName?: string;
  communeName?: string;
  addressDetail: string;
  note: string | null;
  shippingFeeVnd: number;
  lines: readonly PancakeCreateOrderLineInput[];
};

type PancakeShippingContact = {
  full_name: string;
  phone_number: string;
  address: string;
};

/** Old three-level address, only for checkouts snapshotted before the two-level switch. */
type PancakeLegacyShippingAddress = PancakeShippingContact & {
  province_id: string;
  district_id: string;
  commune_id: string;
};

/**
 * Post-2025 two-level address, in the shape Pancake POS itself stores for its "Địa chỉ mới" tab:
 * `render_type: "new"`, the new `84_VN…` ids in `province_id` / `commune_id`, a null district and
 * the display names. `new_province_id` / `new_commune_id` are not read by the POS UI, and without
 * `render_type: "new"` the order is treated as an old-format address with empty geo fields.
 */
type PancakeTwoLevelShippingAddress = PancakeShippingContact & {
  render_type: "new";
  province_id: string;
  district_id: null;
  commune_id: string;
  province_name: string;
  commune_name: string;
};

export type PancakeShippingAddress = PancakeLegacyShippingAddress | PancakeTwoLevelShippingAddress;

export type PancakeCreateOrderRequest = {
  shop_id: number;
  account?: number;
  bill_full_name: string;
  bill_phone_number: string;
  shipping_fee: number;
  is_free_shipping: boolean;
  received_at_shop: false;
  shipping_address: PancakeShippingAddress;
  items: Array<{
    variation_id: string;
    quantity: number;
    variation_info: { retail_price: number };
  }>;
  note?: string;
};

export class PancakeCreateOrderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PancakeCreateOrderContractError";
  }
}

function invalidInput(): never {
  throw new PancakeCreateOrderContractError("Pancake create-order input is invalid");
}

function invalidResponse(): never {
  throw new PancakeCreateOrderContractError("Pancake create-order response is invalid");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNormalizedNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    invalidInput();
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidInput();
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidInput();
  }
  return value;
}

export function buildPancakeCreateOrderRequest(
  input: PancakeCreateOrderInput,
): PancakeCreateOrderRequest {
  if (!input || typeof input !== "object") invalidInput();

  const shopId = requirePositiveSafeInteger(input.shopId);
  const orderSourceId =
    input.orderSourceId === undefined ? undefined : requirePositiveSafeInteger(input.orderSourceId);
  const guestName = requireNormalizedNonEmptyString(input.guestName);
  const guestPhone = requireNormalizedNonEmptyString(input.guestPhone);
  const provinceRef = requireNormalizedNonEmptyString(input.provinceRef);
  const districtRef =
    input.districtRef === null ? null : requireNormalizedNonEmptyString(input.districtRef);
  const communeRef = requireNormalizedNonEmptyString(input.communeRef);
  const provinceName =
    districtRef === null ? requireNormalizedNonEmptyString(input.provinceName) : undefined;
  const communeName =
    districtRef === null ? requireNormalizedNonEmptyString(input.communeName) : undefined;
  const addressDetail = requireNormalizedNonEmptyString(input.addressDetail);
  const shippingFeeVnd = requireNonNegativeSafeInteger(input.shippingFeeVnd);

  if (!Array.isArray(input.lines) || input.lines.length === 0) invalidInput();

  const items = input.lines.map((line) => {
    if (!line || typeof line !== "object") invalidInput();
    const variationId = requireNormalizedNonEmptyString(line.pancakeVariationId);
    const quantity = requirePositiveSafeInteger(line.quantity);
    const unitPriceVnd = requireNonNegativeSafeInteger(line.unitPriceVnd);
    const lineTotal = unitPriceVnd * quantity;
    if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) invalidInput();

    return {
      variation_id: variationId,
      quantity,
      variation_info: { retail_price: unitPriceVnd },
    };
  });

  let note: string | undefined;
  if (input.note !== null) {
    note = requireNormalizedNonEmptyString(input.note);
  }

  return {
    shop_id: shopId,
    ...(orderSourceId === undefined ? {} : { account: orderSourceId }),
    bill_full_name: guestName,
    bill_phone_number: guestPhone,
    shipping_fee: shippingFeeVnd,
    is_free_shipping: shippingFeeVnd === 0,
    received_at_shop: false,
    shipping_address:
      districtRef === null
        ? {
            full_name: guestName,
            phone_number: guestPhone,
            address: addressDetail,
            render_type: "new",
            province_id: provinceRef,
            district_id: null,
            commune_id: communeRef,
            province_name: provinceName as string,
            commune_name: communeName as string,
          }
        : {
            full_name: guestName,
            phone_number: guestPhone,
            address: addressDetail,
            province_id: provinceRef,
            district_id: districtRef,
            commune_id: communeRef,
          },
    items,
    ...(note === undefined ? {} : { note }),
  };
}

export function parsePancakeCreateOrderResponse(payload: unknown): string {
  if (!isRecord(payload)) invalidResponse();
  const record = isRecord(payload.data) ? payload.data : payload;
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    invalidResponse();
  }
  return String(id);
}
