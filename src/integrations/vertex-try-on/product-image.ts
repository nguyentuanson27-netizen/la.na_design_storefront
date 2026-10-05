import { sniffImageMime, readBoundedBody } from "../../commerce/try-on-image.ts";
import { parseTrustedProductImageUrl } from "../../commerce/product-media.ts";
import { TRY_ON_MAX_IMAGE_BYTES, type TryOnImageMimeType } from "../../commerce/try-on-policy.ts";
import { createTimeoutSignal } from "./timeout.ts";

/**
 * Fetches the garment reference image for one try-on (spec §5).
 *
 * The URL is never a client value: the caller passes the first trusted image the media authority
 * resolved for a server-re-resolved product. It is re-checked against that same authority here —
 * so this function cannot be coaxed into fetching anything the storefront would not render — and
 * every redirect hop must pass that authority too, so a trusted host cannot bounce the fetch to an
 * internal address. HTTPS only, bounded time, bounded bytes, JPEG/PNG signature required.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;

export type TrustedProductImageFetchResult =
  | Readonly<{ ok: true; image: Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }> }>
  | Readonly<{ ok: false; reason: "UNTRUSTED_URL" | "TOO_LARGE" | "FETCH_FAILED" }>;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FETCH_FAILED = { ok: false, reason: "FETCH_FAILED" } as const;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function fetchTrustedProductImage(
  trustedUrl: string,
  options: Readonly<{ fetch?: FetchLike; timeoutMs?: number }> = {},
): Promise<TrustedProductImageFetchResult> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  let current = parseTrustedProductImageUrl(trustedUrl);
  if (current === null) return { ok: false, reason: "UNTRUSTED_URL" };

  const timeout = createTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { signal } = timeout;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "image/jpeg,image/png" },
        signal,
      });

      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (location === null) return FETCH_FAILED;
        let next: string | null;
        try {
          next = parseTrustedProductImageUrl(new URL(location, current).toString());
        } catch {
          return FETCH_FAILED;
        }
        if (next === null) return FETCH_FAILED;
        current = next;
        continue;
      }

      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return FETCH_FAILED;
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > TRY_ON_MAX_IMAGE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "TOO_LARGE" };
      }

      const bytes = await readBoundedBody(response.body, TRY_ON_MAX_IMAGE_BYTES);
      if (bytes === null) return { ok: false, reason: "TOO_LARGE" };

      const mimeType = sniffImageMime(bytes);
      if (mimeType === null) return FETCH_FAILED;
      return { ok: true, image: { bytes, mimeType } };
    }
    // Redirect budget spent.
    return FETCH_FAILED;
  } catch {
    // Timeout, DNS or TLS failure, or a body error. No upstream detail is carried further.
    return FETCH_FAILED;
  } finally {
    timeout.clear();
  }
}
