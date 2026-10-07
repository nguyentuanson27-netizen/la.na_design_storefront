import { buildMetaEvent, buildMetaUserData, sendMetaConversionEvents, type MetaEventName } from "../integrations/meta/conversions-api.ts";
import { readMetaConversionsConfig } from "../integrations/meta/pixel-config.ts";
import type { MetaPurchaseRequestContext } from "./meta-purchase-reporting.ts";
import type { FacebookPixelEventParameters } from "../components/analytics/facebook-pixel-client.ts";

export type CommittedMetaEvent = Readonly<{ eventId: string; parameters: FacebookPixelEventParameters }>;

/** Fixed names and authoritative facts only. All transport failures remain outside commerce. */
export async function reportMetaEventSafely(input: Readonly<{
  name: Exclude<MetaEventName, "Purchase">;
  eventId: string;
  occurredAt: Date;
  parameters?: FacebookPixelEventParameters;
  context: MetaPurchaseRequestContext;
}>, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const config = readMetaConversionsConfig();
    if (!config) return;
    const event = buildMetaEvent({
      name: input.name, eventId: input.eventId,
      eventTimeSeconds: Math.floor(input.occurredAt.getTime() / 1000),
      eventSourceUrl: input.context.eventSourceUrl!,
      userData: buildMetaUserData({ ...input.context, phone: null, fullName: null }),
      parameters: input.parameters,
    });
    const result = await sendMetaConversionEvents(config, [event], fetchImpl);
    // Only bounded status/trace metadata is logged; Graph messages can echo PII or a token.
    const fields = { name: "meta_conversions.delivery", event: input.name, eventId: input.eventId, ...result };
    if (result.ok) console.info(JSON.stringify(fields));
    else console.warn(JSON.stringify(fields));
  } catch {
    console.warn(JSON.stringify({ name: "meta_conversions.delivery", event: input.name, eventId: input.eventId, ok: false, reason: "UNEXPECTED_ERROR" }));
  }
}
