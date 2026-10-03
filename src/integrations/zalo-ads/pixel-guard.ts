/**
 * The DOM side of the Zalo tracker's privacy boundary (url-safety.ts decides what is safe).
 *
 * ztracker.js reports the live `document.URL` -- path, query and fragment -- with every beacon, and
 * a loaded third-party script cannot be unloaded. So the guard does two things only:
 *
 * - `startZaloAdsPixel` decides once per document, from the real address and referrer, whether the
 *   official tag is inserted at all.
 * - `quarantineZaloAdsPixel` adds a <meta> CSP that withholds Zalo's reporting origin. A page can
 *   tighten its CSP but never loosen it, so from then on the browser blocks every Zalo beacon for
 *   the rest of the document, whatever the tracker does. `watchZaloAdsLocation` applies it to any
 *   same-document URL change the router does not report: fragment changes, history traversal, and
 *   (where the browser has the Navigation API) every navigation before its URL is committed.
 *
 * Kept free of React so the boundary can be tested without a browser. Every entry point swallows
 * its own failures: tracking is optional and must never break the storefront.
 */
import { isZaloSafeLocation, isZaloSafeReferrer } from "./url-safety.ts";

export const ZALO_ADS_SCRIPT_ID = "zalo-ads-pixel";
export const ZALO_ADS_QUARANTINE_ID = "zalo-ads-pixel-quarantine";

export type ZaloAdsPixelState = "loaded" | "blocked" | "quarantined";

type GuardElement = { id: string };

export type GuardDocument = {
  referrer: string;
  head: { appendChild(node: GuardElement): unknown };
  documentElement: { dataset: Record<string, string | undefined> };
  getElementById(id: string): unknown;
  createElement(tag: "script"): GuardElement & { async: boolean; src: string };
  createElement(tag: "meta"): GuardElement & { httpEquiv: string; content: string };
};

type Listener = (event: unknown) => void;

export type GuardWindow = {
  location: { href: string; origin: string };
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  /** The Navigation API, where the browser has one. */
  navigation?: {
    addEventListener(type: string, listener: Listener): void;
    removeEventListener(type: string, listener: Listener): void;
  };
};

export function readZaloAdsPixelState(doc: GuardDocument): ZaloAdsPixelState | null {
  const state = doc.documentElement.dataset.laZaloAdsPixel;
  return state === "loaded" || state === "blocked" || state === "quarantined" ? state : null;
}

/** Inserts the official tag if this document may be observed; decides once per document. */
export function startZaloAdsPixel(win: GuardWindow, doc: GuardDocument, src: string): ZaloAdsPixelState | null {
  try {
    const existing = readZaloAdsPixelState(doc);
    if (existing !== null) return existing;

    const origin = win.location.origin;
    const allowed = isZaloSafeLocation(win.location.href, origin) && isZaloSafeReferrer(doc.referrer, origin);
    doc.documentElement.dataset.laZaloAdsPixel = allowed ? "loaded" : "blocked";
    if (allowed) {
      const script = doc.createElement("script");
      script.id = ZALO_ADS_SCRIPT_ID;
      script.async = true;
      script.src = src;
      doc.head.appendChild(script);
    }
    return allowed ? "loaded" : "blocked";
  } catch {
    return null;
  }
}

/**
 * Cuts a loaded tracker off if any of `hrefs` is unsafe. Returns true once the document is
 * quarantined (now or earlier).
 */
export function quarantineZaloAdsPixel(
  win: GuardWindow,
  doc: GuardDocument,
  policy: string,
  hrefs: readonly string[],
): boolean {
  try {
    const state = readZaloAdsPixelState(doc);
    if (state === "quarantined") return true;
    if (state !== "loaded") return false;

    const origin = win.location.origin;
    if (hrefs.every((href) => isZaloSafeLocation(href, origin))) return false;

    if (doc.getElementById(ZALO_ADS_QUARANTINE_ID) === null) {
      const meta = doc.createElement("meta");
      meta.id = ZALO_ADS_QUARANTINE_ID;
      meta.httpEquiv = "Content-Security-Policy";
      meta.content = policy;
      doc.head.appendChild(meta);
    }
    doc.documentElement.dataset.laZaloAdsPixel = "quarantined";
    return true;
  } catch {
    return false;
  }
}

function destinationUrl(event: unknown): string | null {
  const url = (event as { destination?: { url?: unknown } } | null)?.destination?.url;
  return typeof url === "string" ? url : null;
}

/**
 * Quarantines on URL changes the App Router does not surface through its hooks. Returns the
 * unsubscribe function.
 */
export function watchZaloAdsLocation(win: GuardWindow, doc: GuardDocument, policy: string): () => void {
  const onLocationChange = () => {
    quarantineZaloAdsPixel(win, doc, policy, [win.location.href]);
  };
  // Fires synchronously, before a same-document navigation commits its URL, so no tracker timer can
  // run in between. Covers `location.hash = …`, anchor clicks and history.pushState alike.
  const onNavigate = (event: unknown) => {
    const destination = destinationUrl(event);
    quarantineZaloAdsPixel(win, doc, policy, destination === null ? [win.location.href] : [destination]);
  };

  try {
    win.addEventListener("hashchange", onLocationChange);
    win.addEventListener("popstate", onLocationChange);
    win.navigation?.addEventListener("navigate", onNavigate);
  } catch {
    // Without a subscription the router-driven check still runs; nothing here may throw.
  }
  return () => {
    try {
      win.removeEventListener("hashchange", onLocationChange);
      win.removeEventListener("popstate", onLocationChange);
      win.navigation?.removeEventListener("navigate", onNavigate);
    } catch {
      // Nothing to clean up that could affect the page.
    }
  };
}
