type JsonRecord = Record<string, unknown>;

export type PancakeCreateOrderLineInput = {
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
};

export type PancakeCreateOrderInput = {
  shopId: number;
  guestName: string;
  guestPhone: string;
  provinceRef: string;
  districtRef: string;
  communeRef: string;
  addressDetail: string;
  note: string | null;
  shippingFeeVnd: number;
  lines: readonly PancakeCreateOrderLineInput[];
};

export type PancakeCreateOrderRequest = {
  shop_id: number;
  bill_full_name: string;
  bill_phone_number: string;
  shipping_fee: number;
  is_free_shipping: boolean;
  received_at_shop: false;
  shipping_address: {
    full_name: string;
    phone_number: string;
    address: string;
    province_id: string;
    district_id: string;
    commune_id: string;
  };
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
  const guestName = requireNormalizedNonEmptyString(input.guestName);
  const guestPhone = requireNormalizedNonEmptyString(input.guestPhone);
  const provinceRef = requireNormalizedNonEmptyString(input.provinceRef);
  const districtRef = requireNormalizedNonEmptyString(input.districtRef);
  const communeRef = requireNormalizedNonEmptyString(input.communeRef);
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
    bill_full_name: guestName,
    bill_phone_number: guestPhone,
    shipping_fee: shippingFeeVnd,
    is_free_shipping: shippingFeeVnd === 0,
    received_at_shop: false,
    shipping_address: {
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
