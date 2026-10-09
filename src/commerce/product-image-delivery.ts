import { parseTrustedProductImageUrl } from "./product-media.ts";

export const PDP_IMAGE_MAX_BYTES = 3_000_000;
export const PDP_IMAGE_SOURCE_MAX_BYTES = 32_000_000;
export const PDP_IMAGE_MAX_INPUT_PIXELS = 40_000_000;
export const PDP_IMAGE_MAX_OUTPUT_WIDTH = 2_400;
export const PDP_IMAGE_MAX_OUTPUT_HEIGHT = 3_200;

/**
 * Next.js' default responsive width vocabulary. Keeping the public image endpoint to this finite
 * set prevents an attacker from manufacturing an unbounded cache/transcode keyspace.
 */
export const PDP_IMAGE_ALLOWED_WIDTHS = Object.freeze([
  32,
  48,
  64,
  96,
  128,
  256,
  384,
  640,
  750,
  828,
  1080,
  1200,
  1920,
  2048,
  3840,
] as const);

const allowedWidths = new Set<number>(PDP_IMAGE_ALLOWED_WIDTHS);

export type ProductImageCompressionAttempt = Readonly<{
  width: number;
  quality: number;
}>;

export type ProductImageCompressionResult = Readonly<{
  bytes: Uint8Array;
  width: number;
  quality: number;
}>;

/**
 * The encoding the endpoint produces for one `src` + `w`, as a URL parameter. A response for the
 * current version is cached by browsers for a year (`immutable`), so anything that changes the bytes
 * for an unchanged source -- a quality step, a new format -- must bump this, or returning shoppers
 * keep the old encoding for that year.
 *
 * 2: WebP starts at quality 75 (was 82); AVIF is served to browsers that accept it.
 */
export const PDP_IMAGE_ENCODING_VERSION = "2";

export type PdpImageFormat = "webp" | "avif";

/**
 * The first step is the one nearly every photograph is delivered at; the rest exist only to bring a
 * pathological source under the byte ceiling. WebP 75 is the same quality `next/image` uses for every
 * other photograph on the site. AVIF's scale differs: 50 there is visually close to WebP 75 at
 * roughly a fifth fewer bytes.
 */
const COMPRESSION_STEPS: Readonly<Record<PdpImageFormat, readonly Readonly<{ scale: number; quality: number }>[]>> =
  Object.freeze({
    webp: Object.freeze([
      { scale: 1, quality: 75 },
      { scale: 1, quality: 68 },
      { scale: 0.85, quality: 60 },
      { scale: 0.7, quality: 55 },
      { scale: 0.55, quality: 50 },
      { scale: 0.4, quality: 45 },
      { scale: 0.3, quality: 40 },
      { scale: 0.2, quality: 35 },
    ]),
    avif: Object.freeze([
      { scale: 1, quality: 50 },
      { scale: 1, quality: 44 },
      { scale: 0.85, quality: 40 },
      { scale: 0.7, quality: 36 },
      { scale: 0.55, quality: 32 },
      { scale: 0.4, quality: 30 },
      { scale: 0.3, quality: 28 },
      { scale: 0.2, quality: 26 },
    ]),
  });

/**
 * AVIF only for a browser that says it decodes it; everything else gets WebP, which every browser
 * the storefront supports decodes. The response varies on `Accept` accordingly.
 */
