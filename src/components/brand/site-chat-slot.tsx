"use client";

import { usePathname } from "@/i18n/navigation";

import { siteChatFor } from "./site-chat-policy";
import { ZaloButton } from "./zalo-button";

/**
 * The client half of `SiteChat`: it reads the current path and shows the chat entry point
 * `siteChatFor` picks. The path is known on the server too, so the button is part of the served HTML.
 */
export function SiteChatSlot({ zaloHref, brandName }: Readonly<{ zaloHref: string | null; brandName: string }>) {
  const pathname = usePathname();
  return siteChatFor({ pathname, zaloHref }) === "zalo" && zaloHref !== null ? (
    <ZaloButton href={zaloHref} brandName={brandName} />
  ) : null;
}
