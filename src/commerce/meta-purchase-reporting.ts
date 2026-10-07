import { readMetaPurchaseSnapshot } from "./meta-purchase-snapshot.ts";
import { buildMetaPurchaseEvent, buildMetaUserData, sendMetaConversionEvents } from "../integrations/meta/conversions-api.ts";
import { readMetaConversionsConfig } from "../integrations/meta/pixel-config.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

type ReportClient = Pick<PrismaClient, "orderMirror">;

export type MetaPurchaseRequestContext = Readonly<{
  clientIpAddress: string | null;
  clientUserAgent: string | null;
  fbp: string | null;
  fbc: string | null;
  eventSourceUrl: string | null;
}>;

export type MetaPurchaseReportOptions = Readonly<{ now?: Date; fetchImpl?: typeof fetch }>;

/** Persist first-party context BEFORE the POS write, so an unknown outcome can be reconciled later. */
export async function saveMetaPurchaseContextSafely(client: ReportClient, orderCode: string, context: MetaPurchaseRequestContext): Promise<void> {
  try {
    if (!readMetaConversionsConfig()) return;
    await client.orderMirror.updateMany({
      where: { publicCode: orderCode, metaPurchaseContext: null, state: { in: ["DRAFT", "VALIDATING", "POS_SUBMITTING", "SYNC_UNKNOWN"] } },
      data: { metaPurchaseContext: JSON.stringify({
        eventSourceUrl: context.eventSourceUrl,
        userData: buildMetaUserData({ ...context, phone: null, fullName: null }),
      }) },
    });
  } catch {
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_context_failed", reason: "UNEXPECTED_ERROR" }));
  }
}

/** Stable publicCode, conversion timestamp and serialized payload on every delivery attempt. */
export async function reportMetaPurchase(client: ReportClient, orderCode: string,
  context: MetaPurchaseRequestContext | null = null, options: MetaPurchaseReportOptions = {}): Promise<void> {
  const config = readMetaConversionsConfig();
  if (!config) return;
  const order = await client.orderMirror.findUnique({
    where: { publicCode: orderCode },
    select: { state: true, purchaseOccurredAt: true, guestName: true, guestPhone: true,
      metaPurchaseContext: true, metaPurchasePayload: true, metaPurchaseSentAt: true },
  });
  if (!order || order.state !== "CONFIRMED" || order.metaPurchaseSentAt) return;
  let payload = order.metaPurchasePayload;
  if (!payload) {
    const occurredAt = order.purchaseOccurredAt;
    const snapshot = await readMetaPurchaseSnapshot(client, orderCode);
    if (!occurredAt || !snapshot) {
      console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", order: orderCode, reason: "HISTORICAL_FACTS_UNAVAILABLE" }));
      return;
    }
    const saved = order.metaPurchaseContext ? JSON.parse(order.metaPurchaseContext) : null;
    const event = buildMetaPurchaseEvent({
      eventId: orderCode, eventTimeSeconds: Math.floor(occurredAt.getTime() / 1000),
      eventSourceUrl: saved?.eventSourceUrl ?? context?.eventSourceUrl ?? null,
      valueVnd: snapshot.valueVnd, contents: snapshot.contents,
      identity: { phone: order.guestPhone, fullName: order.guestName,
        clientIpAddress: context?.clientIpAddress ?? null, clientUserAgent: context?.clientUserAgent ?? null,
        fbp: context?.fbp ?? null, fbc: context?.fbc ?? null },
    });
    if (saved) event.user_data = { ...(event.user_data as Record<string, unknown>), ...saved.userData };
    // CAS chooses one payload under concurrent submit/reconcile/readback. Losers replay its bytes.
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, metaPurchasePayload: null },
      data: { metaPurchasePayload: JSON.stringify(event) } });
    payload = (await client.orderMirror.findUnique({ where: { publicCode: orderCode },
      select: { metaPurchasePayload: true } }))?.metaPurchasePayload ?? null;
  }
  if (!payload) return;
  const event = JSON.parse(payload);
  const now = options.now ?? new Date();
  if (event.event_name !== "Purchase" || event.event_id !== orderCode || !Number.isSafeInteger(event.event_time)) {
    throw new Error("Invalid stored Meta Purchase");
  }
  // Do not fabricate a fresh conversion timestamp to make an expired event look acceptable.
  if (now.getTime() / 1000 - event.event_time > 7 * 86400) {
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", order: orderCode, reason: "EVENT_EXPIRED" }));
    return;
  }
  const result = await sendMetaConversionEvents(config, [event], options.fetchImpl);
  const fields = { name: "meta_conversions.delivery", event: "Purchase", order: orderCode, ...result };
  if (result.ok) {
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, metaPurchaseSentAt: null },
      data: { metaPurchaseSentAt: now } });
    console.info(JSON.stringify(fields));
  } else console.warn(JSON.stringify(fields));
}

export async function reportMetaPurchaseSafely(client: ReportClient, orderCode: string,
  context: MetaPurchaseRequestContext | null = null, options: MetaPurchaseReportOptions = {}): Promise<void> {
  try { await reportMetaPurchase(client, orderCode, context, options); }
  catch {
    // Never log exception messages: DB/HTTP errors may contain PII, connection strings or tokens.
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", order: orderCode, reason: "UNEXPECTED_ERROR" }));
  }
}
