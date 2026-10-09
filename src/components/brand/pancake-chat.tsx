"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MessengerButton } from "./messenger-button";

/** The `<script>` this component inserts, and the element Pancake's script appends to `<body>`. */
export const PANCAKE_SCRIPT_ID = "pancake-chat-plugin";
export const PANCAKE_ROOT_ID = "pancake-chat-plugin-root";
/** Pancake's own bubble inside its root: clicking it is how its chat box opens. */
const PANCAKE_BUBBLE_SELECTOR = "#pkcp-button";
/**
 * Set once a shopper has opened the chat in this browser. From then on the real widget loads on
 * every page, as it always used to, so a reply from the shop reaches them without a tap.
 */
export const PANCAKE_ENGAGED_STORAGE_KEY = "lana:pancake-chat-engaged";
/** How long a tapped bubble waits for Pancake before it hands the shopper to Messenger instead. */
const PANCAKE_OPEN_TIMEOUT_MS = 12_000;

declare global {
  interface Window {
    /** Set the moment the Pancake script is inserted, before it has even downloaded. */
    __lanaPancakeChatInserted?: boolean;
    PancakeChatPlugin?: unknown;
  }
}

/**
 * Whether Pancake's third-party code has been inserted into, or has run in, this document. Once it
 * has, it cannot be taken back out: its DOM, websocket and listeners outlive any React unmount.
 */
export function pancakeChatHasRun(): boolean {
  return (
    window.__lanaPancakeChatInserted === true ||
    window.PancakeChatPlugin !== undefined ||
    document.getElementById(PANCAKE_SCRIPT_ID) !== null ||
    document.getElementById(PANCAKE_ROOT_ID) !== null
  );
}

