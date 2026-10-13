/**
 * Holds a CAPI twin's browser signal until Meta's browser ID cookie exists.
 *
 * On a shopper's first page `_fbp` is written by `fbevents.js`, which the snippet loads
 * `afterInteractive`, so it regularly lands after the effect that reports PageView. A twin posted
 * before then reaches Meta without `fbp`, which weakens both user matching and Meta's fallback
 * deduplication key. Returning shoppers already carry the cookie and are sent synchronously.
 *
 * The wait never trades the server twin for the browser ID: it ends as soon as the cookie appears,
 * the library is blocked, the library has loaded without writing one, the page is being hidden, or
 * a short deadline passes. CAPI exists for exactly the browsers where the pixel never arrives.
 */

const FBP_WAIT_MS = 2_000;
/** Deliberately not the pixel client's 250 ms cadence, which the browser suite counts as its own. */
const CHECK_INTERVAL_MS = 100;
/** `fbevents.js` writes `_fbp` while draining the snippet's queue; give that a moment once loaded. */
const LOADED_GRACE_MS = 300;

function hasBrowserIdCookie(): boolean {
  return document.cookie.split(";").some((cookie) => cookie.trimStart().startsWith("_fbp="));
}

function readPixelLibraryStatus(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[src*="connect.facebook.net"]');
  return script?.dataset.laMetaPixelStatus ?? null;
}

export function whenMetaBrowserIdKnown(send: () => void, now: () => number = Date.now): void {
  if (hasBrowserIdCookie()) {
    send();
    return;
  }

  const deadline = now() + FBP_WAIT_MS;
  let loadedAt: number | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    window.removeEventListener("pagehide", finish);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    // Runs from a timer or an event, outside the caller's guard; measurement never throws at a shopper.
    try { send(); } catch { /* Nothing to recover. */ }
  };
  // A keepalive fetch still leaves while the page is going away; a pending timer does not.
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") finish();
  };
  const check = () => {
    timer = null;
    if (settled) return;
    const status = readPixelLibraryStatus();
    const at = now();
    if (status === "ready" && loadedAt === null) loadedAt = at;
    if (
      hasBrowserIdCookie()
      || status === "unavailable"
      || (loadedAt !== null && at - loadedAt >= LOADED_GRACE_MS)
      || at >= deadline
    ) {
      finish();
      return;
    }
    timer = setTimeout(check, CHECK_INTERVAL_MS);
  };

  window.addEventListener("pagehide", finish);
  document.addEventListener("visibilitychange", onVisibilityChange);
  check();
}
