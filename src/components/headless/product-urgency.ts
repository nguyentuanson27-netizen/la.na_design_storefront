/**
 * What the product page says about time and stock running out: the Flash Sale countdown and
 * "Còn x". The facts are decided on the server (`buildProductUrgency`); this module turns them and
 * the shopper's selection into the exact words, so a brand redrawing the page cannot drift from the
 * card's rules or invent its own.
 */

export type ProductUrgency = Readonly<{
  /** `null` when no Flash Sale prices a ready-stock variant of this product. */
  flash: Readonly<{
    /**
     * What the page counts down before a variant is chosen: the card's representative, or `null`
     * when a cheaper variant outside the Flash Sale sets the price quoted before a choice. Counting
     * down then would call that other promotion's price a Flash price.
     */
    remainingMs: number | null;
    /** Each Flash-priced variant's own campaign; a variant absent here is not on Flash Sale. */
    remainingMsByVariantId: Readonly<Record<string, number>>;
  }> | null;
  lowStock: Readonly<{
    /** The product's "Còn x" total, under the card's rule; `null` says nothing. */
    total: number | null;
    /** Each low variant's own ready pieces; a variant absent here has enough. */
    byVariantId: Readonly<Record<string, number>>;
  }>;
}>;

export const NO_PRODUCT_URGENCY: ProductUrgency = Object.freeze({
  flash: null,
  lowStock: Object.freeze({ total: null, byVariantId: Object.freeze({}) }),
});

/**
 * How long the countdown has left for what the shopper is looking at, measured from the server's
 * request, or `null` for no countdown: nothing on Flash Sale, a chosen variant that is not, or no
 * choice yet while the quoted price is another variant's non-Flash one.
 */
export function resolveFlashRemainingMs(
  urgency: ProductUrgency,
  selectedVariantId: string | null,
): number | null {
  const { flash } = urgency;
  if (flash === null) return null;
  if (selectedVariantId === null) return flash.remainingMs;
  return flash.remainingMsByVariantId[selectedVariantId] ?? null;
}

const pad = (value: number) => String(value).padStart(2, "0");

export type FlashClock = Readonly<{
  days: number;
  hours: string;
  minutes: string;
  seconds: string;
  /** Compact form for the phone bar: "20:38:12", or "2 ngày 04:10:00". */
  text: string;
  /** A sentence for assistive technology, to the minute so it does not change every second. */
  spoken: string;
}>;

/** The clock for a positive remaining duration, or `null` once it has run out. */
export function formatFlashClock(remainingMs: number): FlashClock | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const time = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const spokenParts = [
    days > 0 ? `${days} ngày` : null,
    hours > 0 ? `${hours} giờ` : null,
    `${minutes} phút`,
  ].filter((part): part is string => part !== null);

  return Object.freeze({
    days,
    hours: pad(hours),
    minutes: pad(minutes),
    seconds: pad(seconds),
    text: days > 0 ? `${days} ngày ${time}` : time,
    spoken: `Flash Sale kết thúc sau ${spokenParts.join(" ")}`,
  });
}

/**
 * The one "Còn x" line under the sizes.
 *
 * With a variant chosen it speaks for that variant alone, naming its size when it has one; before
 * that it gives the product's total. A chosen variant with enough stock says nothing, rather than
 * falling back to a total that no longer describes what the shopper picked.
 */
export function describeLowStock(
  urgency: ProductUrgency,
  selection: Readonly<{ variantId: string | null; size: string | null }>,
): string | null {
  if (selection.variantId !== null) {
    const pieces = urgency.lowStock.byVariantId[selection.variantId];
    if (pieces === undefined) return null;
    return selection.size ? `Size ${selection.size} chỉ còn ${pieces} sản phẩm` : `Chỉ còn ${pieces} sản phẩm`;
  }
  const { total } = urgency.lowStock;
  return total === null ? null : `Chỉ còn ${total} sản phẩm`;
}
