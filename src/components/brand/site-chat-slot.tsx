"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import { MessengerButton } from "./messenger-button";
import { PancakeChat, pancakeChatHasRun } from "./pancake-chat";
import { isAdminPath, siteChatFor } from "./site-chat-policy";

const subscribeToNothing = () => () => {};
const readHostname = () => window.location.hostname;
const readNoHostname = () => null;

/**
 * The client half of `SiteChat`: it reads the host the page is actually served on and the current
 * path, and shows the one chat entry point `siteChatFor` picks.
 *
 * It also keeps admin free of Pancake. Admin and the storefront share one document across
 * client-side navigation, and third-party code that has already run cannot be unloaded, so arriving
 * in admin in a document where Pancake has been inserted reloads the page: the fresh admin document
 * never loads it. Fail-closed -- the check covers a script that is inserted but still downloading.
 */
export function SiteChatSlot({
  pancakePageId,
  pancakeHost,
  messengerHref,
  brandName,
}: Readonly<{
  pancakePageId: string | undefined;
  pancakeHost: string;
  messengerHref: string | null;
  brandName: string;
}>) {
  const pathname = usePathname();
  const hostname = useSyncExternalStore(subscribeToNothing, readHostname, readNoHostname);

  useEffect(() => {
    if (isAdminPath(pathname) && pancakeChatHasRun()) window.location.reload();
  }, [pathname]);

  const kind = siteChatFor({ hostname, pathname, pancakePageId, pancakeHost });
  if (kind === "pancake" && pancakePageId) return <PancakeChat pageId={pancakePageId} />;
  if (kind === "messenger" && messengerHref) return <MessengerButton href={messengerHref} brandName={brandName} />;
  return null;
}
