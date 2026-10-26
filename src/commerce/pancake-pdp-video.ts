import { parseTrustedProductImageUrl, parseTrustedProductVideoUrl } from "./product-media.ts";

export type PancakePdpVideo = Readonly<{ src: string; poster: string }>;

/** Server display boundary: retained UNKNOWN URLs must not enter HTML or client props. */
export function resolvePancakePdpVideo({ enabled, state, url, poster }: Readonly<{
  enabled: string | undefined;
  state: string;
  url: unknown;
  poster: unknown;
}>): PancakePdpVideo | null {
  if (enabled !== "true" || state !== "READY") return null;
  const src = parseTrustedProductVideoUrl(url);
  const photo = parseTrustedProductImageUrl(poster);
  return src && photo ? { src, poster: photo } : null;
}
