/**
 * Keeps a late "load more" answer from landing on a grid it was not asked for.
 *
 * The infinite grid asks the server for the next page of one filtered list. If the shopper changes
 * size, sort or price while that request is out, the grid is reset for the new list and the old
 * answer, when it arrives, belongs to a list that is gone: applying it would append the previous
 * filter's products to the new one. A request therefore remembers the list it began for and is
 * dropped -- result or failure -- if the grid has moved to another list since.
 */

export type PageRequestGuard = Readonly<{
  /** Called whenever the grid starts showing a different list. */
  setList: (list: unknown) => void;
  begin: () => Readonly<{ isCurrent: () => boolean }>;
}>;

export function createPageRequestGuard(initialList: unknown): PageRequestGuard {
  let list = initialList;
  return {
    setList(next) {
      list = next;
    },
    begin() {
      const startedFor = list;
      return { isCurrent: () => list === startedFor };
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
