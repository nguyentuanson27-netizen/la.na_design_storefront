/**
 * Keeps a late "load more" answer from landing on a grid it was not asked for.
 *
 * The infinite grid asks the server for the next page of one filtered list. If the shopper changes
 * size, sort or price while that request is out, the grid is reset for the new list and the old
 * answer, when it arrives, belongs to a list that is gone: applying it would append the previous
 * filter's products to the new one. A request therefore remembers which stretch of showing one list
 * it began in and is dropped -- result or failure -- if the grid has moved to another list since.
 *
 * That is a counter of changes, not the list itself. Comparing against the remembered list can only
 * say "same object now as then", so A -> B -> A with the very same array would look as if nothing
 * happened and revive a request that belongs to the earlier visit to A.
 */

export type PageRequestGuard = Readonly<{
  /** Called whenever the grid starts showing a different list. */
  setList: (list: unknown) => void;
  begin: () => Readonly<{ isCurrent: () => boolean }>;
}>;

export function createPageRequestGuard(initialList: unknown): PageRequestGuard {
  let list = initialList;
  let generation = 0;
  return {
    setList(next) {
      // Setting the list that is already showing is not a change and must not drop requests for it.
      if (next === list) return;
      list = next;
      generation += 1;
    },
    begin() {
      const startedIn = generation;
      return { isCurrent: () => generation === startedIn };
    },
  };
}

export type PageRequestOutcome<T> =
  | Readonly<{ stale: true }>
  | Readonly<{ stale: false; value: T }>;

/**
 * Runs `load` and reports whether its answer still belongs to the list on screen.
 *
 * A stale failure is swallowed: an error for a list the shopper has left is not theirs to see. A
 * current failure is rethrown for the caller's error state.
 */
export async function settleIfCurrent<T>(
  guard: PageRequestGuard,
  load: () => Promise<T>,
): Promise<PageRequestOutcome<T>> {
  const request = guard.begin();
  try {
    const value = await load();
    return request.isCurrent() ? { stale: false, value } : { stale: true };
  } catch (error) {
    if (!request.isCurrent()) return { stale: true };
    throw error;
  }
}
