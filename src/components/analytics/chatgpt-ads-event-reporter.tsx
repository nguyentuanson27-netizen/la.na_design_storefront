import { readOpenAiAdsPixelConfig } from "@/integrations/openai-ads/config";
import type { PurchaseEvent, TrackingEvent } from "@/tracking/commerce-events";

import { ChatGptAdsOrderEvent } from "./chatgpt-ads-order-event";

/** Routes only reviewed canonical Purchase events to the ChatGPT Ads browser SDK. */
export function ChatGptAdsEventReporter({ event }: { event: TrackingEvent | null }) {
  if (event === null || event.event !== "purchase") return null;
  if (readOpenAiAdsPixelConfig() === null) return null;

  return <ChatGptAdsOrderEvent event={event as PurchaseEvent} />;
}
