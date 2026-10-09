import sharp from "sharp";

import {
  PDP_IMAGE_MAX_INPUT_PIXELS,
  PDP_IMAGE_MAX_OUTPUT_HEIGHT,
  PDP_IMAGE_SOURCE_MAX_BYTES,
  canonicalizePancakeProductImageSource,
  compressProductImageUnderLimit,
  type PdpImageFormat,
} from "../../commerce/product-image-delivery.ts";
import { readBoundedBody } from "../../commerce/try-on-image.ts";
import { createTimeoutSignal } from "../vertex-try-on/timeout.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;
const SUPPORTED_SOURCE_FORMATS = new Set(["jpeg", "png", "webp"]);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PancakeProductImageDeliveryResult =
  | Readonly<{
      ok: true;
      image: Readonly<{ bytes: Uint8Array; mimeType: "image/webp" | "image/avif" }>;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "UNTRUSTED_URL"
        | "TOO_LARGE"
        | "UNSUPPORTED_IMAGE"
        | "OUTPUT_TOO_LARGE"
        | "FETCH_FAILED"
        | "TRANSCODE_FAILED";
    }>;

const FETCH_FAILED = { ok: false, reason: "FETCH_FAILED" } as const;
const TRANSCODE_FAILED = { ok: false, reason: "TRANSCODE_FAILED" } as const;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function sourceDecodes(bytes: Uint8Array): Promise<boolean> {
  try {
    await sharp(bytes, { limitInputPixels: PDP_IMAGE_MAX_INPUT_PIXELS, sequentialRead: true })
      .resize({ width: 16, height: 16, fit: "inside" })
      .raw()
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}

export async function fetchAndCompressPancakeProductImage(
  trustedUrl: string,
  requestedWidth: number,
  options: Readonly<{ fetch?: FetchLike; timeoutMs?: number; format?: PdpImageFormat }> = {},
): Promise<PancakeProductImageDeliveryResult> {
  const format = options.format ?? "webp";
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let current = canonicalizePancakeProductImageSource(trustedUrl);
  if (current === null) return { ok: false, reason: "UNTRUSTED_URL" };

  const timeout = createTimeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "image/webp,image/png,image/jpeg" },
        signal: timeout.signal,
      });

      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (location === null) return FETCH_FAILED;
        let next: string | null;
        try {
          // Same policy as the first hop: a redirect must not smuggle in a query or fragment.
          next = canonicalizePancakeProductImageSource(new URL(location, current).toString());
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
      if (Number.isFinite(declaredLength) && declaredLength > PDP_IMAGE_SOURCE_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "TOO_LARGE" };
      }

      const bytes = await readBoundedBody(response.body, PDP_IMAGE_SOURCE_MAX_BYTES, {
        signal: timeout.signal,
      });
      if (bytes === null) return { ok: false, reason: "TOO_LARGE" };
      if (bytes.byteLength === 0) return FETCH_FAILED;

      let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
      try {
        metadata = await sharp(bytes, {
          limitInputPixels: PDP_IMAGE_MAX_INPUT_PIXELS,
          sequentialRead: true,
        }).metadata();
      } catch {
        return { ok: false, reason: "UNSUPPORTED_IMAGE" };
      }

      if (
        metadata.format === undefined ||
        !SUPPORTED_SOURCE_FORMATS.has(metadata.format) ||
        metadata.width === undefined ||
        metadata.height === undefined ||
        !Number.isSafeInteger(metadata.width) ||
        !Number.isSafeInteger(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0 ||
        metadata.width * metadata.height > PDP_IMAGE_MAX_INPUT_PIXELS
      ) {
        return { ok: false, reason: "UNSUPPORTED_IMAGE" };
      }

      let compressed: Awaited<ReturnType<typeof compressProductImageUnderLimit>>;
      try {
        compressed = await compressProductImageUnderLimit({
          requestedWidth,
          format,
          encode: async ({ width, quality }) => {
            const resized = sharp(bytes, {
              limitInputPixels: PDP_IMAGE_MAX_INPUT_PIXELS,
              sequentialRead: true,
            })
              .rotate()
              .resize({
                width,
                height: PDP_IMAGE_MAX_OUTPUT_HEIGHT,
                fit: "inside",
                withoutEnlargement: true,
              });
            // AVIF effort 3 rather than the default 4: noticeably faster to encode for a
            // negligible size difference, and the disk cache means each encode happens once.
            const output = await (format === "avif"
              ? resized.avif({ quality, effort: 3 })
              : resized.webp({ quality, effort: 4, smartSubsample: true })
            ).toBuffer();
            return new Uint8Array(output);
          },
        });
      } catch {
        // The header parsed but the encode failed. If the pixels cannot even be decoded the source
        // itself is corrupt (a client-data problem, 422); only a failure on a source that decodes
        // is ours, and it must not be reported as a bad gateway either.
        return (await sourceDecodes(bytes)) ? TRANSCODE_FAILED : { ok: false, reason: "UNSUPPORTED_IMAGE" };
      }

      if (compressed === null) return { ok: false, reason: "OUTPUT_TOO_LARGE" };
      return {
        ok: true,
        image: {
          bytes: compressed.bytes,
          mimeType: format === "avif" ? "image/avif" : "image/webp",
        },
      };
    }
    return FETCH_FAILED;
  } catch {
    return FETCH_FAILED;
  } finally {
    timeout.clear();
  }
}
