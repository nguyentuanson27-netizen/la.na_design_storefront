import type { PrismaClient } from "../generated/prisma/client.ts";

/**
 * The order facts both halves of the Purchase report are built from.
 *
 * The browser pixel and the Conversions API must describe the same sale identically — Meta pairs
 * them by event id, and a mismatched value or item list turns one conversion into two conflicting
 * ones — so both read this rather than assembling their own view of the order.
 */

export type MetaPurchaseContent = Readonly<{
  id: string;
  quantity: number;
  itemPrice: number;
}>;

export type MetaPurchaseSnapshot = Readonly<{
  valueVnd: number;
  contents: readonly MetaPurchaseContent[];
}>;

type OrderClient = Pick<PrismaClient, "orderMirror">;

/** VND amounts are stored as BigInt; a total past Number's exact range is not reportable. */
function toSafeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

export async function readMetaPurchaseSnapshot(
  client: OrderClient,
  orderCode: string,
): Promise<MetaPurchaseSnapshot | null> {
  const order = await client.orderMirror.findUnique({
    where: { publicCode: orderCode },
    select: {
      state: true,
      totalVnd: true,
      metaPurchasePayload: true,
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          metaContentId: true,
          quantity: true,
          unitPriceVnd: true,
        },
      },
    },
  });

  // Only a confirmed order is a sale. Anything else would report revenue that does not exist.
  if (order === null || order.state !== "CONFIRMED") return null;

  // The serialized event is the replay authority after first reporting. Only non-PII business
  // facts leave this reader; the attribution stored beside them is never returned to a client.
  if (order.metaPurchasePayload) {
    try {
      const event = JSON.parse(order.metaPurchasePayload);
      if (event.event_name !== "Purchase" || event.event_id !== orderCode) return null;
      const data = event.custom_data;
      if (!Number.isSafeInteger(data.value) || data.value < 0 || !Array.isArray(data.contents) || !data.contents.length) return null;
      const contents: MetaPurchaseContent[] = [];
      for (const line of data.contents) {
        if (typeof line.id !== "string" || !line.id || !Number.isSafeInteger(line.quantity) || line.quantity <= 0
          || !Number.isSafeInteger(line.item_price) || line.item_price < 0) return null;
        contents.push({ id: line.id, quantity: line.quantity, itemPrice: line.item_price });
      }
      return Object.freeze({ valueVnd: data.value, contents: Object.freeze(contents) });
    } catch { return null; }
  }

  const valueVnd = toSafeNumber(order.totalVnd);
  if (valueVnd === null) return null;

  if (order.lines.length === 0) return null;
  const contents: MetaPurchaseContent[] = [];
  for (const line of order.lines) {
    const itemPrice = toSafeNumber(line.unitPriceVnd);
    // Dropping the line while valueVnd still counts it would report an item list that contradicts
    // its own total. An order that cannot be described exactly is not reported at all.
    if (itemPrice === null || !line.metaContentId || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return null;
    contents.push({
      // No catalog read or identity fallback. Historical rows need explicit evidence, not a guess.
      id: line.metaContentId,
      quantity: line.quantity,
      itemPrice,
    });
  }

  return Object.freeze({ valueVnd, contents: Object.freeze(contents) });
}
