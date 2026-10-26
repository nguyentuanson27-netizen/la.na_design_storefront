import { parseTrustedPancakeSourceVideoUrl, parseTrustedProductVideoUrl } from "../../commerce/product-media.ts";

export type PancakeVideoReason = "partial_coverage" | "multi_url" | "mov_only" | "missing" | "malformed" | "untrusted";
export type PancakeVariationVideo =
  | Readonly<{ kind: "EMPTY" }>
  | Readonly<{ kind: "URLS"; urls: readonly string[] }>
  | Readonly<{ kind: "UNKNOWN"; reason: PancakeVideoReason }>;
export type PancakeProductVideo = Readonly<{
  state: "READY" | "NONE" | "CONFLICT" | "UNKNOWN" | "UNSUPPORTED";
  /** undefined preserves the previous URL; null conclusively clears it. */
  url?: string | null;
  reasons: readonly PancakeVideoReason[];
}>;

/** Optional evidence cannot invalidate the surrounding commerce snapshot. */
export function parsePancakeVariationVideo(record: Record<string, unknown>): PancakeVariationVideo {
  if (!Object.hasOwn(record, "videos")) return { kind: "UNKNOWN", reason: "missing" };
  const raw = record.videos;
  if (raw === null) return { kind: "EMPTY" };
  if (!Array.isArray(raw) || raw.length > 8) return { kind: "UNKNOWN", reason: "malformed" };
  if (raw.length === 0) return { kind: "EMPTY" };
  const urls = new Set<string>();
  for (const member of raw) {
    if (typeof member !== "string" || member.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(member)) {
      return { kind: "UNKNOWN", reason: "malformed" };
    }
    const url = parseTrustedPancakeSourceVideoUrl(member);
    if (!url) return { kind: "UNKNOWN", reason: "untrusted" };
    urls.add(url);
  }
  return { kind: "URLS", urls: [...urls].sort() };
}

/** Call only with every variation from a complete validated snapshot, before visibility filtering. */
export function resolvePancakeProductVideo(observations: readonly PancakeVariationVideo[]): PancakeProductVideo {
  const urls = new Set<string>();
  const unknown = new Set<PancakeVideoReason>();
  let hasEmpty = false;
  for (const observation of observations) {
    if (observation.kind === "EMPTY") hasEmpty = true;
    else if (observation.kind === "UNKNOWN") unknown.add(observation.reason);
    else for (const url of observation.urls) urls.add(url);
  }
  if (urls.size > 1) return { state: "CONFLICT", url: null, reasons: ["multi_url"] };
  if (urls.size && hasEmpty) return { state: "CONFLICT", url: null, reasons: ["partial_coverage"] };
  if (unknown.size || observations.length === 0) {
    return { state: "UNKNOWN", reasons: unknown.size ? [...unknown].sort() : ["missing"] };
  }
  if (hasEmpty) return { state: "NONE", url: null, reasons: [] };
  const url = [...urls][0];
  if (url && parseTrustedProductVideoUrl(url)) return { state: "READY", url, reasons: [] };
  return { state: "UNSUPPORTED", url: null, reasons: ["mov_only"] };
}

export function countPancakeProductVideos(videos: Iterable<PancakeProductVideo>) {
  const states = { READY: 0, NONE: 0, CONFLICT: 0, UNKNOWN: 0, UNSUPPORTED: 0 };
  const reasons = { partial_coverage: 0, multi_url: 0, mov_only: 0, missing: 0, malformed: 0, untrusted: 0 };
  for (const video of videos) {
    states[video.state]++;
    for (const reason of video.reasons) reasons[reason]++;
  }
  return { states, reasons };
}
export type PancakeVideoSyncCounts = ReturnType<typeof countPancakeProductVideos>;

/** Fixed numeric counters only, suitable for one-shot and scheduled sync logs. */
export function formatPancakeVideoSyncCounts(counts: PancakeVideoSyncCounts | undefined): string {
  if (!counts) return "";
  return `, video states ${JSON.stringify(counts.states)}, video reasons ${JSON.stringify(counts.reasons)}`;
}
