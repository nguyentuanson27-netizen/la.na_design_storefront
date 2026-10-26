import { parsePdpVideoPlaybackEvent } from "../commerce/pdp-video-playback.ts";
import { readBoundedBody } from "../commerce/try-on-image.ts";

export const PDP_VIDEO_EVENT_MAX_BYTES = 128;
export const PDP_VIDEO_EVENT_WINDOW_MS = 60_000;
export const PDP_VIDEO_EVENT_LIMIT = 600;

/**
 * Anonymous operational deltas in the existing stdout stream (ADR 0002). No DB rows, IP keys,
 * cookies, source URLs, product identities or caller-supplied strings are retained.
 * The public signals are best effort, not authoritative usage or financial data.
 */
export function createPdpVideoCollector({ enabled, origin, write, now = Date.now, limit = PDP_VIDEO_EVENT_LIMIT, bodyTimeoutMs = 3000 }: Readonly<{
  enabled: () => boolean;
  origin: () => string;
  write: (line: string) => void;
  now?: () => number;
  limit?: number;
  bodyTimeoutMs?: number;
}>) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) {
    throw new RangeError("Video telemetry bounds must be positive integers");
  }
  let windowStart: number | null = null;
  let admitted = 0;
  let suppressionReported = false;
  function emit(record: object) { try { write(`${JSON.stringify(record)}\n`); } catch { /* No shopper impact. */ } }

  return async function POST(request: Request): Promise<Response> {
    const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    try {
      if (!enabled() || request.method !== "POST") return empty();
      // Server configuration owns the origin; Host / forwarded headers are never authority.
      if (request.headers.get("origin") !== origin() || request.headers.get("content-type") !== "application/json") return empty();
      const length = request.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > PDP_VIDEO_EVENT_MAX_BYTES)) return empty();
      const instant = now();
      if (!Number.isSafeInteger(instant)) return empty();
      if (windowStart === null || instant < windowStart || instant - windowStart >= PDP_VIDEO_EVENT_WINDOW_MS) {
        windowStart = instant;
        admitted = 0;
        suppressionReported = false;
      }
      if (admitted >= limit) {
        if (!suppressionReported) { suppressionReported = true; emit({ name: "pdp_video.telemetry_suppressed" }); }
        return empty();
      }
      admitted++;
      const bytes = await readBoundedBody(request.body, PDP_VIDEO_EVENT_MAX_BYTES, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(bodyTimeoutMs)]),
      });
      if (bytes === null) return empty();
      const event = parsePdpVideoPlaybackEvent(JSON.parse(new TextDecoder().decode(bytes)));
      if (!event) return empty();
      if (event.kind === "attempt") emit({ name: "pdp_video.playback", attempts: 1, failures: 0 });
      else emit({ name: "pdp_video.playback", attempts: 0, failures: 1, reason: event.reason });
    } catch {
      // Invalid JSON, unavailable configuration, disconnected senders and timeouts are silent.
    }
    return empty();
  };
}
