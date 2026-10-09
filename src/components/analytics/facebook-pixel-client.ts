/**
 * Browser-side pixel calls.
 *
 * Every caller has to tolerate `fbq` being absent: the pixel is unconfigured in some environments,
 * the script is loaded lazily, and ad blockers remove it outright. Analytics is never allowed to
 * throw into a shopper's path, so a missing pixel is a no-op rather than an error.
 */

type Fbq = ((
  method: "track" | "trackCustom",
  eventName: string,
  parameters?: Record<string, unknown>,
  options?: { eventID: string },
) => void) & { callMethod?: unknown };

export type FacebookPixelContent = Readonly<{
  id: string;
  quantity: number;
  item_price: number;
}>;

export type FacebookPixelEventParameters = Readonly<{
  content_ids?: readonly string[];
  content_name?: string;
  content_type?: "product";
  contents?: readonly FacebookPixelContent[];
  currency?: "VND";
  value?: number;
  num_items?: number;
}>;

/**
 * Whether this build ships a pixel at all.
 *
 * next.config.mjs declares this in `env`, so it is a literal here — the same one the pixel
 * component and the Content-Security-Policy are derived from. With no pixel configured the
 * storefront renders no snippet, `fbq` will never appear, and tracking must be a true no-op:
 * callers still fire events unconditionally, and queueing them would hold data and a timer for a
 * page's whole life in the default configuration.
 */
const PIXEL_CONFIGURED = (process.env.LA_BUILD_FACEBOOK_PIXEL_ID ?? "").length > 0;

/** `fbq` in any form: the inline snippet's queueing stub, or the loaded library. */
function readFbq(): Fbq | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { fbq?: unknown }).fbq;
  return typeof candidate === "function" ? (candidate as Fbq) : null;
}

/**
 * True once `fbevents.js` is running rather than just the snippet's stub.
 *
 * The stub sets `loaded` itself, so that flag says nothing; the library is what defines
 * `callMethod` and what drains the stub's queue.
 */
function isPixelLibraryLoaded(): boolean {
  const fbq = readFbq();
  return fbq !== null && typeof fbq.callMethod === "function";
}

/**
 * Events are handed to `fbq` the moment it exists, stub included, so Meta's own pre-load queue does
 * the buffering it was built for — the library flushes it whenever it finishes loading, however
 * long that takes. Nothing here expires an event.
 *
 * Two things still need waiting on, and they are different:
 *
 *   - Before the snippet has run at all there is no `fbq` to hand anything to. Those calls are held
 *     here, in order, until there is. `next/script` loads the snippet `afterInteractive`, so a
 *     page-level event fired from a mount effect regularly lands in this window.
 *   - A caller that records an event as sent must not do so while it sits in a queue an ad blocker
 *     will discard. The snippet records the external script's lifecycle on the script element
 *     itself before inserting it, so an acknowledgement subscriber can observe a terminal state
 *     even if the browser's one-shot `load`/`error` event happened before the subscriber existed.
 */
type PendingCall = {
  eventName: string;
  parameters: FacebookPixelEventParameters | undefined;
  eventId: string | undefined;
  onAccepted: (() => void) | undefined;
};

type LibraryScriptStatus = "loading" | "ready" | "unavailable";

const POLL_INTERVAL_MS = 250;
/**
 * Bounds only the wait for `fbq` to be defined, which the snippet does synchronously as soon as it
 * runs. Reaching this means the snippet never executed at all; the calls stay queued and the next
 * `trackFacebookPixelEvent` re-checks, so stopping the timer costs nothing.
 */
const FBQ_APPEARANCE_WAIT_MS = 30_000;

/** Calls made before `fbq` existed at all, oldest first. */
let callsAwaitingFbq: PendingCall[] = [];
/** Acknowledgements for calls already handed over, waiting on the library to actually load. */
let acknowledgementsAwaitingLibrary: Array<() => void> = [];
let poll: ReturnType<typeof setInterval> | null = null;
let watchingLibraryScript = false;

function stopPolling(): void {
  if (poll !== null) {
    clearInterval(poll);
    poll = null;
  }
}

function flushAcknowledgements(): void {
  if (acknowledgementsAwaitingLibrary.length === 0) return;
  const acknowledgements = acknowledgementsAwaitingLibrary;
  acknowledgementsAwaitingLibrary = [];
  for (const acknowledge of acknowledgements) acknowledge();
}

function abandonAcknowledgements(): void {
  acknowledgementsAwaitingLibrary = [];
}

function flushCallsAwaitingFbq(fbq: Fbq): void {
  if (callsAwaitingFbq.length === 0) return;
  const queued = callsAwaitingFbq;
  callsAwaitingFbq = [];
  for (const call of queued) {
    handToPixel(fbq, call.eventName, call.parameters, call.eventId, call.onAccepted);
  }
}

function readLibraryScriptStatus(script: HTMLScriptElement): LibraryScriptStatus | null {
  const status = script.dataset.laMetaPixelStatus;
  return status === "loading" || status === "ready" || status === "unavailable" ? status : null;
}

