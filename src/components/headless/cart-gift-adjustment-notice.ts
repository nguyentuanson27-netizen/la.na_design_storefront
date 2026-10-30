"use client";

/**
 * Non-authoritative, session-only feedback for a confirmed server cleanup.
 * Kept briefly so removing the last paid line can remount the empty-cart screen
 * without losing the announcement. This count never authorizes or prices a gift.
 */
const EVENT = "la:cart-gifts-auto-removed";
const STORAGE_KEY = "la:cart-gifts-auto-removed:v1";
const NOTICE_TTL_MS = 30_000;

export function readRecentAutoRemovedGiftCount(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const entry: unknown = JSON.parse(raw);
    if (!entry || typeof entry !== "object") return 0;
    const { count, time } = entry as { count?: unknown; time?: unknown };
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0 ||
        typeof time !== "number" || Date.now() - time > NOTICE_TTL_MS || time > Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return 0;
    }
    return count;
  } catch {
    return 0; // Storage disabled; the server cleanup still succeeded.
  }
}

export function publishAutoRemovedGiftCount(count: number): void {
  if (typeof window === "undefined" || !Number.isSafeInteger(count) || count <= 0) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ count, time: Date.now() }));
  } catch { /* Not a checkout dependency. */ }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeAutoRemovedGiftCount(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}
