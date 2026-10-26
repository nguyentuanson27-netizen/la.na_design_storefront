import { parsePdpVideoPlaybackEvent, type PdpVideoPlaybackEvent, type PdpVideoFailureReason } from "../../commerce/pdp-video-playback.ts";

/** Best effort, once: no cookies, referrer, arbitrary metadata, automatic retry or third party. */
export async function sendPdpVideoPlaybackEvent(event: PdpVideoPlaybackEvent, transport: typeof fetch = fetch): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const safe = parsePdpVideoPlaybackEvent(event);
    if (!safe) return;
    await transport("/api/product-video/events", {
      method: "POST", mode: "same-origin", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" }, body: JSON.stringify(safe),
      cache: "no-store", keepalive: true, signal: controller.signal,
    });
  } catch {
    // No console output: even browser network errors can include a page or source URL.
  } finally {
    clearTimeout(timeout);
  }
}

/** A data wait has one deadline; repeated stalled/waiting events must not extend it. */
export const PDP_VIDEO_PLAYBACK_TIMEOUT_MS = 15_000;

/** One explicit opening: no duplicate counts from resume, buffering, timeout or native errors. */
export function createPdpVideoPlaybackReporter(
  send: (event: PdpVideoPlaybackEvent) => void = (event) => { void sendPdpVideoPlaybackEvent(event); },
  onFailure: () => void = () => undefined,
) {
  let active = true;
  let attempted = false;
  let failed = false;
  let wantsPlayback = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clearDeadline() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function emit(event: PdpVideoPlaybackEvent) { try { send(event); } catch { /* Playback is independent. */ } }
  function recordAttempt() {
    if (attempted) return;
    attempted = true;
    emit({ kind: "attempt" });
  }
  function fail(reason: PdpVideoFailureReason): boolean {
    if (!active || failed) return false;
    recordAttempt(); // A failed load can precede the browser's onPlay callback.
    failed = true;
    wantsPlayback = false;
    clearDeadline();
    emit({ kind: "failure", reason });
    try { onFailure(); } catch { /* Failure reporting must not throw into the player. */ }
    return true;
  }
  function armDeadline() {
    if (!active || failed || timer !== null) return;
    timer = setTimeout(() => { fail("timeout"); }, PDP_VIDEO_PLAYBACK_TIMEOUT_MS);
  }
  function play() {
    if (!active || failed) return;
    wantsPlayback = true;
    recordAttempt();
    armDeadline();
  }
  function error(code: number | undefined): boolean {
    // MEDIA_ERR_ABORTED is expected on cancellation, not a playback failure.
    if (code === 1) return false;
    return fail(code === 2 ? "network" : code === 3 ? "decode" : code === 4 ? "unsupported" : "unknown");
  }
  return {
    play, error,
    playing() { clearDeadline(); },
    waiting() { if (attempted && wantsPlayback) armDeadline(); },
    pause() { wantsPlayback = false; clearDeadline(); },
    close() { active = false; wantsPlayback = false; clearDeadline(); },
  };
}
