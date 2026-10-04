import { readBoundedBody } from "./try-on-image.ts";
import { TRY_ON_MAX_IMAGE_BYTES, type TryOnFailureReason } from "./try-on-policy.ts";
import type { TryOnServiceInput, TryOnServiceResult } from "./try-on-service.ts";

/**
 * The HTTP edge of virtual try-on: `Request` in, `Response` out, no framework imports, so the whole
 * contract is testable without a server (spec §7, §9).
 *
 * It owns what only an HTTP boundary can own — same-origin enforcement, a bounded body, and the
 * status mapping — and hands everything else to the service. A route handler is used rather than a
 * Server Action because a Server Action's body limit is a global setting: raising it to fit a 7 MB
 * photo would raise it for every action on the site, and a bound this feature enforces itself is
 * the safer one.
 */

/** One 7 MB photo plus multipart framing and the few small text fields. */
export const TRY_ON_MAX_REQUEST_BYTES = TRY_ON_MAX_IMAGE_BYTES + 256 * 1024;

const STATUS_BY_REASON: Readonly<Record<TryOnFailureReason, number>> = {
  UNAVAILABLE: 503,
  INVALID_REQUEST: 400,
  LIKENESS_REQUIRED: 400,
  AGE_STATE_INVALID: 400,
  AGE_BLOCKED: 403,
  UNSUPPORTED_IMAGE: 415,
  IMAGE_TOO_LARGE: 413,
  NOT_ELIGIBLE: 404,
  PRODUCT_IMAGE_UNAVAILABLE: 502,
  RATE_LIMITED: 429,
  BUSY: 503,
  SAFETY_BLOCKED: 422,
  AUTH_FAILED: 503,
  TIMEOUT: 504,
  GENERATION_FAILED: 502,
};

export type TryOnEndpointDependencies = Readonly<{
  service: Readonly<{ handle: (input: TryOnServiceInput) => Promise<TryOnServiceResult> }>;
  /** Pseudonymous client key from trusted proxy headers, or `null` when none can be derived. */
  resolveClientKey: (headers: Headers) => string | null;
}>;

// Responses are per-shopper and may carry a generated image of them: never cacheable.
const NO_STORE = { "cache-control": "no-store" } as const;

function failure(reason: TryOnFailureReason): Response {
  return Response.json({ ok: false, reason }, { status: STATUS_BY_REASON[reason], headers: NO_STORE });
}

/**
 * Browsers always send `Origin` on a cross-site POST, and a page cannot forge it. A route handler
 * gets no Server Action origin check, so without this any site could submit a form here and spend
 * the shopper's quota (and ours). The host the browser actually reached is `Host`, or
 * `X-Forwarded-Host` when a proxy has rewritten it. A cross-site page cannot set either header:
 * a custom header would force a CORS preflight that this route never answers.
 */
function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return originHost === headers.get("host") || (forwarded !== undefined && originHost === forwarded);
}

export async function handleTryOnPost(
  request: Request,
  { service, resolveClientKey }: TryOnEndpointDependencies,
): Promise<Response> {
  if (!isSameOrigin(request.headers)) return Response.json({ ok: false }, { status: 403, headers: NO_STORE });

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(contentType)) return failure("INVALID_REQUEST");

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > TRY_ON_MAX_REQUEST_BYTES) {
    return failure("IMAGE_TOO_LARGE");
  }

  const clientKey = resolveClientKey(request.headers);
  if (clientKey === null) return failure("UNAVAILABLE");

  try {
    const result = await service.handle({
      clientKey,
      readForm: async () => {
        // A Content-Length can be absent or wrong, so the bound is enforced on the bytes read.
        const bytes = await readBoundedBody(request.body, TRY_ON_MAX_REQUEST_BYTES);
        if (bytes === null) return "TOO_LARGE";
        try {
          return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
        } catch {
          return "INVALID";
        }
      },
    });

    if (!result.ok) return failure(result.reason);
    return Response.json(
      {
        ok: true,
        mimeType: result.image.mimeType,
        imageBase64: Buffer.from(result.image.bytes).toString("base64"),
      },
      { headers: NO_STORE },
    );
  } catch {
    return failure("GENERATION_FAILED");
  }
}
