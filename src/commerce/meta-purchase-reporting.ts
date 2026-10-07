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
export const META_PURCHASE_REPLAY_MS = 7 * 86400_000;

/** Retain immutable browser business facts, never attribution after acknowledgement/expiry. */
function withoutAttribution(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const event = JSON.parse(payload);
    return JSON.stringify({ event_name: event.event_name, event_id: event.event_id,
      event_time: event.event_time, action_source: event.action_source, custom_data: event.custom_data });
  } catch { return null; }
}

/** Bounded maintenance on existing PageView/retry paths; no new worker or commerce state change. */
export async function cleanupMetaPurchaseAttributionSafely(client: ReportClient, now = new Date()): Promise<void> {
  try {
    const eligibility = { OR: [
      { metaPurchaseSentAt: { not: null } },
      { purchaseOccurredAt: { lte: new Date(now.getTime() - META_PURCHASE_REPLAY_MS) } },
      { purchaseOccurredAt: null, updatedAt: { lte: new Date(now.getTime() - META_PURCHASE_REPLAY_MS) } },
    ] };
    const orders = await client.orderMirror.findMany({
      where: { AND: [eligibility, { OR: [{ metaPurchaseContext: { not: null } },
        { metaPurchasePayload: { contains: '"user_data"' } }] }] },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 20,
      select: { id: true, metaPurchaseContext: true, metaPurchasePayload: true },
    });
    for (const order of orders) await client.orderMirror.updateMany({
      where: { id: order.id, ...eligibility, metaPurchaseContext: order.metaPurchaseContext, metaPurchasePayload: order.metaPurchasePayload },
      data: { metaPurchaseContext: null, metaPurchasePayload: withoutAttribution(order.metaPurchasePayload) },
    });
  } catch {
    console.warn(JSON.stringify({ name: "meta_conversions.attribution_cleanup_failed", reason: "STORAGE_UNAVAILABLE" }));
  }
}

/** Persist first-party context BEFORE the POS write, so an unknown outcome can be reconciled later. */
export async function saveMetaPurchaseContextSafely(client: ReportClient, orderCode: string, context: MetaPurchaseRequestContext, now = new Date()): Promise<void> {
  try {
    if (!readMetaConversionsConfig()) return;
    await client.orderMirror.updateMany({
      where: { publicCode: orderCode, metaPurchaseContext: null, metaPurchaseSentAt: null,
        OR: [{ purchaseOccurredAt: null }, { purchaseOccurredAt: { gt: new Date(now.getTime() - META_PURCHASE_REPLAY_MS) } }],
        state: { in: ["DRAFT", "VALIDATING", "POS_SUBMITTING", "SYNC_UNKNOWN"] } },
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
  const now = options.now ?? new Date();
  const eligibleAfter = new Date(now.getTime() - META_PURCHASE_REPLAY_MS);
  const order = await client.orderMirror.findUnique({
    where: { publicCode: orderCode },
    select: { state: true, purchaseOccurredAt: true, guestName: true, guestPhone: true,
      metaPurchaseContext: true, metaPurchasePayload: true, metaPurchaseSentAt: true },
  });
  if (!order || order.state !== "CONFIRMED" || order.metaPurchaseSentAt) return;
  if (order.purchaseOccurredAt && order.purchaseOccurredAt <= eligibleAfter) {
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, purchaseOccurredAt: { lte: eligibleAfter },
      metaPurchasePayload: order.metaPurchasePayload },
      data: { metaPurchaseContext: null, metaPurchasePayload: withoutAttribution(order.metaPurchasePayload) } });
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", order: orderCode, reason: "EVENT_EXPIRED" }));
    return;
  }
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
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, state: "CONFIRMED", metaPurchaseSentAt: null,
      purchaseOccurredAt: { gt: eligibleAfter }, metaPurchasePayload: null },
      data: { metaPurchasePayload: JSON.stringify(event) } });
    const frozen = await client.orderMirror.findUnique({ where: { publicCode: orderCode },
      select: { metaPurchasePayload: true, metaPurchaseSentAt: true } });
    if (frozen?.metaPurchaseSentAt) return;
    payload = frozen?.metaPurchasePayload ?? null;
  }
  if (!payload) return;
  const event = JSON.parse(payload);
  if (event.event_name !== "Purchase" || event.event_id !== orderCode || !Number.isSafeInteger(event.event_time)) {
    throw new Error("Invalid stored Meta Purchase");
  }
  // Do not fabricate a fresh conversion timestamp to make an expired event look acceptable.
  if (now.getTime() / 1000 - event.event_time >= META_PURCHASE_REPLAY_MS / 1000) {
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, metaPurchasePayload: payload },
      data: { metaPurchaseContext: null, metaPurchasePayload: withoutAttribution(payload) } });
    console.warn(JSON.stringify({ name: "meta_conversions.purchase_failed", order: orderCode, reason: "EVENT_EXPIRED" }));
    return;
  }
  const result = await sendMetaConversionEvents(config, [event], options.fetchImpl);
  const fields = { name: "meta_conversions.delivery", event: "Purchase", order: orderCode, ...result };
  if (result.ok) {
    await client.orderMirror.updateMany({ where: { publicCode: orderCode, metaPurchaseSentAt: null },
      data: { metaPurchaseSentAt: now, metaPurchaseContext: null, metaPurchasePayload: withoutAttribution(payload) } });
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
