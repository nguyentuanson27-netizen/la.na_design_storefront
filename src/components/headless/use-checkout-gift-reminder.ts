"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseReminderAttempt, type ReminderState } from "./checkout-gift-reminder-model";

const STORAGE_KEY = "la-checkout-gift-reminder-v1";
let restoredReload = false;
/** Only UI metadata is stored; a seen reminder never supplies quote consent. */
export function useCheckoutGiftReminder(key: string | undefined) {
  const [view, setView] = useState<{ key: string | undefined; state: ReminderState }>({ key, state: "unseen" });
  const current = useRef<ReminderState>("unseen");
  const identity = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const clear = useCallback(() => {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* memory fallback */ }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const same = identity.current === key;
    identity.current = key;
    if (!same) {
      let seen = false;
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (key && navigation?.type === "reload" && !restoredReload) {
        try { seen = parseReminderAttempt(sessionStorage.getItem(STORAGE_KEY), key); } catch { /* memory fallback */ }
      }
      restoredReload = true;
      current.current = seen ? "seen" : "unseen";
      if (!seen) clear();
      queueMicrotask(() => { if (mounted.current) setView({ key, state: current.current }); });
    }
    return () => {
      mounted.current = false;
      // Activity exit ends the visit; StrictMode effect replay immediately reactivates it.
      queueMicrotask(() => {
        if (!mounted.current) {
          clear(); current.current = "unseen"; identity.current = undefined;
          setView({ key, state: "unseen" });
        }
      });
    };
  }, [key, clear]);
  const open = useCallback(() => {
    if (current.current !== "unseen") return false;
    current.current = "open";
    setView({ key, state: "open" });
    return true;
  }, [key]);
  const recordShown = useCallback(() => {
    if (key && identity.current === key && current.current === "open") {
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, key, seen: true })); } catch { /* memory fallback */ }
    }
  }, [key]);
  const markSeen = useCallback(() => {
    current.current = "seen";
    setView({ key, state: "seen" });
    if (key) try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, key, seen: true })); } catch { /* memory fallback */ }
  }, [key]);
  return { state: view.key === key ? view.state : "unseen", current, open, markSeen, recordShown, clear };
}
