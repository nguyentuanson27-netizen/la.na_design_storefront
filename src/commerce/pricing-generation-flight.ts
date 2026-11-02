/**
 * Lets concurrent requests share one read of the promotion pricing generation.
 *
 * A listing's cache key carries the durable promotion pricing revision and the next campaign boundary
 * (see `readPricingGeneration`), so every request has to read them before it can look its listing up.
 * Without sharing, a burst of N requests for one URL costs N generation reads even when the heavy
 * listing read behind them is coalesced. Sharing adds no lifetime: a request joins only a read that is
 * still in flight, so what it learns is at most as old as that read's duration, the same bound a
 * request that had issued the read itself has.
 *
 * A joiner whose instant is at or past the boundary the shared read found does not use it: the
 * boundary is the first instant the answer can change, so that request reads for itself.
 */
export type PricingGeneration = Readonly<{ key: string; nextBoundaryAt: Date | null }>;

export function createPricingGenerationReader(
  read: (now: Date) => Promise<PricingGeneration>,
): (now: Date) => Promise<PricingGeneration> {
  let flight: Readonly<{ promise: Promise<PricingGeneration> }> | null = null;

  return async function readGeneration(now: Date): Promise<PricingGeneration> {
    const joined = flight;
    if (joined) {
      const shared = await joined.promise;
      if (shared.nextBoundaryAt === null || now.getTime() < shared.nextBoundaryAt.getTime()) {
        return shared;
      }
    }

    const own = Object.freeze({ promise: read(now) });
    flight = own;
    const release = () => {
      if (flight === own) flight = null;
    };
    own.promise.then(release, release);
    return own.promise;
  };
}
