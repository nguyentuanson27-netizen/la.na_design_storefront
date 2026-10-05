import type { TryOnImageMimeType } from "./try-on-policy.ts";

/**
 * Image primitives shared by the shopper upload, the trusted product-image fetch and the Vertex
 * response. All are bounded and in-memory: nothing here touches a filesystem or a store.
 */

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** The MIME type the bytes actually are, from the file signature. Never from a declared header. */
export function sniffImageMime(bytes: Uint8Array): TryOnImageMimeType | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  return null;
}

/**
 * Reads a body stream, giving up as soon as it exceeds `maxBytes`.
 *
 * Returns `null` on overflow so a caller cannot forget the bound: there is no way to obtain the
 * bytes of an oversized body from this function. The stream is cancelled rather than drained.
 *
 * `signal` bounds time as well as size: when it aborts the stream is cancelled and the signal's
 * reason is thrown, never the partial bytes read so far. Without it a client that stops sending
 * would hold the read open indefinitely.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(new ArrayBuffer(0));

  const { signal } = options;
  const reader = body.getReader();
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
