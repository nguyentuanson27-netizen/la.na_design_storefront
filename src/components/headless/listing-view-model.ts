/**
 * How big the photographs on a listing are drawn -- the shopper's "kiểu xem".
 *
 * Three steps, named for what the shopper sees rather than for a column count: `large` (ảnh lớn),
 * `medium` (ảnh trung bình) and `small` (ảnh nhỏ). Each step is a number of products per row at
 * each width:
 *
 *   large   mobile 2 · tablet 3 · desktop 4   (the grid as it was before the choice existed)
 *   medium  mobile 3 · tablet 4 · desktop 5
 *   small   mobile 4 · tablet 5 · desktop 6
 *
 * One choice drives every listing on the site, so it has to survive a navigation and reach the
 * server render. It is carried two ways, and the URL wins when both are present:
 *
 *   - `?view=` -- a link someone shares opens in the view they chose; the proxy turns it into the
 *     cookie below so the next page already knows.
 *   - the `la_listing_view` cookie -- what the shopper chose last, read by the server so the first
 *     paint is already in the right view (no jump from the default to the saved one).
 *
 * This file is pure: no `next/*`, no DOM, so the proxy, the server and the browser share one
 * definition and `tests/domain` can exercise it.
 */

export const LISTING_VIEWS = ["large", "medium", "small"] as const;
export type ListingView = (typeof LISTING_VIEWS)[number];

export const DEFAULT_LISTING_VIEW: ListingView = "large";

export const LISTING_VIEW_PARAM = "view";
export const LISTING_VIEW_COOKIE = "la_listing_view";
/** The proxy's verdict for this request, so server components need not parse the URL themselves. */
export const LISTING_VIEW_REQUEST_HEADER = "x-listing-view";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseListingView(value: unknown): ListingView | null {
  if (typeof value !== "string") return null;
  return (LISTING_VIEWS as readonly string[]).includes(value) ? (value as ListingView) : null;
}

/** The URL wins over the cookie, the cookie over the default; anything unrecognised is ignored. */
export function resolveListingView(
  input: Readonly<{ param?: unknown; cookie?: unknown }>,
): ListingView {
  return parseListingView(input.param) ?? parseListingView(input.cookie) ?? DEFAULT_LISTING_VIEW;
}