/**
 * Resolves an acknowledgement wait from the durable lifecycle state written by the inline snippet.
 * Returns true once the script reached a terminal state, including an inconsistent `ready` marker
 * without `fbq.callMethod`, which must fail closed rather than suppressing a future Purchase retry.
 */
function settleFromLibraryScript(script: HTMLScriptElement): boolean {
  const status = readLibraryScriptStatus(script);
  if (status === "unavailable") {
    abandonAcknowledgements();
    return true;
  }
  if (status !== "ready") return false;

  if (isPixelLibraryLoaded()) flushAcknowledgements();
  else abandonAcknowledgements();
  return true;
}

/**
 * Waits on the pixel script without depending on observing a one-shot browser event.
 *
 * The snippet sets `data-la-meta-pixel-status=loading` before inserting `fbevents.js`, then changes
 * it to `ready` or `unavailable` from handlers registered before insertion. We read that durable
 * state before listening and again immediately after listening. The second read closes the race in
 * which the script finishes between those two operations; a terminal event that already happened
 * cannot be lost because its state remains on the element.
 */
function watchLibraryScript(): void {
  if (watchingLibraryScript) return;
  const script = document.querySelector<HTMLScriptElement>(
    'script[src*="connect.facebook.net"]',
  );
  if (script === null) return;
  if (settleFromLibraryScript(script)) return;

  watchingLibraryScript = true;

  const cleanup = () => {
    script.removeEventListener("load", onLoad);
    script.removeEventListener("error", onError);
    watchingLibraryScript = false;
  };
  const onLoad = () => {
    cleanup();
    // The snippet's own onload runs from a handler installed before insertion, so the durable
    // status should already be terminal here. Keep a fail-closed fallback for malformed markup.
    if (!settleFromLibraryScript(script)) {
      if (isPixelLibraryLoaded()) flushAcknowledgements();
      else abandonAcknowledgements();
    }
  };
  const onError = () => {
    cleanup();
    abandonAcknowledgements();
  };

  script.addEventListener("load", onLoad, { once: true });
  script.addEventListener("error", onError, { once: true });

  // A terminal event may have happened before these listeners were attached. Its durable status
  // still remains, so close that race synchronously and remove listeners that would never fire.
  if (settleFromLibraryScript(script)) cleanup();
}

function startPolling(): void {
  if (poll !== null) return;
  const stopWaitingAtMs = Date.now() + FBQ_APPEARANCE_WAIT_MS;
  poll = setInterval(() => {
    const fbq = readFbq();
    if (fbq !== null) {
      flushCallsAwaitingFbq(fbq);
      stopPolling();
      return;
    }
    if (Date.now() >= stopWaitingAtMs) stopPolling();
  }, POLL_INTERVAL_MS);
}

function handToPixel(
  fbq: Fbq,
  eventName: string,
  parameters: FacebookPixelEventParameters | undefined,
  eventId: string | undefined,
  onAccepted: (() => void) | undefined,
): void {
  try {
    if (eventId === undefined) {
      fbq("track", eventName, parameters as Record<string, unknown> | undefined);
    } else {
      fbq("track", eventName, parameters as Record<string, unknown> | undefined, {
        eventID: eventId,
      });
    }
  } catch {
    // A tracking failure is never worth interrupting a shopper for.
    return;
  }

  if (onAccepted === undefined) return;
  if (isPixelLibraryLoaded()) {
    onAccepted();
    return;
  }

  // Handed to the stub's queue. Acknowledge only once the library exists to drain it. A terminal
  // unavailable state clears this callback immediately instead of waiting for an event already lost.
  acknowledgementsAwaitingLibrary.push(onAccepted);
  watchLibraryScript();
  // The library can become usable between the checks above and the watcher setup.
  if (isPixelLibraryLoaded()) flushAcknowledgements();
}

/**
 * Reports one event to the pixel.
 *
 * `eventId` must match the `event_id` of the Conversions API twin, which is how Meta collapses the
 * pair into one conversion instead of counting the purchase twice.
 *
 * `onAccepted` fires when the loaded pixel library has taken the event. That is an acknowledgement
 * of hand-off, not of receipt: it says the event is no longer at risk of being dropped on this
 * page, not that Meta's servers answered. It never fires while the pixel is blocked or absent,
 * which is what lets a caller safely record an event as sent.
 */
export function trackFacebookPixelEvent(
  eventName: string,
  parameters?: FacebookPixelEventParameters,
  eventId?: string,
  onAccepted?: () => void,
): void {
  // No pixel in this build: nothing will ever consume a queued event, so hold nothing.
  if (!PIXEL_CONFIGURED) return;
  if (typeof window === "undefined") return;

  const fbq = readFbq();
  if (fbq === null) {
    callsAwaitingFbq.push({ eventName, parameters, eventId, onAccepted });
    startPolling();
    return;
  }
  // Anything still queued from before the snippet ran goes first, so order is preserved.
  flushCallsAwaitingFbq(fbq);
  handToPixel(fbq, eventName, parameters, eventId, onAccepted);
}