export function negotiatePdpImageFormat(accept: string | null): PdpImageFormat {
  if (accept === null) return "webp";
  const acceptsAvif = accept.split(",").some((entry) => {
    const [type, ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "image/avif") return false;
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
  return acceptsAvif ? "avif" : "webp";
}

/**
 * Whether a reviewed Pancake source names its own content: its path carries a content hash, a run
 * of at least 32 hex digits (`cdn.pancake.vn/…/8bf4…269a.jpg`, or a `web-media` path holding
 * `…/e944…c25c-w:…`). Such a URL never serves different bytes, so its encodings can be cached for
 * good; any other spelling keeps the short cache it always had.
 */
export function isContentAddressedPancakeSource(src: string): boolean {
  try {
    return /[0-9a-f]{32,}/i.test(new URL(src).pathname);
  } catch {
    return false;
  }
}

export function parsePdpImageWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && allowedWidths.has(parsed) ? parsed : null;
}

/**
 * Rounds an arbitrary requested width up to the reviewed responsive set, capping at its largest
 * member. `next/image` is free to hand a custom loader widths outside the set (in development it
 * probes the loader with 400 to check that it honours width), and a loader that throws would take
 * the whole PDP render down with it.
 */
export function snapPdpImageWidth(width: number): number {
  const widths = PDP_IMAGE_ALLOWED_WIDTHS;
  if (!Number.isFinite(width)) return widths[widths.length - 1]!;
  return widths.find((allowed) => allowed >= width) ?? widths[widths.length - 1]!;
}

export function buildPdpImageDeliveryUrl({
  src,
  width,
}: Readonly<{ src: string; width: number }>): string {
  if (parsePdpImageWidth(String(width)) === null) {
    throw new RangeError("PDP image width is outside the reviewed responsive set");
  }
  const params = new URLSearchParams({ src, w: String(width), v: PDP_IMAGE_ENCODING_VERSION });
  return `/api/product-image?${params.toString()}`;
}

function clampAttemptWidth(requestedWidth: number, scale: number): number {
  const maximum = Math.min(requestedWidth, PDP_IMAGE_MAX_OUTPUT_WIDTH);
  return Math.max(1, Math.floor(maximum * scale));
}

/**
 * Applies a fixed, deterministic quality/size schedule and accepts only bytes strictly below the
 * delivery ceiling. The encoder owns image-format work; this function owns the hard byte contract.
 */
export async function compressProductImageUnderLimit({
  requestedWidth,
  encode,
  maxBytes = PDP_IMAGE_MAX_BYTES,
  format = "webp",
}: Readonly<{
  requestedWidth: number;
  encode: (attempt: ProductImageCompressionAttempt) => Promise<Uint8Array>;
  maxBytes?: number;
  format?: PdpImageFormat;
}>): Promise<ProductImageCompressionResult | null> {
  if (parsePdpImageWidth(String(requestedWidth)) === null) {
    throw new RangeError("PDP image width is outside the reviewed responsive set");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new RangeError("PDP image byte limit must be a positive integer above one byte");
  }

  for (const step of COMPRESSION_STEPS[format]) {
    const attempt = {
      width: clampAttemptWidth(requestedWidth, step.scale),
      quality: step.quality,
    } as const;
    const bytes = await encode(attempt);
    if (bytes.byteLength < maxBytes) {
      return { bytes, ...attempt };
    }
  }
  return null;
}

/**
 * The one spelling of a Pancake image source the delivery endpoint will work for.
 *
 * `parseTrustedProductImageUrl` constrains scheme, host and path but passes the query and fragment
 * through. Both would turn a single reviewed image into unbounded distinct public cache keys that
 * each trigger a fetch and several Sharp encodes (the fragment is never sent upstream, so it costs
 * the attacker nothing). Reviewed Pancake media URLs carry no query semantics, so any query or
 * fragment is refused rather than silently rewritten, and the accepted string must equal its own
 * canonical form.
 */
export function canonicalizePancakeProductImageSource(raw: unknown): string | null {
  const trusted = parseTrustedProductImageUrl(raw);
  if (trusted === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(trusted);
  } catch {
    return null;
  }
  // `search`/`hash` read as "" for a bare "?" or "#", while href keeps the delimiter.
  const canonical = parsed.toString();
  if (canonical.includes("?") || canonical.includes("#")) return null;
  if (typeof raw !== "string" || raw !== canonical) return null;
  return canonical;
}

/** Drops the query and fragment so a stored Pancake URL can be offered to the endpoint. */
export function stripPancakeProductImageSuffix(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/[?#]+$/, "");
  } catch {
    return raw;
  }
}
