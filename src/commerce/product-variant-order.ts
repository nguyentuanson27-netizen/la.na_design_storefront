import { compareClothingSizes } from "./clothing-size.ts";

/**
 * The order a product's colors, and so their photos, appear in.
 *
 * The configured order lives in `ProductVariantColorOrder` (edited in admin), not here: the gallery,
 * the color picker's default, and every listing thumbnail all read the variants in this order, so a
 * product's color order is one list of color names and nothing else.
 */

export const MAX_VARIANT_COLOR_ORDER_COLORS = 20;
const MAX_COLOR_LENGTH = 80;

/** Color names are compared ignoring case, surrounding space and composed-vs-decomposed accents. */
export function normalizeVariantColor(color: string | null | undefined): string {
  return (color ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

type OrderableVariant = {
  color?: string | null;
  size?: string | null;
};

/** Sized variants by clothing size, ahead of variants with no size; `0` when neither can be ranked. */
function compareSizes(a: string | null | undefined, b: string | null | undefined): number {
  const aSize = a?.trim() ?? "";
  const bSize = b?.trim() ?? "";
  if (aSize && bSize) return compareClothingSizes(aSize, bSize);
  if (aSize) return -1;
  if (bSize) return 1;
  return 0;
}

/**
 * Variants grouped by color, the configured colors first in the configured order, then every other
 * color in the order it first appears. Within a color, sizes run S, M, L, XL; a variant with no size
 * goes after the sized ones; ties keep the original order.
 *
 * With no configured order the variants are returned exactly as given -- the common case, and the
 * reason a product nobody has configured cannot change.
 */
export function orderProductVariants<T extends OrderableVariant>(
  variants: readonly T[],
  colorOrder: readonly string[] | null | undefined,
): T[] {
  const configured = (colorOrder ?? []).map(normalizeVariantColor).filter((color) => color !== "");
  if (configured.length === 0 || variants.length <= 1) return [...variants];

  const groupRank = new Map<string, number>();
  configured.forEach((color, index) => {
    if (!groupRank.has(color)) groupRank.set(color, index);
  });
  // Colors the order does not name come after it, in the order the catalog listed them.
  let nextRank = groupRank.size;
  for (const variant of variants) {
    const color = normalizeVariantColor(variant.color);
    if (!groupRank.has(color)) groupRank.set(color, nextRank++);
  }

  return variants
    .map((variant, originalIndex) => ({
      variant,
      originalIndex,
      rank: groupRank.get(normalizeVariantColor(variant.color)) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        compareSizes(a.variant.size, b.variant.size) ||
        a.originalIndex - b.originalIndex,
    )
    .map(({ variant }) => variant);
}

export type VariantColorOrderParse =
  | { ok: true; colors: string[] }
  | { ok: false; reason: "invalid" | "unknown-color" | "too-many" };

/**
 * An editor submission -- one (color, position) pair per color the product has -- as an ordered list
 * of those colors' own spellings. A blank position leaves a color out of the list (it then follows
 * the listed ones); a position is a whole number from 1; equal positions keep the form's order.
 * A color the product does not have is refused so a typo cannot silently do nothing.
 */
export function parseVariantColorOrder(
  entries: readonly { color: unknown; position: unknown }[],
  productColors: readonly string[],
): VariantColorOrderParse {
  const spellingByColor = new Map<string, string>();
  for (const color of productColors) {
    const key = normalizeVariantColor(color);
    if (key && !spellingByColor.has(key)) spellingByColor.set(key, color.trim());
  }

  const ranked: { color: string; position: number; index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.color !== "string" || entry.color.length > MAX_COLOR_LENGTH) {
      return { ok: false, reason: "invalid" };
    }
    const key = normalizeVariantColor(entry.color);
    const spelling = spellingByColor.get(key);
    if (spelling === undefined) return { ok: false, reason: "unknown-color" };
    if (seen.has(key)) return { ok: false, reason: "invalid" };
    seen.add(key);

    if (entry.position === null || entry.position === undefined) continue;
    if (typeof entry.position !== "string" && typeof entry.position !== "number") {
      return { ok: false, reason: "invalid" };
    }
    const text = String(entry.position).trim();
    if (text === "") continue;
    const position = Number(text);
    if (!Number.isSafeInteger(position) || position < 1 || position > MAX_VARIANT_COLOR_ORDER_COLORS) {
      return { ok: false, reason: "invalid" };
    }
    ranked.push({ color: spelling, position, index });
  }

  if (ranked.length > MAX_VARIANT_COLOR_ORDER_COLORS) return { ok: false, reason: "too-many" };
  ranked.sort((a, b) => a.position - b.position || a.index - b.index);
  return { ok: true, colors: ranked.map((item) => item.color) };
}
