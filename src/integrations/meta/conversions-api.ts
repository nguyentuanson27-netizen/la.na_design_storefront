import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { MetaConversionsConfig } from "./pixel-config.ts";

/**
 * Server-side Conversions API events.
 *
 * Browser/server twins share event_name and event_id. Purchase uses the public order code;
 * browser occurrences and committed cart mutations use fresh UUIDs. Delivery is best effort:
 * CAPI survives a blocked Pixel, while a browser occurrence still requires the first-party signal.
 */

const VIETNAM_COUNTRY_CODE = "84";
// Vietnamese mobile subscriber numbers are nine digits once the trunk zero is removed.
const VIETNAM_SUBSCRIBER_DIGITS = 9;

export type MetaUserIdentity = Readonly<{
  phone: string | null;
  fullName: string | null;
  clientIpAddress: string | null;
  clientUserAgent: string | null;
  /** Meta's own browser cookies. They are the strongest match signal available for a guest. */
  fbp: string | null;
  fbc: string | null;
}>;

export type MetaPurchaseContent = Readonly<{
  id: string;
  quantity: number;
  itemPrice: number;
}>;

export type MetaPurchaseEventInput = Readonly<{
  eventId: string;
  eventTimeSeconds: number;
  eventSourceUrl: string | null;
  valueVnd: number;
  contents: readonly MetaPurchaseContent[];
  identity: MetaUserIdentity;
}>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Meta requires identifiers lowercased and stripped of formatting before hashing; a value
 * normalized differently hashes differently and simply fails to match.
 */
export function hashMetaIdentifier(value: string): string {
  // fn/ln normalization in Meta's current capi-param-builder/stringUtil.js:
  // lowercase, remove whitespace and punctuation, retain Unicode letters/accents.
  return sha256Hex(value.toLowerCase().replace(/[\s\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, ""));
}

/**
 * Meta wants digits only, including country code. Vietnamese numbers are usually written with a
 * national trunk "0" that has to become 84, and the +84 / 0084 / 84 forms have to collapse to the
 * same digits or the same subscriber hashes several different ways and matches none of them.
 *
 * The trunk zero is dropped after the country code as well: "+84 0912 345 678" is a common way to
 * write the number people also give as "0912345678", and both have to reach the same digits.
 */
export function normalizeVietnamesePhone(rawPhone: string): string | null {
  const digits = rawPhone.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;

  const withoutInternationalPrefix = digits.startsWith("00" + VIETNAM_COUNTRY_CODE)
    ? digits.slice(2)
    : digits;

  if (withoutInternationalPrefix.startsWith(VIETNAM_COUNTRY_CODE)) {
    const subscriber = withoutInternationalPrefix.slice(VIETNAM_COUNTRY_CODE.length);
    return VIETNAM_COUNTRY_CODE + (subscriber.startsWith("0") ? subscriber.slice(1) : subscriber);
  }
  if (withoutInternationalPrefix.startsWith("0")) {
    return VIETNAM_COUNTRY_CODE + withoutInternationalPrefix.slice(1);
  }
  // A bare subscriber number, written without the trunk zero. The checkout phone field is free
  // text, so this reaches us as readily as any other spelling and has to land on the same digits.
  if (withoutInternationalPrefix.length === VIETNAM_SUBSCRIBER_DIGITS) {
    return VIETNAM_COUNTRY_CODE + withoutInternationalPrefix;
  }
  return withoutInternationalPrefix;
}

/**
 * Vietnamese names run family name first and given name last, which is the opposite of the
 * fn/ln split Meta expects: the given name is `fn`, the family name is `ln`.
 */
export function splitVietnameseName(fullName: string): { fn: string; ln: string } | null {
  const parts = fullName.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { fn: parts[0]!, ln: parts[0]! };
  return { fn: parts[parts.length - 1]!, ln: parts[0]! };
}

export function buildMetaUserData(identity: MetaUserIdentity): Record<string, unknown> {
  const userData: Record<string, unknown> = {};

  if (identity.phone !== null) {
    const phone = normalizeVietnamesePhone(identity.phone);
    if (phone !== null && /^[1-9][0-9]{7,14}$/.test(phone)) userData.ph = [sha256Hex(phone)];
  }
  if (identity.fullName !== null) {
    const name = splitVietnameseName(identity.fullName);
    if (name !== null) {
      if (/[\p{L}]/u.test(name.fn)) userData.fn = [hashMetaIdentifier(name.fn)];
      if (/[\p{L}]/u.test(name.ln)) userData.ln = [hashMetaIdentifier(name.ln)];
    }
  }
  // Never hashed: Meta documents these as plain-text context, not identifiers.
  if (identity.clientIpAddress !== null && isIP(identity.clientIpAddress)) {
    userData.client_ip_address = identity.clientIpAddress;
  }
  if (identity.clientUserAgent && identity.clientUserAgent.length <= 1024) {
    userData.client_user_agent = identity.clientUserAgent;
  }
  const fbp = validateMetaCookie(identity.fbp, "fbp");
  const fbc = validateMetaCookie(identity.fbc, "fbc");
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  return userData;
}

/** Pass Meta cookies through unchanged; never hash them or invent a click ID. */
export function validateMetaCookie(value: string | null, kind: "fbp" | "fbc"): string | null {
  if (!value || value.length > 512) return null;
  const pattern = kind === "fbp"
    ? /^fb\.\d+\.\d{13}\.[0-9]+(?:\.[A-Za-z0-9_-]+)?$/
    : /^fb\.\d+\.\d{13}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
  return pattern.test(value) ? value : null;
}

export type MetaEventName = "PageView" | "ViewContent" | "AddToCart" | "InitiateCheckout" | "Purchase";

export function buildMetaEvent(input: Readonly<{
  name: MetaEventName;
  eventId: string;
  eventTimeSeconds: number;
  eventSourceUrl: string;
  userData: Record<string, unknown>;
  parameters?: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  return {
    event_name: input.name,
    event_id: input.eventId,
    event_time: input.eventTimeSeconds,
    action_source: "website",
    event_source_url: input.eventSourceUrl,
    user_data: input.userData,
    ...(input.parameters ? { custom_data: input.parameters } : {}),
  };
}

export function buildMetaPurchaseEvent(input: MetaPurchaseEventInput): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_name: "Purchase",
    event_time: input.eventTimeSeconds,
    event_id: input.eventId,
    action_source: "website",
    user_data: buildMetaUserData(input.identity),
    custom_data: {
      currency: "VND",
      value: input.valueVnd,
      contents: input.contents.map((content) => ({
        id: content.id,
        quantity: content.quantity,
        item_price: content.itemPrice,
      })),
      content_type: "product",
    },
  };
  if (input.eventSourceUrl !== null) event.event_source_url = input.eventSourceUrl;
  return event;
}

