/**
 * An abort signal that fires after `ms`, with a timer that is cleared when the request settles.
 *
 * `AbortSignal.timeout()` would do the abort, but its timer is unref'd and cannot be cleared, so an
 * early success would leave it pending. This keeps every outbound call's lifetime explicit.
 */
export function createTimeoutSignal(ms: number): Readonly<{ signal: AbortSignal; clear: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
