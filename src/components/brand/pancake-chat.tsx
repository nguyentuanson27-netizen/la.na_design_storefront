"use client";

import { useEffect } from "react";

/** The `<script>` this component inserts, and the element Pancake's script appends to `<body>`. */
export const PANCAKE_SCRIPT_ID = "pancake-chat-plugin";
export const PANCAKE_ROOT_ID = "pancake-chat-plugin-root";

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

/**
 * Pancake's website Chat Plugin: the floating chat bubble, bottom right, whose conversations land
 * in the shop's Pancake inbox. Customers chat on the page itself instead of being sent to Messenger.
 *
 * The script is Pancake's installation snippet (about 750 KB), inserted once the page has loaded and
 * the browser is idle, so it never competes with first paint. The component inserts it itself rather
 * than through `next/script`, whose `lazyOnload` cannot be cancelled: leaving the page before the
 * idle callback fires -- say, into admin -- must mean the script is never inserted at all.
 *
 * Pancake appends its root straight to `<body>`, outside every landmark, so once the script has run
 * the root is labelled as its own complementary landmark. Its stacking and position are overridden in
 * the stylesheet (`#pancake-chat-plugin-root`).
 */
export function PancakeChat({ pageId }: Readonly<{ pageId: string }>) {
  useEffect(() => {
    if (document.getElementById(PANCAKE_SCRIPT_ID) !== null) return;

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const insert = () => {
      const script = document.createElement("script");
      script.id = PANCAKE_SCRIPT_ID;
      script.src = `https://chat-plugin.pancake.vn/main/auto?page_id=${encodeURIComponent(pageId)}`;
      script.async = true;
      script.addEventListener("load", () => {
        const root = document.getElementById(PANCAKE_ROOT_ID);
        root?.setAttribute("role", "complementary");
        root?.setAttribute("aria-label", "Chat với shop");
      });
      window.__lanaPancakeChatInserted = true;
      document.body.appendChild(script);
    };
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
  }, [pageId]);

  return null;
}
