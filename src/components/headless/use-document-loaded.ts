"use client";

import { useSyncExternalStore } from "react";

function subscribeToDocumentLoad(onStoreChange: () => void) {
  window.addEventListener("load", onStoreChange);
  return () => window.removeEventListener("load", onStoreChange);
}

/**
 * True once the document has finished loading: the point after which a component may start
 * fetching what the shopper is likely to want next without competing with what the page needed to
 * paint. False on the server and during hydration, so the markup both render agrees.
 */
export function useDocumentLoaded(): boolean {
  return useSyncExternalStore(
    subscribeToDocumentLoad,
    () => document.readyState === "complete",
    () => false,
  );
}
