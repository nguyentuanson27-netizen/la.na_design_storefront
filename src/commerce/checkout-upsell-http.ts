/** The read-only checkout Upsell endpoint accepts only a bounded, signed render proof. */
import { MAX_BENEFIT_QUOTE_PROOF_BYTES } from "./checkout-quote-proof.ts";

export const MAX_UPSELL_REQUEST_BYTES = 64 * 1024;
export const UPSELL_BODY_READ_TIMEOUT_MS = 1_000;

export function isSameOriginUpsellRequest(request: Request, trustedOrigin: string): boolean {
  if (request.method !== "POST") return false;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    return new URL(origin).origin === new URL(trustedOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Read-only browse still exposes personalized cart offer metadata. SameSite=Lax
 * sends cookies on top-level cross-site GETs, so reject those requests *before*
 * consuming any DB quota. Direct address-bar visits use Sec-Fetch-Site: none.
 * When fetch metadata is absent, require a same-origin Origin or Referer.
 */
export function isTrustedUpsellBrowseRequest(
  headers: Pick<Headers, "get">,
  trustedOrigin: string,
): boolean {
  if (headers.get("next-router-prefetch") !== null ||
      headers.get("purpose")?.toLowerCase().includes("prefetch") ||
      headers.get("sec-purpose")?.toLowerCase().includes("prefetch")) return false;
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = headers.get("origin");
  const referer = headers.get("referer");
  try {
    const expected = new URL(trustedOrigin).origin;
    if (origin !== null && new URL(origin).origin !== expected) return false;
    if (referer !== null && new URL(referer).origin !== expected) return false;
  } catch {
    return false;
  }
  return fetchSite !== null || origin !== null || referer !== null;
}

/** Stream with a hard byte cap: Content-Length is not guaranteed (e.g. chunked HTTP). */
export async function readCheckoutUpsellProof(request: Request): Promise<string | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return null;
  const claimedLength = request.headers.get("content-length");
  if (claimedLength !== null && (!/^\d+$/.test(claimedLength) || Number(claimedLength) > MAX_UPSELL_REQUEST_BYTES)) return null;

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  let deadlineId: ReturnType<typeof setTimeout> | undefined;
  // One absolute deadline for the entire body, not a resettable per-chunk idle timeout.
  const deadline = new Promise<null>((resolve) => {
    deadlineId = setTimeout(() => {
      expired = true;
      resolve(null);
      // Cancellation can itself stall on an uncooperative upstream stream. Do not await it:
      // the caller must be able to release its scarce recommendation slot regardless.
      void reader.cancel("Upsell request body deadline exceeded").catch(() => {});
    }, UPSELL_BODY_READ_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      // cancel() can settle a pending read with done=true, so check the deadline first.
      if (expired || result === null) return null;
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_UPSELL_REQUEST_BYTES) {
        void reader.cancel("Upsell request body exceeds limit").catch(() => {});
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    if (deadlineId !== undefined) clearTimeout(deadlineId);
    reader.releaseLock();
  }

  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.quoteProof !== "string" ||
      record.quoteProof.length === 0 || record.quoteProof.length > MAX_BENEFIT_QUOTE_PROOF_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(record.quoteProof)) return null;
    return record.quoteProof;
  } catch {
    return null;
  }
}
