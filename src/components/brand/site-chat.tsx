import { BRAND, zaloUrlFromTelephone } from "@/brand";

import { SiteChatSlot } from "./site-chat-slot";

/**
 * The storefront's one chat entry point, bottom right: a link button to the shop's Zalo, and nothing
 * in admin (`siteChatFor`). This server half only resolves the brand facts the client half needs, so
 * the brand config never ships to the client.
 */
export function SiteChat() {
  return <SiteChatSlot zaloHref={zaloUrlFromTelephone(BRAND.contact.telephone)} brandName={BRAND.identity.name} />;
}
