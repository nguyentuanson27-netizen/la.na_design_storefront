import sharp from "sharp";

import type { TryOnImageMimeType } from "../../commerce/try-on-policy.ts";

type Image = Readonly<{ bytes: Uint8Array; mimeType: TryOnImageMimeType }>;

/**
 * The picture the shopper receives (amendment 2026-11-09).
 *
 * The provider returns a 2K PNG, several MB, which then travels base64-encoded inside JSON and is
 * decoded on the phone's main thread. Nothing on a phone screen or in a chat app needs that: the
 * result is scaled to at most `TRY_ON_RESULT_MAX_EDGE` on its long side and re-encoded as JPEG,
 * which is a few hundred KB, shares and downloads everywhere, and drops any metadata the provider
 * attached. It runs in memory like everything else in try-on; nothing is written anywhere.
 *
 * Never a gate: if the image cannot be read, the work fails, or the result is not smaller, the
 * provider's original is returned unchanged.
 */
export const TRY_ON_RESULT_MAX_EDGE = 1600;
export const TRY_ON_RESULT_JPEG_QUALITY = 86;
/** A provider image is already bounded; this only stops a pathological one from costing the process. */
const MAX_INPUT_PIXELS = 48_000_000;

export async function compressTryOnResult(image: Image): Promise<Image> {
  try {
    const encoded = await sharp(image.bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
      .rotate()
      .resize({
        width: TRY_ON_RESULT_MAX_EDGE,
        height: TRY_ON_RESULT_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: TRY_ON_RESULT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    if (encoded.byteLength === 0 || encoded.byteLength >= image.bytes.byteLength) return image;
    return { bytes: new Uint8Array(encoded), mimeType: "image/jpeg" };
  } catch {
    return image;
  }
}
