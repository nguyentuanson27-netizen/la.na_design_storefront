import { BRAND } from "@/brand";

import { MessengerButton } from "./messenger-button";
import { PancakeChat } from "./pancake-chat";

/**
 * The storefront's one chat entry point, bottom right. With a Pancake Chat Plugin configured the
 * shop chats on the page through Pancake; without one, the Messenger link button stands in. Never
 * both: two floating bubbles would stack in the same corner.
 */
export function SiteChat() {
  const pageId = BRAND.contact.pancakeChatPageId;
  return pageId ? <PancakeChat pageId={pageId} /> : <MessengerButton />;
}
