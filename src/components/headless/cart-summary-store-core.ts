import { EMPTY_CART_SUMMARY, type CartSummary } from "../../routes/cart-model.ts";

/**
 * The cart-summary external store, free of React and of the server action it reads through, so the
 * ordering rules can be held to tests with a deferred read.
 *
 * Two kinds of writer race here: a server read that was already in flight, and a local publish from
 * the drawer, which has just rendered a fresher cart than that read can know about. `version`
 * advances on every publish, and a read only lands if nothing was published since it began; a newer
 * local fact therefore always beats an older server answer. `latestRead` orders reads against each
 * other the same way.
 */
export function createCartSummaryStore(readSummary: () => Promise<CartSummary>) {
  let snapshot: CartSummary = EMPTY_CART_SUMMARY;
  let version = 0;
  let latestRead = 0;
  const listeners = new Set<() => void>();

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot() {
    return snapshot;
  }

  function publish(next: CartSummary) {
    // Advances even when the value is unchanged: the publish is still newer information than any
    // read that began before it.
    version += 1;
    if (next.count === snapshot.count && next.totalText === snapshot.totalText) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /** Re-reads the cart and publishes the result unless something newer has landed meanwhile. */
  async function refresh() {
    const read = ++latestRead;
    const versionAtStart = version;
    try {
      const next = await readSummary();
      if (read !== latestRead || version !== versionAtStart) return;
      publish(next);
    } catch {
      // The badge is a courtesy; the cart route and drawer report their own load failures.
    }
  }

  return { subscribe, getSnapshot, publish, refresh };
}
