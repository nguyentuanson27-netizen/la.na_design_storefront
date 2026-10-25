"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * UX-02 / AC-18 — the bottom bar that keeps the page's one primary action in reach on a phone.
 *
 * It is never a second action: the caller passes a control that does exactly what the primary one
 * does (the same link, or the same form pipeline), and the bar shows only while that primary control
 * is off screen, so one primary CTA is visible at a time. It also steps aside while the buyer types
 * (a virtual keyboard would push it over the field) and while any modal is open. Desktop never shows it.
 */

const TEXT_ENTRY = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable="true"]';
// A software keyboard takes far more than this; browser chrome resizing the viewport takes less.
const KEYBOARD_VIEWPORT_LOSS_PX = 150;
// Leaving a field for a button fires focus changes between pointer-down and pointer-up. Appearing at
// once would put the bar under the finger and swallow the tap it was released on, so it waits a beat.
const SHOW_DELAY_MS = 300;

function isTyping(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches(TEXT_ENTRY)) return true;
  const viewport = window.visualViewport;
  // A pinch-zoom also shrinks the visual viewport; only an unzoomed shrink is the keyboard.
  return viewport !== null && viewport.scale <= 1.01 && window.innerHeight - viewport.height > KEYBOARD_VIEWPORT_LOSS_PX;
}

// The bar is a below-`lg` affordance; on wider screens nothing is observed at all.
const BELOW_LG = "(max-width: 1023.98px)";

function hasOpenModal(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

export function useStickyCtaVisible(targetId: string, suppressed = false): boolean {
  // Hidden until the first observation, so the bar never flashes over a primary button already on screen.
  const [offscreen, setOffscreen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [modal, setModal] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(BELOW_LG);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!narrow) return;
    const target = document.getElementById(targetId);
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(!entry?.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId, narrow]);

  useEffect(() => {
    if (!narrow) return;
    const update = () => setTyping(isTyping());
    // Re-read on entering the narrow layout: focus may have moved while nothing was listening.
    update();
    // focusout reports the element being left; `focusin` on the next field corrects any reading taken
    // in between, and the show delay below absorbs the gap.
    const settle = () => queueMicrotask(update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", settle);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", settle);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [narrow]);

  useEffect(() => {
    if (!narrow) return;
    const update = () => setModal(hasOpenModal());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "aria-modal"] });
    return () => observer.disconnect();
  }, [narrow]);

  const wanted = narrow && offscreen && !typing && !modal && !suppressed;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Hiding is immediate (the keyboard or a modal is already there); showing waits a beat.
    const timer = setTimeout(() => setShown(wanted), wanted ? SHOW_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [wanted]);
  return wanted && shown;
}

export function MobileStickyCta({ targetId, totalText, totalLabel = "Tổng thanh toán", suppressed = false, note, footnote, children }: Readonly<{
  /** The primary control this bar stands in for while it is off screen. */
  targetId: string;
  /** The amount the page is showing, as the page already formatted it. */
  totalText: string;
  /** What that amount is: a page without a full bill shows its subtotal, and must say so. */
  totalLabel?: string;
  suppressed?: boolean;
  /** A short reason the action is unavailable, the same one shown beside the primary control. */
  note?: string | null;
  /** One short line under the bar, e.g. the order trust facts the off-screen button carries below it. */
  footnote?: string;
  children: ReactNode;
}>) {
  const visible = useStickyCtaVisible(targetId, suppressed);
  if (!visible) return null;
  return (
    <div
      data-mobile-sticky-cta=""
      className="fixed inset-x-0 bottom-0 z-40 border-t border-black/20 bg-[#FAF7F2] px-4 pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] lg:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex w-full max-w-[42rem] min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-black/70">{totalLabel}</p>
          <p className="truncate text-base font-semibold">{totalText}</p>
          {note ? <p className="truncate text-xs text-black/70">{note}</p> : null}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {footnote ? (
        <p className="mx-auto mt-1.5 w-full max-w-[42rem] truncate text-center text-[0.68rem] text-black/60" data-mobile-sticky-footnote="">
          {footnote}
        </p>
      ) : null}
    </div>
  );
}
