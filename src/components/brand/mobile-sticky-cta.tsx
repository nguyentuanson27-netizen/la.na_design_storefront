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
  return viewport !== null && window.innerHeight - viewport.height > KEYBOARD_VIEWPORT_LOSS_PX;
}

function hasOpenModal(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

export function useStickyCtaVisible(targetId: string, suppressed = false): boolean {
  // Hidden until the first observation, so the bar never flashes over a primary button already on screen.
  const [offscreen, setOffscreen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOffscreen(!entry?.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  useEffect(() => {
    const update = () => setTyping(isTyping());
    // Focus moving between fields fires focusout before focusin; read the settled element.
    const settle = () => queueMicrotask(update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", settle);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", settle);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const update = () => setModal(hasOpenModal());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "aria-modal"] });
    return () => observer.disconnect();
  }, []);

  const wanted = offscreen && !typing && !modal && !suppressed;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Hiding is immediate (the keyboard or a modal is already there); showing waits a beat.
    const timer = setTimeout(() => setShown(wanted), wanted ? SHOW_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [wanted]);
  return wanted && shown;
}

export function MobileStickyCta({ targetId, totalText, suppressed = false, note, children }: Readonly<{
  /** The primary control this bar stands in for while it is off screen. */
  targetId: string;
  /** The total of the quote the page is showing, as the page already formatted it. */
  totalText: string;
  suppressed?: boolean;
  /** A short reason the action is unavailable, the same one shown beside the primary control. */
  note?: string | null;
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
          <p className="text-xs text-black/70">Tổng thanh toán</p>
          <p className="truncate text-base font-semibold">{totalText}</p>
          {note ? <p className="truncate text-xs text-black/70">{note}</p> : null}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </div>
  );
}
