/** Best-effort per-process admission for optional upsell quote reads (POST banner and GET browse). */
export const MAX_CONCURRENT_UPSELL_READS = 2;

/**
 * Each successful acquire returns a once-only release function. No wait queue: optional
 * recommendations fail closed rather than competing with the COD checkout pipeline.
 */
export function createUpsellReadGate(maxConcurrent = MAX_CONCURRENT_UPSELL_READS) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new TypeError("Upsell concurrency limit must be a positive safe integer");
  }
  let active = 0;
  return {
    tryAcquire(): (() => void) | null {
      if (active >= maxConcurrent) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}

// Next may compile page and route-handler entrypoints into separate chunks. Share the
// admission gate across those chunks in one Node process, including dev hot reloads.
// Cross-process rate limiting is enforced separately by consumeUpsellClient in the DB.
type ProcessGate = typeof globalThis & { __laUpsellReadGateV1?: ReturnType<typeof createUpsellReadGate> };
const processGate = globalThis as ProcessGate;
export const upsellReadGate = processGate.__laUpsellReadGateV1 ??= createUpsellReadGate();
