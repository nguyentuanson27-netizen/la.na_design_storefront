/**
 * Read-back of a created Pancake order (GQ21): the lines the POS actually stored and its total.
 *
 * The create-order response only says an order exists. Whether it kept several lines of one variation
 * apart, at the prices that were sent, is something only a later read can show, and the controlled
 * acceptance run (docs/integrations/pancake-gift-quantity-acceptance.md) used exactly these fields:
 * `items[].variation_id`, `items[].quantity`, `items[].variation_info.retail_price` and `total_price`
 * (the merchandise total; shipping is reported separately). This parser accepts nothing else and
 * rejects anything it cannot read exactly, because a guessed line is how a wrong order gets confirmed.
 */

export type PancakeOrderReadBackLine = Readonly<{
  pancakeVariationId: string;
  quantity: number;
  unitPriceVnd: number;
}>;

export type PancakeOrderReadBack = Readonly<{
  lines: readonly PancakeOrderReadBackLine[];
  /** `total_price` when the POS reports it as a safe integer, otherwise null. */
  totalPriceVnd: number | null;
  /** The order's own `id`, as the canonical decimal string, when the POS reports one; otherwise null. */
  orderId: string | null;
  /** The order's own `shop_id` when reported as a positive safe integer; otherwise null. */
  shopId: number | null;
  /** The order's `status` when it is one of the documented numeric codes; otherwise null. */
  status: number | null;
}>;

/** Pancake's numeric status for a canceled order (the same code `cancelOrder` writes and reads back). */
export const PANCAKE_ORDER_CANCELED_STATUS = 7;

export class PancakeOrderReadBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PancakeOrderReadBackError";
  }
}

import { PANCAKE_ORDER_STATUS_CODES } from "./order-status.ts";

const MAX_READBACK_ITEMS = 500;

export function parsePancakeOrderReadBack(
  payload: unknown,
  /** When given, a reported `id` or `shop_id` that is not the one requested is refused outright. */
  requested?: Readonly<{ shopId: number; orderId: string }>,
): PancakeOrderReadBack {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PancakeOrderReadBackError("Order read-back payload is not an object");
  }
  const envelope = payload as { data?: unknown };
  const order = (envelope.data !== undefined && envelope.data !== null && typeof envelope.data === "object" ? envelope.data : payload) as Record<string, unknown>;
  if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > MAX_READBACK_ITEMS) {
    throw new PancakeOrderReadBackError("Order read-back has no readable items array");
  }
  const lines = order.items.map((item: unknown): PancakeOrderReadBackLine => {
    const record = (item ?? {}) as { variation_id?: unknown; quantity?: unknown; variation_info?: { retail_price?: unknown } };
    const price = record.variation_info?.retail_price;
    if (
      typeof record.variation_id !== "string" ||
      record.variation_id.length === 0 ||
      typeof record.quantity !== "number" ||
      !Number.isSafeInteger(record.quantity) ||
      record.quantity < 1 ||
      typeof price !== "number" ||
      !Number.isSafeInteger(price) ||
      price < 0
    ) {
      throw new PancakeOrderReadBackError("Order read-back item is missing variation_id, quantity or retail_price");
    }
    return { pancakeVariationId: record.variation_id, quantity: record.quantity, unitPriceVnd: price };
  });
  const total = order.total_price;
  const reportedId = order.id;
  const orderId = typeof reportedId === "number" && Number.isSafeInteger(reportedId) && reportedId > 0 ? String(reportedId) : null;
  const reportedShop = order.shop_id;
  const shopId = typeof reportedShop === "number" && Number.isSafeInteger(reportedShop) && reportedShop > 0 ? reportedShop : null;
  const reportedStatus = order.status;
  const status =
    typeof reportedStatus === "number" && (PANCAKE_ORDER_STATUS_CODES as readonly number[]).includes(reportedStatus) ? reportedStatus : null;
  if (requested !== undefined && ((orderId !== null && orderId !== requested.orderId) || (shopId !== null && shopId !== requested.shopId))) {
    throw new PancakeOrderReadBackError("Order read-back is for another order or shop than the one requested");
  }
  return { lines, totalPriceVnd: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null, orderId, shopId, status };
}