function readEngaged(): boolean {
  try {
    return window.localStorage.getItem(PANCAKE_ENGAGED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberEngaged(): void {
  try {
    window.localStorage.setItem(PANCAKE_ENGAGED_STORAGE_KEY, "1");
  } catch {
    // Storage blocked: the shopper simply taps the bubble again on the next page load.
  }
}

/** Inserts Pancake's installation script once per document, reporting a load failure. */
function insertPancakeScript(pageId: string, onError?: () => void): void {
  if (document.getElementById(PANCAKE_SCRIPT_ID) !== null) return;
  const script = document.createElement("script");
  script.id = PANCAKE_SCRIPT_ID;
  script.src = `https://chat-plugin.pancake.vn/main/auto?page_id=${encodeURIComponent(pageId)}`;
  script.async = true;
  script.addEventListener("load", () => {
    const root = document.getElementById(PANCAKE_ROOT_ID);
    root?.setAttribute("role", "complementary");
    root?.setAttribute("aria-label", "Chat với shop");
  });
  if (onError) script.addEventListener("error", onError, { once: true });
  window.__lanaPancakeChatInserted = true;
  document.body.appendChild(script);
}

const subscribeToNothing = () => () => {};
const readFalse = () => false;

type FacadePhase = "idle" | "loading" | "open" | "failed";

/**
 * Pancake's website Chat Plugin: the floating chat bubble, bottom right, whose conversations land
 * in the shop's Pancake inbox. Customers chat on the page itself instead of being sent to Messenger.
 *
 * Pancake's installation snippet is about 750 KB of script, and running it on a phone ties up the
 * main thread for long enough to make the first taps on a page feel stuck. So a first-time visitor
 * gets a facade: a lightweight bubble of our own in the same corner, and the real widget is inserted
 * only when that bubble is tapped -- at which point it is opened for them, so one tap still opens
 * the chat. A shopper who has opened it before (`PANCAKE_ENGAGED_STORAGE_KEY`) gets the real widget
 * once the page has loaded and the browser is idle, which is how every visitor used to get it. If
 * Pancake cannot be reached after a tap, the bubble becomes the Messenger link.
 *
 * The component inserts the script itself rather than through `next/script`, whose `lazyOnload`
 * cannot be cancelled: leaving the page before the idle callback fires -- say, into admin -- must
 * mean the script is never inserted at all.
 *
 * Pancake appends its root straight to `<body>`, outside every landmark, so once the script has run
 * the root is labelled as its own complementary landmark. Its stacking and position are overridden in
 * the stylesheet (`#pancake-chat-plugin-root`).
 */
export function PancakeChat({
  pageId,
  messengerHref,
  brandName,
}: Readonly<{ pageId: string; messengerHref: string | null; brandName: string }>) {
  // Read after hydration only: the server and the first client render both show the facade state.
  const engaged = useSyncExternalStore(subscribeToNothing, readEngaged, readFalse);
  const alreadyRunning = useSyncExternalStore(subscribeToNothing, pancakeChatHasRun, readFalse);
  const [phase, setPhase] = useState<FacadePhase>("idle");
  const cleanupRef = useRef<(() => void) | null>(null);

  // A returning chatter: the real widget, deferred to idle after load exactly as before.
  useEffect(() => {
    if (!engaged || document.getElementById(PANCAKE_SCRIPT_ID) !== null) return;

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const insert = () => insertPancakeScript(pageId);
    const schedule = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(insert, { timeout: 5_000 });
      } else {
        timeoutHandle = setTimeout(insert, 1_500);
      }
    };

    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });

    return () => {
      window.removeEventListener("load", schedule);
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    };
  }, [engaged, pageId]);

  useEffect(() => () => cleanupRef.current?.(), []);

  function openRealWidget() {
    if (phase === "loading") return;
    setPhase("loading");
    rememberEngaged();

    const observer = new MutationObserver(() => {
      tryOpen();
    });
    const timeout = setTimeout(() => {
      // Pancake answered but never drew its bubble, or never answered: Messenger stands in.
      finish(document.getElementById(PANCAKE_ROOT_ID) !== null ? "open" : "failed");
    }, PANCAKE_OPEN_TIMEOUT_MS);
    function finish(next: FacadePhase) {
      observer.disconnect();
      clearTimeout(timeout);
      cleanupRef.current = null;
      setPhase(next);
    }
    function tryOpen() {
      const bubble = document.querySelector<HTMLElement>(
        `#${PANCAKE_ROOT_ID} ${PANCAKE_BUBBLE_SELECTOR}`,
      );
      if (!bubble) return false;
      bubble.click();
      finish("open");
      return true;
    }
    cleanupRef.current = () => {
      observer.disconnect();
      clearTimeout(timeout);
    };

    insertPancakeScript(pageId, () => finish("failed"));
    if (!tryOpen()) observer.observe(document.body, { childList: true, subtree: true });
  }

  if (phase === "failed") {
    return messengerHref ? <MessengerButton href={messengerHref} brandName={brandName} /> : null;
  }
  // The real widget draws its own bubble; two in one corner would stack. A tapped facade stays up,
  // busy, until that bubble exists (the tap has already marked this browser as engaged).
  if (phase !== "loading" && (engaged || alreadyRunning || phase === "open")) return null;

  return (
    <aside aria-label="Chat với shop">
      <button
        type="button"
        className="pancake-chat-facade"
        aria-label={`Chat với ${brandName}`}
        aria-busy={phase === "loading" ? true : undefined}
        data-loading={phase === "loading" ? "" : undefined}
        onClick={openRealWidget}
      >
        <svg aria-hidden focusable={false} viewBox="0 0 24 24" width={26} height={26}>
          <path
            fill="currentColor"
            d="M12 3C6.48 3 2 6.92 2 11.75c0 2.39 1.1 4.56 2.88 6.14-.2 1.27-.8 2.6-1.84 3.6a.5.5 0 0 0 .4.85c2.02-.15 3.7-.85 4.94-1.68 1.13.33 2.35.52 3.62.52 5.52 0 10-3.92 10-8.75S17.52 3 12 3Zm-4.5 10.25a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"
          />
        </svg>
      </button>
    </aside>
  );
}
