/**
 * Lets a burst of requests share reads of the promotion pricing generation.
 *
 * A listing's cache key carries the durable promotion pricing revision and the next campaign boundary
 * (see `readPricingGeneration`), so every request has to read them before it can look its listing up.
 * Without sharing, N requests for one URL cost N generation reads even when the heavy listing read
 * behind them is coalesced.
 *
 * A request must see every promotion publish committed before it arrived. A read that was already
 * running when it arrived may have read the revision before such a commit, so a request never joins
 * a running read. It joins the one read that starts after the running one ends: every request that
 * arrived meanwhile waits for that same read, which began after all of them arrived. A burst therefore
 * costs two reads however large it is, and the shared answer is never older than the request's own
 * arrival. Nothing is held past the read: the next request that finds no read running starts its own.
 */
export type PricingGeneration = Readonly<{ key: string; nextBoundaryAt: Date | null }>;

type Waiting = {
  nowMs: number;
  promise: Promise<PricingGeneration>;
  resolve: (value: PricingGeneration) => void;
  reject: (error: unknown) => void;
};

export function createPricingGenerationReader(
  read: (now: Date) => Promise<PricingGeneration>,
): (now: Date) => Promise<PricingGeneration> {
  let running: Promise<PricingGeneration> | null = null;
  let waiting: Waiting | null = null;

  function start(now: Date): Promise<PricingGeneration> {
    const promise = (async () => read(now))();
    running = promise;
    const finish = () => {
      if (running === promise) running = null;
      const batch = waiting;
      if (batch === null) return;
      waiting = null;
      // Read at the latest instant of the batch: its boundary is then ahead of every waiter's own.
      start(new Date(batch.nowMs)).then(batch.resolve, batch.reject);
    };
    promise.then(finish, finish);
    return promise;
  }

  return function readGeneration(now: Date): Promise<PricingGeneration> {
    if (running === null) return start(now);
    if (waiting === null) {
      let resolve!: Waiting["resolve"];
      let reject!: Waiting["reject"];
      const promise = new Promise<PricingGeneration>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      waiting = { nowMs: now.getTime(), promise, resolve, reject };
    } else {
      waiting.nowMs = Math.max(waiting.nowMs, now.getTime());
    }
    return waiting.promise;
  };
}
