"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

/** The element Pancake's script appends to `<body>` and renders its bubble and chat box into. */
const PANCAKE_ROOT_ID = "pancake-chat-plugin-root";

/**
 * Pancake's website Chat Plugin: the floating chat bubble, bottom right, whose conversations land
 * in the shop's Pancake inbox. Customers chat on the page itself instead of being sent to Messenger.
 *
 * The script is Pancake's own installation snippet (about 750 KB), loaded once the page is idle
 * (`lazyOnload`) so it never competes with first paint. Admin is a work surface and loads no chat.
 *
 * Pancake appends its root straight to `<body>`, outside every landmark, so once the script has
 * run the root is labelled as its own complementary landmark -- the same fix the Messenger button's
 * `aside` makes. Its stacking and position are overridden in the stylesheet (`#pancake-chat-plugin-root`).
 */
export function PancakeChat({ pageId }: Readonly<{ pageId: string }>) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <Script
      id="pancake-chat-plugin"
      src={`https://chat-plugin.pancake.vn/main/auto?page_id=${encodeURIComponent(pageId)}`}
      strategy="lazyOnload"
      onLoad={() => {
        const root = document.getElementById(PANCAKE_ROOT_ID);
        root?.setAttribute("role", "complementary");
        root?.setAttribute("aria-label", "Chat với shop");
      }}
    />
  );
}
