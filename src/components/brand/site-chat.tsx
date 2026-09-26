import { BRAND, messengerUrlFromFanpage } from "@/brand";

import { SiteChatSlot } from "./site-chat-slot";

/**
 * The storefront's one chat entry point, bottom right: Pancake's chat widget on the hosts registered
 * with Pancake, the Messenger link button anywhere else, and nothing in admin (`siteChatFor`). Never
 * both: two floating bubbles would stack in one corner.
 *
 * The host is decided in the browser, from the page's real `location.hostname`; this server half only
 * resolves the brand facts the client half needs, so the brand config never ships to the client.
 */
export function SiteChat({ pancakeHosts }: Readonly<{ pancakeHosts: readonly string[] }>) {
  return (
    <SiteChatSlot
      pancakePageId={BRAND.contact.pancakeChatPageId}
      pancakeHosts={pancakeHosts}
      messengerHref={messengerUrlFromFanpage(BRAND.contact.fanpageUrl)}
      brandName={BRAND.identity.name}
    />
  );
}