export function buildMetaConversionsRequest(
  config: MetaConversionsConfig,
  events: readonly Record<string, unknown>[],
): { url: string; body: string } {
  const payload: Record<string, unknown> = { data: events };
  if (config.testEventCode !== null) payload.test_event_code = config.testEventCode;

  return {
    url: `https://graph.facebook.com/${config.graphApiVersion}/${config.pixelId}/events`,
    // The token travels in the body, never the query string, so it cannot leak through request logs.
    body: JSON.stringify({ ...payload, access_token: config.accessToken }),
  };
}

export type MetaConversionsSendResult =
  | { ok: true; attempts: number; eventsReceived: number; traceId: string | null; warningCount: number }
  | { ok: false; reason: "HTTP_ERROR" | "API_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR";
      attempts: number; status?: number; code?: number; subcode?: number; traceId?: string | null };

type SendOptions = Readonly<{
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function safeTraceId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

/**
 * Reporting a sale must never be able to fail a sale, so transport problems are returned rather
 * than thrown and the caller is expected to carry on regardless.
 */
export async function sendMetaConversionEvents(
  config: MetaConversionsConfig,
  events: readonly Record<string, unknown>[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
  options: SendOptions = {},
): Promise<MetaConversionsSendResult> {
  const { url, body } = buildMetaConversionsRequest(config, events);
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let failure: Exclude<MetaConversionsSendResult, { ok: true }> = {
    ok: false, reason: "NETWORK_ERROR", attempts: 0,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retry = true;
    let delayMs = 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Read the body inside the timeout. HTTP 200 alone does not prove acceptance.
      const payload = record(await response.json().catch(() => null));
      const error = record(payload.error);
      const code = typeof error.code === "number" ? error.code : undefined;
      const subcode = typeof error.error_subcode === "number" ? error.error_subcode : undefined;
      const traceId = safeTraceId(payload.fbtrace_id ?? error.fbtrace_id);
      if (response.ok && !payload.error && payload.events_received === events.length && events.length > 0) {
        return { ok: true, attempts: attempt, eventsReceived: events.length, traceId,
          warningCount: Array.isArray(payload.messages) ? payload.messages.length : 0 };
      }
      failure = {
        ok: false, reason: payload.error ? "API_ERROR" : response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR",
        attempts: attempt, status: response.status, traceId,
        ...(code === undefined ? {} : { code }), ...(subcode === undefined ? {} : { subcode }),
      };
      retry = error.is_transient === true || response.status === 429 || response.status >= 500
        || (code !== undefined && [1, 2, 4, 17, 32, 341, 613].includes(code))
        || failure.reason === "INVALID_RESPONSE";
      // Authentication/invalid input cannot be healed by retrying the same body.
      if (code === 190 || code === 100 || response.status === 401 || response.status === 403) retry = false;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(requested)) delayMs = Math.max(delayMs, Math.min(2000, requested));
      }
    } catch {
      failure = { ok: false, reason: "NETWORK_ERROR", attempts: attempt };
    }
    if (!retry || attempt === maxAttempts) break;
    await sleep(delayMs);
  }
  return failure;
}
