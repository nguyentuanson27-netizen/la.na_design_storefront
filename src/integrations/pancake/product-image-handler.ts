import {
  canonicalizePancakeProductImageSource,
  parsePdpImageWidth,
} from "../../commerce/product-image-delivery.ts";
import { fetchAndCompressPancakeProductImage } from "./product-image-delivery.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type DeliveryResult = Awaited<ReturnType<typeof fetchAndCompressPancakeProductImage>>;

/**
 * Each admitted request may buffer up to 32 MB and run several Sharp encodes, so the number that
 * can be in flight at once is capped for the whole process. Identical `src` + `w` requests share
 * one run and do not consume a slot, which also absorbs a burst on a single popular image.
 */
export const PRODUCT_IMAGE_MAX_CONCURRENT = 4;

const inFlight = new Map<string, Promise<DeliveryResult>>();
let activeRuns = 0;

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
  options: Readonly<{ fetch?: FetchLike; maxConcurrent?: number }> = {},
): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => key !== "src" && key !== "w") ||
    searchParams.getAll("src").length !== 1 ||
    searchParams.getAll("w").length !== 1
  ) {
    return errorResponse(400);
  }

  const width = parsePdpImageWidth(searchParams.get("w"));
  // Canonicalize before any work: equivalent spellings of one source (fragments, queries) must not
  // become distinct public cache keys that each cost a fetch and several encodes.
  const src = canonicalizePancakeProductImageSource(searchParams.get("src"));
  if (src === null || width === null) return errorResponse(400);

  const key = `${width}|${src}`;
  let run = inFlight.get(key);
  if (run === undefined) {
    if (activeRuns >= (options.maxConcurrent ?? PRODUCT_IMAGE_MAX_CONCURRENT)) return busyResponse();
    activeRuns += 1;
    run = fetchAndCompressPancakeProductImage(src, width, { fetch: options.fetch }).finally(() => {
      activeRuns -= 1;
      inFlight.delete(key);
    });
    inFlight.set(key, run);
  }
  const result = await run;
  if (!result.ok) {
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

  const body = new ArrayBuffer(result.image.bytes.byteLength);
  new Uint8Array(body).set(result.image.bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Length": String(result.image.bytes.byteLength),
      "Content-Type": result.image.mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
