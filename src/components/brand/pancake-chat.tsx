"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

/**
 * Pancake's website Chat Plugin: the floating chat bubble, bottom right, whose conversations land
 * in the shop's Pancake inbox beside its Facebook messages. Customers chat on the page itself
 * instead of being sent to Messenger.
 *
 * The script is Pancake's own installation snippet, loaded once the page is idle (`lazyOnload`) so
 * it never competes with the page's first paint. Admin is a work surface and loads no chat.
 */
export function PancakeChat({ pageId }: Readonly<{ pageId: string }>) {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;

  return (
    <Script
      id="pancake-chat-plugin"
      src={`https://chat-plugin.pancake.vn/main/auto?page_id=${encodeURIComponent(pageId)}`}
      strategy="lazyOnload"
    />
  );
}
