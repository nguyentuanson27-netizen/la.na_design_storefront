import type { PrismaClient } from "../generated/prisma/client.ts";

export type HistoricalPricedLine = Readonly<{
  productName: string;
  color: string | null;
  size: string | null;
  role: "PAID" | "GIFT";
  quantity: number;
  unitPriceVnd: string;
  lineTotalVnd: string;
  listUnitPriceVnd: string | null;
}>;
export type HistoricalOrderPricing = Readonly<{
  lines: readonly HistoricalPricedLine[];
  savingVnd: string | null;
}>;
export function summarizeHistoricalOrderPricing(
  lines: readonly HistoricalPricedLine[],
): HistoricalOrderPricing {
  const paid = lines.filter((line) => line.role === "PAID");
  let saving = BigInt(0);
  let complete = paid.length > 0;
  for (const line of paid) {
    if (line.listUnitPriceVnd === null) {
      complete = false;
      continue;
    }
    const reference = BigInt(line.listUnitPriceVnd);
    const total = BigInt(line.lineTotalVnd);
    if (reference * BigInt(line.quantity) < total) {
      complete = false;
      continue;
    }
    saving += reference * BigInt(line.quantity) - total;
  }
  return {
    lines,
    savingVnd: complete && saving > BigInt(0) ? saving.toString() : null,
  };
}
/** Only call after the caller verified ownership or exact order code + phone. No catalog reads. */
export async function readHistoricalOrderPricing(
  client: PrismaClient,
  orderId: string,
): Promise<HistoricalOrderPricing | null> {
  const order = await client.orderMirror.findUnique({
    where: { id: orderId },
    select: {
      state: true,
      lines: {
        take: 201,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          variantId: true,
          productName: true,
          color: true,
          size: true,
          quantity: true,
          unitPriceVnd: true,
          lineTotalVnd: true,
          listUnitPriceVnd: true,
        },
      },
      quoteSnapshot: {
        select: {
          lines: {
            take: 201,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              variantId: true,
              role: true,
              productName: true,
              color: true,
              size: true,
              quantity: true,
              unitPriceVnd: true,
              lineTotalVnd: true,
              listUnitPriceVnd: true,
            },
          },
        },
      },
    },
  });
  if (!order || order.state !== "CONFIRMED") return null;
  if (
    order.lines.length > 200 ||
    (order.quoteSnapshot?.lines.length ?? 0) > 200
  )
    return null;
  const legacy = new Map(order.lines.map((line) => [line.variantId, line]));
  const lines: HistoricalPricedLine[] = order.quoteSnapshot
    ? order.quoteSnapshot.lines.map((line) => ({
        role: line.role,
        productName:
          line.productName ??
          legacy.get(line.variantId)?.productName ??
          (line.role === "GIFT" ? "Quà tặng" : "Sản phẩm"),
        color: line.color ?? legacy.get(line.variantId)?.color ?? null,
        size: line.size ?? legacy.get(line.variantId)?.size ?? null,
        quantity: line.quantity,
        unitPriceVnd: line.unitPriceVnd.toString(),
        lineTotalVnd: line.lineTotalVnd.toString(),
        listUnitPriceVnd:
          line.role === "GIFT"
            ? null
            : (line.listUnitPriceVnd?.toString() ?? null),
      }))
    : order.lines.map((line) => ({
        role: "PAID",
        productName: line.productName,
        color: line.color,
        size: line.size,
        quantity: line.quantity,
        unitPriceVnd: line.unitPriceVnd.toString(),
        lineTotalVnd: line.lineTotalVnd.toString(),
        listUnitPriceVnd: line.listUnitPriceVnd?.toString() ?? null,
      }));
  return summarizeHistoricalOrderPricing(
    lines.map((line) => ({
      ...line,
      productName: line.productName.slice(0, 300),
      color: line.color?.slice(0, 100) ?? null,
      size: line.size?.slice(0, 100) ?? null,
    })),
  );
}
