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
  16,
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

const COMPRESSION_STEPS = Object.freeze([
  { scale: 1, quality: 82 },
  { scale: 1, quality: 68 },
  { scale: 0.85, quality: 60 },
  { scale: 0.7, quality: 55 },
  { scale: 0.55, quality: 50 },
  { scale: 0.4, quality: 45 },
  { scale: 0.3, quality: 40 },
  { scale: 0.2, quality: 35 },
] as const);

export function parsePdpImageWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && allowedWidths.has(parsed) ? parsed : null;
}

export function buildPdpImageDeliveryUrl({
  src,
  width,
}: Readonly<{ src: string; width: number }>): string {
  if (parsePdpImageWidth(String(width)) === null) {
    throw new RangeError("PDP image width is outside the reviewed responsive set");
  }
  const params = new URLSearchParams({ src, w: String(width) });
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
}: Readonly<{
  requestedWidth: number;
  encode: (attempt: ProductImageCompressionAttempt) => Promise<Uint8Array>;
  maxBytes?: number;
}>): Promise<ProductImageCompressionResult | null> {
  if (parsePdpImageWidth(String(requestedWidth)) === null) {
    throw new RangeError("PDP image width is outside the reviewed responsive set");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
    throw new RangeError("PDP image byte limit must be a positive integer above one byte");
  }

  for (const step of COMPRESSION_STEPS) {
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
