/**
 * Pure models and helpers for the storefront cart drawer.
 */

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
