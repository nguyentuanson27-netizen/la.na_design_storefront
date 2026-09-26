import { BRAND } from "@/brand";

import { MessengerButton } from "./messenger-button";
import { PancakeChat } from "./pancake-chat";

/**
 * The storefront's one chat entry point, bottom right. With a Pancake Chat Plugin configured and the
 * page on the domain registered with Pancake, the shop chats on the page through Pancake; otherwise
 * the Messenger link button stands in. Never both: two floating bubbles would stack in one corner.
 */
export function SiteChat({ pancakeOnPage }: Readonly<{ pancakeOnPage: boolean }>) {
  const pageId = BRAND.contact.pancakeChatPageId;
  return pageId && pancakeOnPage ? <PancakeChat pageId={pageId} /> : <MessengerButton />;
}
