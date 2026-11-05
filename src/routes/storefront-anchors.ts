/**
 * Canonical in-page anchor fragments for direct storefront deep-linking.
 * Allows marketing links, social chat (Zalo, Messenger) and ad campaigns to navigate
 * directly to the products section without requiring visitors to scroll past mastheads,
 * banners, and introductory editorial headers.
 */
export const STOREFRONT_PRODUCTS_ANCHOR = "san-pham";
export const STOREFRONT_PRODUCTS_ALIAS_ANCHOR = "products";
export const STOREFRONT_PURCHASE_ANCHOR = "mua-hang";
export const STOREFRONT_PURCHASE_ALIAS_ANCHOR = "dat-hang";
export const STOREFRONT_FILTER_ANCHOR = "bo-loc";
export const STOREFRONT_COLLECTION_ANCHOR = "bo-suu-tap";

/** Every fragment a storefront link may carry; anything else is left to the browser. */
export const SUPPORTED_STOREFRONT_ANCHORS: ReadonlySet<string> = new Set([
  STOREFRONT_PRODUCTS_ANCHOR,
  STOREFRONT_PRODUCTS_ALIAS_ANCHOR,
  STOREFRONT_FILTER_ANCHOR,
  STOREFRONT_COLLECTION_ANCHOR,
  STOREFRONT_PURCHASE_ANCHOR,
  STOREFRONT_PURCHASE_ALIAS_ANCHOR,
  "chon-size",
  "chi-tiet",
]);

/** The anchor named by `?scroll=` / `?anchor=`, for platforms that strip the `#fragment`. */
export function storefrontQueryAnchor(search: string): string | null {
  const params = new URLSearchParams(search);
  const value = params.get("scroll") || params.get("anchor");
  return value && SUPPORTED_STOREFRONT_ANCHORS.has(value) ? value : null;
}

/**
 * The anchor to scroll to. A fragment the helper manages wins. A fragment it does not manage
 * (`#pdp-feedback`, an in-page link the shopper just clicked) is left to the browser: the query
 * fallback exists for links whose fragment was stripped, so it applies only when there is none.
 */
export function resolveStorefrontAnchor(hash: string, search: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return storefrontQueryAnchor(search);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escape: fall back to the raw fragment.
  }
  return SUPPORTED_STOREFRONT_ANCHORS.has(decoded) ? decoded : null;
}

/** Smooth by default; an instant jump for shoppers who asked the OS to reduce motion. */
export function storefrontScrollBehavior(prefersReducedMotion: boolean): "instant" | "smooth" {
  return prefersReducedMotion ? "instant" : "smooth";
}
