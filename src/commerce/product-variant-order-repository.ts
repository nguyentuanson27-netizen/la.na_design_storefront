import type { PrismaClient } from "../generated/prisma/client.ts";
import { normalizeVariantColor, parseVariantColorOrder } from "./product-variant-order.ts";

export type VariantColorOrderEditorState = {
  /** Each color the product has, once, in the spelling the catalog uses. */
  productColors: string[];
  /** The stored order, restricted to colors the product still has; empty when none is set. */
  colors: string[];
};

export type SaveVariantColorOrderResult =
  | { ok: true; colors: string[] }
  | { ok: false; reason: "product-not-found" | "invalid" | "unknown-color" | "too-many" };

/**
 * Reads and writes `ProductVariantColorOrder`, the website-owned list that says which of a product's
 * colors comes first. Pancake sync never touches it, so a resync cannot undo an order set in admin.
 */
export function createProductVariantOrderRepository(client: PrismaClient) {
  async function readProductColors(productId: string): Promise<string[]> {
    const rows = await client.variantMirror.findMany({
      where: { productId, isPresent: true },
      orderBy: [{ pancakeVariationId: "asc" }],
      select: { color: true },
    });
    const byKey = new Map<string, string>();
    for (const { color } of rows) {
      const key = normalizeVariantColor(color);
      if (key && color && !byKey.has(key)) byKey.set(key, color.trim());
    }
    return [...byKey.values()];
  }

  async function readEditorState(productId: string): Promise<VariantColorOrderEditorState> {
    const [productColors, stored] = await Promise.all([
      readProductColors(productId),
      client.productVariantColorOrder.findUnique({
        where: { productId },
        select: { colors: true },
      }),
    ]);
    const spellingByKey = new Map(productColors.map((color) => [normalizeVariantColor(color), color]));
    const colors = (stored?.colors ?? [])
      .map((color) => spellingByKey.get(normalizeVariantColor(color)))
      .filter((color): color is string => color !== undefined);
    return { productColors, colors };
  }

  async function save(
    productId: string,
    entries: readonly { color: unknown; position: unknown }[],
  ): Promise<SaveVariantColorOrderResult> {
    const product = await client.productMirror.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) return { ok: false, reason: "product-not-found" };

    const parsed = parseVariantColorOrder(entries, await readProductColors(productId));
    if (!parsed.ok) return parsed;

    // An order that names no color is the same as no order: drop the row rather than keep an empty one.
    if (parsed.colors.length === 0) {
      await client.productVariantColorOrder.deleteMany({ where: { productId } });
      return { ok: true, colors: [] };
    }
    await client.productVariantColorOrder.upsert({
      where: { productId },
      create: { productId, colors: parsed.colors },
      update: { colors: parsed.colors },
    });
    return { ok: true, colors: parsed.colors };
  }

  async function clear(productId: string): Promise<void> {
    await client.productVariantColorOrder.deleteMany({ where: { productId } });
  }

  return { readEditorState, save, clear };
}
