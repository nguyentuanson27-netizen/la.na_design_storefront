import {
  PDP_IMAGE_ENCODING_VERSION,
  canonicalizePancakeProductImageSource,
  isContentAddressedPancakeSource,
  negotiatePdpImageFormat,
  parsePdpImageWidth,
} from "../../commerce/product-image-delivery.ts";
import { readDefaultProductImageCache, type ProductImageCache } from "./product-image-cache.ts";
import { fetchAndCompressPancakeProductImage } from "./product-image-delivery.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type DeliveryResult = Awaited<ReturnType<typeof fetchAndCompressPancakeProductImage>>;

/**
 * Each admitted request may buffer up to 32 MB and run several Sharp encodes, so the number that
 * can run at once is capped for the whole process. A PDP legitimately asks for many distinct
 * images at the same moment (up to 12 gallery images, with lazy slides still laid out), so excess
 * requests wait in a bounded queue instead of being refused; only when that queue is also full is
 * a request shed with 503. Identical `src` + `w` requests share one run and take no extra slot.
 */
export const PRODUCT_IMAGE_MAX_CONCURRENT = 4;
export const PRODUCT_IMAGE_MAX_QUEUED = 64;
/** Requests that may be waiting on one `src` + `w` run besides its leader. */
export const PRODUCT_IMAGE_MAX_FOLLOWERS = 16;
/**
 * Every request that is waiting on a run, leader or follower, or whose response body is still being
 * written to its client. A slot is held until the body has been consumed, cancelled or the hold
 * timeout fires, so a wave of slow clients cannot be followed by another wave. The bytes of a run
 * are shared by all of its responses, so the cost per response is only its stream state.
 */
export const PRODUCT_IMAGE_MAX_PENDING = 128;
/**
 * A response that makes no progress (the client stops pulling) for this long is cut off. The timer
 * restarts on every chunk the client takes, so a slow but moving transfer is never truncated.
 */
export const PRODUCT_IMAGE_IDLE_MS = 15_000;
/**
 * Hard ceiling on one transfer, so a client trickling just fast enough to stay "active" cannot hold
 * a slot indefinitely. A body is under 3 MB, so 120 s still admits clients down to ~25 KB/s.
 */
export const PRODUCT_IMAGE_MAX_TRANSFER_MS = 120_000;
/**
 * A content-addressed source requested at the current encoding version never changes, so browsers
 * keep it for a year without revalidating. Anything else keeps the short cache the endpoint always
 * had: a request without `v` (a page rendered before the version existed) or a source whose URL does
 * not carry its content hash.
 */
export const PRODUCT_IMAGE_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const PRODUCT_IMAGE_SHORT_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const BODY_CHUNK_BYTES = 64 * 1024;

const inFlight = new Map<string, Readonly<{ run: Promise<DeliveryResult>; followers: { count: number } }>>();
let pendingRequests = 0;
const waiters: Array<() => void> = [];
let activeRuns = 0;

function releaseSlot(): void {
  const next = waiters.shift();
  if (next !== undefined) next();
  else activeRuns -= 1;
}

async function runLimited(
  limits: Readonly<{ maxConcurrent: number }>,
  work: () => Promise<DeliveryResult>,
): Promise<DeliveryResult> {
  if (activeRuns < limits.maxConcurrent) activeRuns += 1;
  else await new Promise<void>((resolve) => waiters.push(resolve));
  try {
    return await work();
  } finally {
    releaseSlot();
  }
}

/**
 * Streams shared bytes one chunk per consumer pull (no queueing ahead of the client), calling
 * `release` exactly once when the transfer finishes, is cancelled, goes idle for `idleMs` without
 * the client taking a chunk, or exceeds `maxTransferMs` in total.
 */
