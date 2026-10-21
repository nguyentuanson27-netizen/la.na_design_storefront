/**
 * Pure models and helpers for the storefront cart drawer.
 */

/** Why the drawer cannot offer checkout, one sentence per reason, in the order a shopper fixes them. */
export function checkoutBlockedMessages(
  cart: Readonly<{ hasUnavailableLines: boolean; benefitsNotice?: string }>,
): readonly string[] {
  const messages: string[] = [];
  if (cart.hasUnavailableLines) messages.push("Nàng điều chỉnh sản phẩm không khả dụng trước khi đặt hàng nhé.");
  if (cart.benefitsNotice) messages.push(cart.benefitsNotice);
  // Blocked for a reason neither names: still say something rather than leave a dead end.
  return messages.length > 0 ? messages : ["Nàng xem lại giỏ hàng trước khi đặt hàng nhé."];
}

export type CartDrawerFocusable = {
  first: HTMLElement | null;
  last: HTMLElement | null;
};

export function findFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function handleDrawerFocusTrap(
  event: KeyboardEvent,
  container: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !container) return;

  const focusables = findFocusableElements(container);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;

  if (event.shiftKey) {
    if (document.activeElement === first) {
      last.focus();
      event.preventDefault();
    }
  } else {
    if (document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  }
}

/**
 * The shape `resolveDrawerReturnFocus` needs from a candidate, so the decision stays testable
 * without a DOM.
 */
export type DrawerFocusCandidate = Readonly<{
  isConnected: boolean;
  tagName: string;
  focus?: unknown;
}>;

/**
 * Whether the element a drawer saved on open is somewhere worth sending focus back to.
 *
 * `document.activeElement` is never null: with nothing focused it reports the body, and that is
 * exactly what it reports when a drawer is opened programmatically rather than from a control --
 * the mobile purchase sheet closes and unmounts before it asks for the cart. Restoring focus to
 * the body is indistinguishable from dropping it, and an element that has since left the document
 * is no better, so both defer to the drawer's own trigger.
 */
export function isMeaningfulReturnFocusTarget(candidate: DrawerFocusCandidate | null): boolean {
  if (candidate === null) return false;
  if (!candidate.isConnected) return false;
  if (typeof candidate.focus !== "function") return false;

  const tagName = candidate.tagName.toUpperCase();
  return tagName !== "BODY" && tagName !== "HTML";
}
