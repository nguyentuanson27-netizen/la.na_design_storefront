/** Privacy contract shared by the browser and its first-party collector. No media/product identity. */
export const PDP_VIDEO_FAILURE_REASONS = ["network", "decode", "unsupported", "unknown"] as const;
export type PdpVideoFailureReason = typeof PDP_VIDEO_FAILURE_REASONS[number];
export type PdpVideoPlaybackEvent =
  | Readonly<{ kind: "attempt" }>
  | Readonly<{ kind: "failure"; reason: PdpVideoFailureReason }>;

export function parsePdpVideoPlaybackEvent(raw: unknown): PdpVideoPlaybackEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (keys === "kind" && input.kind === "attempt") return { kind: "attempt" };
  if (keys === "kind,reason" && input.kind === "failure" && PDP_VIDEO_FAILURE_REASONS.some((reason) => reason === input.reason)) {
    return { kind: "failure", reason: input.reason as PdpVideoFailureReason };
  }
  return null;
}
