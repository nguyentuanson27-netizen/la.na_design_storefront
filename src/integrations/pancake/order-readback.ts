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
}>;

export class PancakeOrderReadBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PancakeOrderReadBackError";
  }
}

const MAX_READBACK_ITEMS = 500;

export function parsePancakeOrderReadBack(payload: unknown): PancakeOrderReadBack {
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
  return { lines, totalPriceVnd: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null };
}
