import { readCanonicalPurchaseSnapshot } from "./canonical-purchase-snapshot.ts";
import {
  buildOpenAiAdsOrderCreatedEvent,
  sendOpenAiAdsConversionEvents,
  type OpenAiAdsUserContext,
} from "../integrations/openai-ads/conversions-api.ts";
import { readOpenAiAdsConversionsConfig } from "../integrations/openai-ads/config.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

type ReportClient = Pick<PrismaClient, "orderMirror" | "variantMirror">;

export type OpenAiAdsPurchaseRequestContext = Readonly<{
  oppref: string | null;
  obref: string | null;
  clientIpAddress: string | null;
  clientUserAgent: string | null;
  eventSourceUrl: string;
}>;

export type OpenAiAdsPurchaseReportOptions = Readonly<{
  now?: Date;
  fetchImpl?: typeof fetch;
}>;

/**
 * Reports one confirmed immutable order to ChatGPT Ads.
 *
 * Uses the same public order code as the browser Pixel event id, so Pixel and CAPI describe one
 * conversion. Tracking is best-effort and must never influence the already-completed checkout.
 */
export async function reportOpenAiAdsPurchase(
  client: ReportClient,
  orderCode: string,
  context: OpenAiAdsPurchaseRequestContext,
  options: OpenAiAdsPurchaseReportOptions = {},
): Promise<void> {
  const config = readOpenAiAdsConversionsConfig();
  if (config === null) return;

  const snapshot = await readCanonicalPurchaseSnapshot(client, orderCode);
  if (snapshot === null) return;

  const user: OpenAiAdsUserContext = {
    obref: context.obref,
    ipAddress: context.clientIpAddress,
    userAgent: context.clientUserAgent,
  };

  const event = buildOpenAiAdsOrderCreatedEvent({
    eventId: snapshot.publicCode,
    timestampMs: (options.now ?? new Date()).getTime(),
    sourceUrl: context.eventSourceUrl,
    oppref: context.oppref,
    totalVnd: snapshot.totalVnd,
    contents: snapshot.items.map((item) => ({
      id: item.item_id,
      ...(item.item_group_id ? { groupId: item.item_group_id } : {}),
      name: item.item_name,
      quantity: item.quantity,
      amountVnd: item.price,
    })),
    user,
  });

  const result = await sendOpenAiAdsConversionEvents(config, [event], options.fetchImpl);
  if (!result.ok) {
    console.warn(
      `openai_ads.conversions.order_created_failed order=${orderCode} reason=${result.reason}` +
        (result.reason === "HTTP_ERROR" ? ` status=${result.status}` : ""),
    );
  }
}

export async function reportOpenAiAdsPurchaseSafely(
  client: ReportClient,
  orderCode: string,
  context: OpenAiAdsPurchaseRequestContext,
  options: OpenAiAdsPurchaseReportOptions = {},
): Promise<void> {
  try {
    await reportOpenAiAdsPurchase(client, orderCode, context, options);
  } catch (error) {
    console.warn(
      `openai_ads.conversions.order_created_failed order=${orderCode} reason=UNEXPECTED_ERROR` +
        ` detail=${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}
