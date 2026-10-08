import { parseTryOnQuota, type TryOnQuotaView } from "./try-on-model.ts";

/**
 * Asking the server what is left today, with the guarantee a display needs: what is shown is the
 * answer to the *latest* question, and anything else is shown as unknown.
 *
 * Pure (the request is injected), so the ordering rules are tested without a browser. A newer
 * `load()` or a `cancel()` supersedes every earlier one, so a slow answer that arrives after a fresher
 * one can never overwrite it, and an answer that lands after the dialog was closed is dropped.
 */

export type TryOnQuotaOutcome =
  /** The latest request answered with a well-formed quota. */
  | Readonly<{ kind: "known"; quota: TryOnQuotaView }>
  /** The latest request failed or answered with something unusable: show nothing, claim nothing. */
  | Readonly<{ kind: "unknown" }>
  /** A newer request or a cancel replaced this one; the caller must ignore it. */
  | Readonly<{ kind: "superseded" }>;

export function createTryOnQuotaLoader(request: (signal: AbortSignal) => Promise<unknown>) {
  let latest = 0;
  let inFlight: AbortController | null = null;

  /** Invalidates whatever is running, so its result can no longer be applied. */
  function cancel() {
    latest += 1;
    inFlight?.abort();
    inFlight = null;
  }

  async function load(): Promise<TryOnQuotaOutcome> {
    cancel();
    const id = latest;
    const controller = new AbortController();
    inFlight = controller;

    let payload: unknown = null;
    try {
      payload = await request(controller.signal);
    } catch {
      // Offline, blocked or aborted: decided below by whether this is still the latest request.
    }
    if (id !== latest) return { kind: "superseded" };
    inFlight = null;
    const quota = parseTryOnQuota(payload);
    return quota === null ? { kind: "unknown" } : { kind: "known", quota };
  }

  return { load, cancel };
}
