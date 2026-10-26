import { PDP_VIDEO_FAILURE_REASONS, type PdpVideoFailureReason } from "../commerce/pdp-video-playback.ts";

export function createPdpVideoPlaybackSummary() {
  let attempts = 0;
  let failures = 0;
  let suppressedWindows = 0;
  const errors: Record<PdpVideoFailureReason, number> = { network: 0, decode: 0, unsupported: 0, timeout: 0, unknown: 0 };
  return {
    add(line: string) {
      if (line.length > 4096) return;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== "object" || Array.isArray(record)) return;
        const keys = Object.keys(record).sort().join(",");
        if (keys === "name" && record.name === "pdp_video.telemetry_suppressed") suppressedWindows++;
        if (record.name !== "pdp_video.playback") return;
        if (keys === "attempts,failures,name" && record.attempts === 1 && record.failures === 0) attempts++;
        if (keys === "attempts,failures,name,reason" && record.attempts === 0 && record.failures === 1 && PDP_VIDEO_FAILURE_REASONS.includes(record.reason)) {
          failures++;
          errors[record.reason as PdpVideoFailureReason]++;
        }
      } catch { /* Ignore unrelated/malformed log lines without printing their contents. */ }
    },
    result() {
      return {
        attempts, failures, failureRate: attempts > 0 ? failures / attempts : null, errors: { ...errors }, suppressedWindows,
        status: suppressedWindows > 0 || failures > attempts ? "INCOMPLETE" : attempts > 0 ? "OBSERVED" : "NO_DATA",
      };
    },
  };
}

export function summarizePdpVideoPlaybackLogs(lines: Iterable<string>) {
  const summary = createPdpVideoPlaybackSummary();
  for (const line of lines) summary.add(line);
  return summary.result();
}