function streamHoldingSlot(
  bytes: Uint8Array,
  limits: Readonly<{ idleMs: number; maxTransferMs: number; chunkBytes: number }>,
  release: () => void,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let released = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => {
    if (released) return;
    released = true;
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    release();
  };
  const abort = (reason: string) => () => {
    try {
      controller?.error(new Error(reason));
    } catch {
      // already closed or cancelled
    }
    finish();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abort("response idle timeout"), limits.idleMs);
    idleTimer.unref?.();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        armIdle();
        totalTimer = setTimeout(abort("response transfer timeout"), limits.maxTransferMs);
        totalTimer.unref?.();
      },
      pull(c) {
        armIdle();
        c.enqueue(bytes.subarray(offset, offset + limits.chunkBytes));
        offset += limits.chunkBytes;
        if (offset >= bytes.byteLength) {
          c.close();
          finish();
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}

function busyResponse(): Response {
  return new Response(null, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "2",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The whole `GET /api/product-image` contract, kept out of the route file so it can be exercised
 * with an injected fetch (a route module may only export Next's reserved names).
 */
export async function handleProductImageRequest(
  request: Request,
  options: Readonly<{
    fetch?: FetchLike;
    /** `null` serves uncached; omitted, the production default (`readDefaultProductImageCache`). */
    cache?: ProductImageCache | null;
    maxConcurrent?: number;
    maxQueued?: number;
    maxFollowers?: number;
    maxPending?: number;
    idleMs?: number;
    maxTransferMs?: number;
    chunkBytes?: number;
  }> = {},
): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  const versions = searchParams.getAll("v");
  if (
    keys.some((key) => key !== "src" && key !== "w" && key !== "v") ||
    searchParams.getAll("src").length !== 1 ||
    searchParams.getAll("w").length !== 1 ||
    versions.length > 1 ||
    (versions.length === 1 && !/^[0-9]{1,4}$/.test(versions[0]!))
  ) {
    return errorResponse(400);
  }

  const width = parsePdpImageWidth(searchParams.get("w"));
  // Canonicalize before any work: equivalent spellings of one source (fragments, queries) must not
  // become distinct public cache keys that each cost a fetch and several encodes.
  const src = canonicalizePancakeProductImageSource(searchParams.get("src"));
  if (src === null || width === null) return errorResponse(400);

  // Every version is served the current encoding (`v` never multiplies the work); it decides only
  // how long a browser may keep the answer.
  const format = negotiatePdpImageFormat(request.headers.get("accept"));
  const mimeType = format === "avif" ? "image/avif" : "image/webp";
  const contentAddressed = isContentAddressedPancakeSource(src);
  const cacheControl =
    contentAddressed && versions[0] === PDP_IMAGE_ENCODING_VERSION
      ? PRODUCT_IMAGE_IMMUTABLE_CACHE_CONTROL
      : PRODUCT_IMAGE_SHORT_CACHE_CONTROL;
  // Only a source that cannot change may outlive the request on disk.
  const cache = contentAddressed
    ? options.cache === undefined
      ? readDefaultProductImageCache()
      : options.cache
    : null;

  const key = `${PDP_IMAGE_ENCODING_VERSION}|${format}|${width}|${src}`;
  const maxConcurrent = options.maxConcurrent ?? PRODUCT_IMAGE_MAX_CONCURRENT;
  if (pendingRequests >= (options.maxPending ?? PRODUCT_IMAGE_MAX_PENDING)) return busyResponse();

  // The slot is reserved synchronously, before any await: a cache read is I/O too, and requests
  // that all passed the check above while suspended in it must not each be admitted afterwards.
  // From here every path releases it exactly once -- shed, error, or the body being consumed.
  pendingRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pendingRequests -= 1;
  };

  const streamOptions = {
    idleMs: options.idleMs ?? PRODUCT_IMAGE_IDLE_MS,
    maxTransferMs: options.maxTransferMs ?? PRODUCT_IMAGE_MAX_TRANSFER_MS,
    chunkBytes: options.chunkBytes ?? BODY_CHUNK_BYTES,
  };

  // A hit costs neither a Pancake fetch nor an encode, so it never waits on the encoder's queue; it
  // holds its pending slot while its body is written, like every other response.
  let cached: Awaited<ReturnType<ProductImageCache["read"]>> = null;
  if (cache !== null) {
    try {
      cached = await cache.read(key, mimeType);
    } catch {
      cached = null; // the cache contract is best-effort; a throwing one is a miss
    }
  }
  if (cached !== null) return imageResponse(cached, streamOptions, release, cacheControl, "hit");

  let entry = inFlight.get(key);
  if (entry !== undefined) {
    if (entry.followers.count >= (options.maxFollowers ?? PRODUCT_IMAGE_MAX_FOLLOWERS)) {
      release();
      return busyResponse();
    }
    entry.followers.count += 1;
  } else {
    if (
      activeRuns >= maxConcurrent &&
      waiters.length >= (options.maxQueued ?? PRODUCT_IMAGE_MAX_QUEUED)
    ) {
      release();
      return busyResponse();
    }
    const run = runLimited({ maxConcurrent }, () =>
      fetchAndCompressPancakeProductImage(src, width, { fetch: options.fetch, format }),
    )
      .then((result) => {
        // Once per key, by the run's leader; the response does not wait on the disk.
        if (result.ok && cache !== null) void cache.write(key, result.image);
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    entry = { run, followers: { count: 0 } };
    inFlight.set(key, entry);
  }

  let result: DeliveryResult;
  try {
    result = await entry.run;
  } catch (error) {
    release();
    throw error;
  }
  if (!result.ok) {
    release();
    switch (result.reason) {
      case "UNTRUSTED_URL":
        return errorResponse(400);
      case "TOO_LARGE":
      case "UNSUPPORTED_IMAGE":
      case "OUTPUT_TOO_LARGE":
        return errorResponse(422);
      case "TRANSCODE_FAILED":
        return errorResponse(500);
      case "FETCH_FAILED":
        return errorResponse(502);
    }
  }

  return imageResponse(
    result.image,
    streamOptions,
    release,
    cacheControl,
    cache === null ? null : "miss",
  );
}

function imageResponse(
  image: Readonly<{ bytes: Uint8Array; mimeType: string }>,
  limits: Readonly<{ idleMs: number; maxTransferMs: number; chunkBytes: number }>,
  release: () => void,
  cacheControl: string,
  cacheStatus: "hit" | "miss" | null,
): Response {
  const headers: Record<string, string> = {
    "Cache-Control": cacheControl,
    "Content-Length": String(image.bytes.byteLength),
    "Content-Type": image.mimeType,
    // The format follows the request's `Accept`, so a shared cache must key on it too.
    Vary: "Accept",
    "X-Content-Type-Options": "nosniff",
  };
  if (cacheStatus !== null) headers["X-Product-Image-Cache"] = cacheStatus;
  return new Response(streamHoldingSlot(image.bytes, limits, release), { status: 200, headers });
}
