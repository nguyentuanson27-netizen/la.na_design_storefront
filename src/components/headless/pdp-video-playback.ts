import { parsePdpVideoPlaybackEvent, type PdpVideoPlaybackEvent } from "../../commerce/pdp-video-playback.ts";

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

/** One explicit opening: pause/resume and source/player callbacks must not multiply counts. */
export function createPdpVideoPlaybackReporter(
  send: (event: PdpVideoPlaybackEvent) => void = (event) => { void sendPdpVideoPlaybackEvent(event); },
) {
  let active = true;
  let attempted = false;
  let failed = false;
  function emit(event: PdpVideoPlaybackEvent) { try { send(event); } catch { /* Playback is independent. */ } }
  function play() {
    if (!active || attempted) return;
    attempted = true;
    emit({ kind: "attempt" });
  }
  function error(code: number | undefined): boolean {
    // MEDIA_ERR_ABORTED is expected on cancellation, not a playback failure.
    if (!active || failed || code === 1) return false;
    play(); // A failed load can reach onError before the browser dispatches onPlay.
    failed = true;
    const reason = code === 2 ? "network" : code === 3 ? "decode" : code === 4 ? "unsupported" : "unknown";
    emit({ kind: "failure", reason });
    return true;
  }
  return { play, error, close() { active = false; } };
}
