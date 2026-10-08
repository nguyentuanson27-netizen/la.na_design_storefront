import type { FlowTryOnRuntimeConfig } from "../../commerce/try-on-provider.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A hint, never worth waiting for: the worker answers at once and starts Chrome in the background. */
const WARM_TIMEOUT_MS = 3_000;

/**
 * Tells the Flow worker a shopper is about to try something on, so it can open its browser now rather
 * than when the photo arrives. Fire and forget: it never throws and its answer changes nothing. The
 * worker rate-limits warm-ups, releases an unused browser by itself and ignores the hint when it
 * keeps no warm browser, so a failure here costs only the cold start the request would have had.
 */
export function warmFlowWorker({
  config,
  fetch: injectedFetch,
}: Readonly<{ config: FlowTryOnRuntimeConfig; fetch?: FetchLike }>): void {
  const doFetch: FetchLike = injectedFetch ?? ((input, init) => fetch(input, init));
  try {
    void doFetch(`${config.workerUrl}/v1/warm`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      headers: { authorization: `Bearer ${config.workerToken}` },
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  } catch {
    // A hint must never break the request that triggered it.
  }
}
