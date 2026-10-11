import { sniffImageMime, readBoundedBody } from "../../commerce/try-on-image.ts";
import { parseTrustedProductImageUrl } from "../../commerce/product-media.ts";
import { TRY_ON_MAX_IMAGE_BYTES, type TryOnImageMimeType } from "../../commerce/try-on-policy.ts";
import {
  PDP_IMAGE_ENCODING_VERSION,
  canonicalizePancakeProductImageSource,
  isContentAddressedPancakeSource,
} from "../../commerce/product-image-delivery.ts";
import { readDefaultProductImageCache, type ProductImageCache } from "../pancake/product-image-cache.ts";
import { fetchAndCompressPancakeProductImage } from "../pancake/product-image-delivery.ts";
import { createTimeoutSignal } from "./timeout.ts";

/**
 * Fetches the garment reference image for one try-on (spec §5).
 *
 * The URL is never a client value: the caller passes the first trusted image the media authority
 * resolved for a server-re-resolved product. It is re-checked against that same authority here —
 * so this function cannot be coaxed into fetching anything the storefront would not render — and
 * every redirect hop must pass that authority too, so a trusted host cannot bounce the fetch to an
 * internal address. HTTPS only, bounded time, bounded bytes, JPEG/PNG/WebP signature required.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;
/**
 * The PDP width whose cached WebP doubles as the garment reference. Only the WebP entry: the AVIF one
 * is unusable here, since gflow refuses any upload that is not PNG, JPEG, WebP or GIF by its magic
 * bytes (gflow-cli 0.82.1 `validate_image_file`) and Gemini takes no AVIF input either.
 */
const TRY_ON_GARMENT_WIDTH = 1080;

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
        headers: { accept: "image/jpeg,image/png,image/webp" },
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

/**
 * Resolves the garment reference image for virtual try-on:
 * 1. Checks if a web-optimized 1080px WebP exists in the product image cache.
 * 2. Directly fetches trusted images up to 7 MB (JPEG, PNG, or WebP).
 * 3. For oversized Pancake camera uploads (> 7 MB), compresses to 1080px WebP and caches the result.
 */
export async function fetchTryOnGarmentImage(
  url: string,
  options: Readonly<{ fetch?: FetchLike; cache?: ProductImageCache | null; timeoutMs?: number }> = {},
): Promise<TrustedProductImageFetchResult> {
  const canonical = canonicalizePancakeProductImageSource(url);
  // Same rule as the PDP endpoint: only a source that cannot change may be read from or written to
  // disk, and under the very key the endpoint uses, so either side can warm the entry for the other.
  const cache =
    canonical !== null && isContentAddressedPancakeSource(canonical)
      ? options.cache !== undefined
        ? options.cache
        : readDefaultProductImageCache()
      : null;
  const cacheKey = `${PDP_IMAGE_ENCODING_VERSION}|webp|${TRY_ON_GARMENT_WIDTH}|${canonical}`;

  if (cache !== null) {
    try {
      const cached = await cache.read(cacheKey, "image/webp");
      if (cached !== null) {
        return { ok: true, image: { bytes: cached.bytes, mimeType: "image/webp" } };
      }
    } catch {
      // Best-effort cache lookup; proceed on miss or error
    }
  }

  const direct = await fetchTrustedProductImage(url, options);
  if (direct.ok) return direct;

  if (direct.reason === "TOO_LARGE" && canonical !== null) {
    try {
      const compressed = await fetchAndCompressPancakeProductImage(canonical, TRY_ON_GARMENT_WIDTH, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        format: "webp",
      });
      if (compressed.ok && compressed.image.mimeType === "image/webp") {
        if (cache !== null) {
          try {
            await cache.write(cacheKey, compressed.image);
          } catch {
            // Best-effort cache write
          }
        }
        return { ok: true, image: { bytes: compressed.image.bytes, mimeType: "image/webp" } };
      }
    } catch {
      // Fall through to returning direct failure
    }
  }

  return direct;
}
