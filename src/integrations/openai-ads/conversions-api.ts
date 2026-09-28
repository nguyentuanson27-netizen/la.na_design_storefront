import type { OpenAiAdsConversionsConfig } from "./config.ts";

const MAX_OPPREF_LENGTH = 2048;
const MAX_BROWSER_REFERENCE_LENGTH = 256;
const MAX_USER_AGENT_LENGTH = 1024;

export type OpenAiAdsUserContext = Readonly<{
  obref: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}>;

export type OpenAiAdsContent = Readonly<{
  id: string;
  groupId?: string;
  name: string;
  quantity: number;
  amountVnd: number;
}>;

export type OpenAiAdsOrderEventInput = Readonly<{
  eventId: string;
  timestampMs: number;
  sourceUrl: string;
  oppref: string | null;
  totalVnd: number;
  contents: readonly OpenAiAdsContent[];
  user: OpenAiAdsUserContext;
}>;

function boundedOpaque(value: string | null, maxLength: number): string | null {
  if (value === null || value.length === 0 || value.length > maxLength) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function buildUser(user: OpenAiAdsUserContext): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const obref = boundedOpaque(user.obref, MAX_BROWSER_REFERENCE_LENGTH);
  const userAgent = boundedOpaque(user.userAgent, MAX_USER_AGENT_LENGTH);

  if (obref !== null) result.obref = obref;
  if (user.ipAddress !== null) result.ip_address = user.ipAddress;
  if (userAgent !== null) result.user_agent = userAgent;

  return Object.keys(result).length === 0 ? undefined : result;
}

export function buildOpenAiAdsOrderCreatedEvent(
  input: OpenAiAdsOrderEventInput,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    id: input.eventId,
    type: "order_created",
    timestamp_ms: input.timestampMs,
    source_url: input.sourceUrl,
    action_source: "web",
    data: {
      type: "contents",
      amount: input.totalVnd,
      currency: "VND",
      contents: input.contents.map((content) => ({
        id: content.id,
        ...(content.groupId ? { group_id: content.groupId } : {}),
        name: content.name,
        content_type: "product",
        quantity: content.quantity,
        amount: content.amountVnd,
        currency: "VND",
      })),
    },
  };

  const oppref = boundedOpaque(input.oppref, MAX_OPPREF_LENGTH);
  if (oppref !== null) event.oppref = oppref;

  const user = buildUser(input.user);
  if (user !== undefined) event.user = user;

  return event;
}

export function buildOpenAiAdsConversionsRequest(
  config: OpenAiAdsConversionsConfig,
  events: readonly Record<string, unknown>[],
): { url: string; body: string; authorization: string } {
  return {
    url: `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(config.pixelId)}`,
    body: JSON.stringify({ validate_only: false, events }),
    authorization: `Bearer ${config.apiKey}`,
  };
}

export type OpenAiAdsSendResult =
  | { ok: true }
  | { ok: false; reason: "HTTP_ERROR"; status: number }
  | { ok: false; reason: "NETWORK_ERROR" };

export async function sendOpenAiAdsConversionEvents(
  config: OpenAiAdsConversionsConfig,
  events: readonly Record<string, unknown>[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<OpenAiAdsSendResult> {
  const request = buildOpenAiAdsConversionsRequest(config, events);

  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: {
        authorization: request.authorization,
        "content-type": "application/json",
      },
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: "HTTP_ERROR", status: response.status };
    return { ok: true };
  } catch {
    return { ok: false, reason: "NETWORK_ERROR" };
  }
}
