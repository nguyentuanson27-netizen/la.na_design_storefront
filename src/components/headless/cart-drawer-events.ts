"use client";

/**
 * Cross-tree presentation seam for the existing SiteHeader-owned cart drawer.
 *
 * The event carries no cart facts and never means "purchase succeeded" by itself. Only callers
 * that already received server-confirmed add success may request the drawer to open.
 */
export const STOREFRONT_CART_DRAWER_OPEN_EVENT = "lana:storefront-cart-drawer-open";

export function requestStorefrontCartDrawerOpen() {
  window.dispatchEvent(new Event(STOREFRONT_CART_DRAWER_OPEN_EVENT));
}