export function serializeListingViewCookie(view: ListingView, options: Readonly<{ secure?: boolean }> = {}): string {
  const parts = [
    `${LISTING_VIEW_COOKIE}=${view}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** The saved view in a `document.cookie` / `Cookie` header string; `null` when absent or invalid. */
export function readListingViewCookie(cookieString: string): ListingView | null {
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === LISTING_VIEW_COOKIE) {
      return parseListingView(part.slice(separator + 1).trim());
    }
  }
  return null;
}

/** The `view` of a query string, whichever shape it is held in; `null` when absent or invalid. */
export function readListingViewParam(search: string | URLSearchParams): ListingView | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return parseListingView(params.get(LISTING_VIEW_PARAM));
}

/**
 * `search` (with or without a leading `?`) with `view` set to the chosen step. The default view is
 * still written, not dropped: it is an explicit choice that has to beat a cookie saying otherwise.
 */
export function withListingViewParam(search: string, view: ListingView): string {
  const params = new URLSearchParams(search);
  params.set(LISTING_VIEW_PARAM, view);
  const next = params.toString();
  return next.length > 0 ? `?${next}` : "";
}

/*
 * Class names are spelled out in full: Tailwind finds utilities by scanning for whole strings, so
 * `grid-cols-${n}` would generate nothing.
 */

const PRODUCT_GRID_COLUMNS: Readonly<Record<ListingView, string>> = {
  large: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  medium: "grid-cols-3 md:grid-cols-4 lg:grid-cols-5",
  // Below 360px a fourth column would leave a card ~75px wide, too narrow for a price and an
  // availability line at a readable size, so the narrowest phones keep three.
  small: "grid-cols-3 min-[360px]:grid-cols-4 md:grid-cols-5 lg:grid-cols-6",
};

/** Smaller photographs sit closer together; the gaps shrink with them. */
const PRODUCT_GRID_GAPS: Readonly<Record<ListingView, string>> = {
  large: "gap-[2px] sm:gap-x-6 sm:gap-y-10 lg:gap-x-8 lg:gap-y-12",
  medium: "gap-[2px] sm:gap-x-4 sm:gap-y-8 lg:gap-x-6 lg:gap-y-10",
  small: "gap-[2px] sm:gap-x-3 sm:gap-y-6 lg:gap-x-4 lg:gap-y-8",
};

export function productGridClassName(view: ListingView): string {
  return `grid ${PRODUCT_GRID_COLUMNS[view]} ${PRODUCT_GRID_GAPS[view]}`;
}

/**
 * The collections index draws 16:9 banners, which a four-across phone row would shrink past
 * reading. Its steps are one fewer column than the product grid's so the banner stays legible:
 * the same three names, a different arithmetic.
 */
const COLLECTION_GRID_COLUMNS: Readonly<Record<ListingView, string>> = {
  large: "grid-cols-1 md:grid-cols-2",
  medium: "grid-cols-2 md:grid-cols-3",
  small: "grid-cols-3 md:grid-cols-4",
};

export function collectionGridClassName(view: ListingView): string {
  return `grid ${COLLECTION_GRID_COLUMNS[view]}`;
}

/*
 * `sizes` for the photographs, which is what the browser picks a `srcset` file by -- not the CSS
 * width the card ends up with. They follow the column counts above (the breakpoints are Tailwind's
 * `md` 768px and `lg` 1024px, and the 360px step of the small view), so a card that is a quarter
 * of the phone is asked for a quarter-width file rather than a half-width one.
 */

/** The product card's photograph (and its hover photograph) inside a listing grid. */
const PRODUCT_IMAGE_SIZES: Readonly<Record<ListingView, string>> = {
  large: "(min-width: 1024px) 25vw, (min-width: 768px) 34vw, 50vw",
  medium: "(min-width: 1024px) 20vw, (min-width: 768px) 25vw, 34vw",
  small: "(min-width: 1024px) 17vw, (min-width: 768px) 20vw, (min-width: 360px) 25vw, 34vw",
};

/** What the same photograph asked for before the view existed; still right outside a listing grid. */
export const DEFAULT_PRODUCT_IMAGE_SIZES = "(min-width: 1024px) 25vw, 50vw";

export function productImageSizes(view: ListingView): string {
  return PRODUCT_IMAGE_SIZES[view];
}

const COLLECTION_IMAGE_SIZES: Readonly<Record<ListingView, string>> = {
  large: "(min-width: 768px) 50vw, 100vw",
  medium: "(min-width: 768px) 34vw, 50vw",
  small: "(min-width: 768px) 25vw, 34vw",
};

export function collectionImageSizes(view: ListingView): string {
  return COLLECTION_IMAGE_SIZES[view];
}

export const LISTING_VIEW_LABELS: Readonly<Record<ListingView, string>> = {
  large: "Ảnh lớn",
  medium: "Ảnh trung bình",
  small: "Ảnh nhỏ",
};

/**
 * What the proxy does with a page request: the view the render should use, and the cookie to set
 * when the URL named a view the cookie does not already hold. A request without a valid `?view=`
 * never writes the cookie -- reading a page is not choosing a view.
 */
export function planListingViewRequest(
  input: Readonly<{ method: string; search: string | URLSearchParams; cookie: string | undefined; secure?: boolean }>,
): Readonly<{ view: ListingView; setCookie: string | null }> {
  const fromUrl = readListingViewParam(input.search);
  const view = resolveListingView({ param: fromUrl, cookie: input.cookie });
  const isRead = input.method === "GET" || input.method === "HEAD";
  const setCookie =
    isRead && fromUrl !== null && fromUrl !== parseListingView(input.cookie)
      ? serializeListingViewCookie(fromUrl, { secure: input.secure })
      : null;
  return { view, setCookie };
}
