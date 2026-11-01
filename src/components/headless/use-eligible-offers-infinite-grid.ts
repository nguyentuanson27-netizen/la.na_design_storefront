"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadEligibleOffersNextPageAction, refreshEligibleOffersCardsAction } from "@/commerce/eligible-offers-actions";
import type { ProductCardModel } from "./build-product-card-model";
import { createPageRequestGuard, settleIfCurrent } from "./plp-page-request-guard";

export type EligibleOffersCardItem = Readonly<{
  id: string;
  model: ProductCardModel;
}>;

export type UseEligibleOffersInfiniteGridOptions = {
  initialCards: readonly EligibleOffersCardItem[];
  totalCount: number;
  totalPages: number;
  initialPage: number;
  campaignId: string;
  /**
   * The products ahead of the first server-rendered card, for a listing opened at `?page=N`. Continuing excludes them
   * by id; `null` (too many to carry) means this listing does not continue in place and the page links onward.
   */
  precedingProductIds?: readonly string[] | null;
};

/**
 * Cards per refresh call (the server's cap), and the calls one revalidation makes, so a very long list stays cheap. A
 * revalidation redraws up to 720 loaded cards; a longer list is walked round-robin, so every card is redrawn within
 * ceil(n / 720) revalidations (a minute apart at most) and none stays stale for good.
 */
const REFRESH_CHUNK = 240;
const REFRESH_MAX_CALLS = 3;

/**
 * Pages the `/offers/eligible` listing in place. The first page is server-rendered; later pages come from the
 * `loadEligibleOffersNextPageAction` server action, which applies the same rate limits as the page itself.
 */
export function useEligibleOffersInfiniteGrid({
  initialCards,
  totalCount,
  totalPages,
  initialPage,
  campaignId,
  precedingProductIds = [],
}: UseEligibleOffersInfiniteGridOptions) {
  const continues = precedingProductIds !== null;
  const [cards, setCards] = useState<readonly EligibleOffersCardItem[]>([...initialCards]);
  // Products the listing has moved past without showing them: those ahead of a deep-linked page, and any a page covered
  // that the catalog would not draw. They are "seen", so the next request does not ask for them again.
  const [passed, setPassed] = useState<readonly string[]>(precedingProductIds ?? []);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [hasNextPage, setHasNextPage] = useState(continues && initialPage < totalPages);
  // What the listing looked like when it was last known to be complete: the offer's size and how many products were
  // shown or passed. A finished listing is reopened when the offer lists more than the shopper has accounted for, which
  // covers growth and a replacement alike (a product leaves, another joins, the total is unchanged). A probe that finds
  // nothing records this pair, so the same pair never probes twice.
  const [drainedKey, setDrainedKey] = useState(`${totalCount}|${initialCards.length + (precedingProductIds?.length ?? 0)}`);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  // Which listing this is. A server refresh (the promotion refresher re-renders the page every minute) hands over a new
  // array of the same listing; only a different offer or entry page is a different listing.
  const listKey = `${campaignId}|${initialPage}`;
  // A page requested for one listing must not land on another (the shopper navigated to a different page or offer).
  const guardRef = useRef(createPageRequestGuard(listKey));
  useEffect(() => {
    guardRef.current.setList(listKey);
  }, [listKey]);

  const [prevListKey, setPrevListKey] = useState(listKey);
  const [prevInitialCards, setPrevInitialCards] = useState(initialCards);
  if (listKey !== prevListKey) {
    setPrevListKey(listKey);
    setPrevInitialCards(initialCards);
    setCards([...initialCards]);
    setPassed(precedingProductIds ?? []);
    setCurrentPage(initialPage);
    setHasNextPage(continues && initialPage < totalPages);
    setDrainedKey(`${totalCount}|${initialCards.length + (precedingProductIds?.length ?? 0)}`);
    setIsLoadingMore(false);
    setError(null);
  } else if (initialCards !== prevInitialCards) {
    // The same listing, revalidated. The server-rendered page is authoritative for itself: its products, their order and
    // their prices lead the list, so one that entered it appears and one that moved down is no longer duplicated at the
    // top. Every page the shopper has loaded since stays after it, where the effect below redraws it and drops what the
    // offer no longer lists.
    setPrevInitialCards(initialCards);
    const onServerPage = new Set(initialCards.map((card) => card.id));
    setCards((prev) => [...initialCards, ...prev.filter((card) => !onServerPage.has(card.id))]);
  }

  // A listing scrolled to its end has no sentinel or button. When the offer lists more products than the shopper has
  // accounted for (shown, or passed over) it is open again, and the shopper keeps their place. This reads the cards too,
  // not only the total: the redraw above removes a product the offer dropped, and a replacement leaves the total as it was.
  const accounted = cards.length + passed.length;
  const reopened = continues && totalCount > accounted && drainedKey !== `${totalCount}|${accounted}`;
  const canLoadMore = hasNextPage || reopened;

  // The server re-renders the first page only, so the cards loaded since would keep the price, sale badge and stock label
  // they were drawn with, and one the offer dropped would stay. After a revalidation they are asked for again, by id:
  // the answer replaces each card in place, and a product the offer no longer lists for this cart is removed. Only an
  // answer that is known counts: when the cart, the offer or the read is unavailable nothing changes.
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const revalidatedRef = useRef(initialCards);
  const refreshedUpToRef = useRef(0);
  useEffect(() => {
    if (revalidatedRef.current === initialCards) return;
    revalidatedRef.current = initialCards;
    const onServerPage = new Set(initialCards.map((card) => card.id));
    const appended = cardsRef.current.map((card) => card.id).filter((id) => !onServerPage.has(id));
    if (appended.length === 0) return;
    // Start where the last revalidation stopped, wrapping around, so a long list is covered over several of them.
    const start = refreshedUpToRef.current % appended.length;
    const ordered = [...appended.slice(start), ...appended.slice(0, start)];
    refreshedUpToRef.current = start + Math.min(ordered.length, REFRESH_CHUNK * REFRESH_MAX_CALLS);
    const request = guardRef.current.begin();
    void (async () => {
      for (let call = 0; call < REFRESH_MAX_CALLS && call * REFRESH_CHUNK < ordered.length; call += 1) {
        const asked = ordered.slice(call * REFRESH_CHUNK, (call + 1) * REFRESH_CHUNK);
        try {
          const redrawn = await refreshEligibleOffersCardsAction({ campaignId, productIds: asked });
          if (!request.isCurrent()) return;
          if (!redrawn.ok) return;
          const fresh = new Map(redrawn.cards.map((card) => [card.id, card]));
          const askedIds = new Set(asked);
          setCards((prev) => prev.flatMap((card) => (askedIds.has(card.id) ? (fresh.has(card.id) ? [fresh.get(card.id)!] : []) : [card])));
        } catch {
          // A failed redraw leaves the cards as they were; the next revalidation tries again.
          return;
        }
      }
    })();
  }, [campaignId, initialCards]);

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !canLoadMore) return;

    let stale = false;
    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const shownProductIds = [...cards.map((card) => card.id), ...passed];
      const outcome = await settleIfCurrent(guardRef.current, () =>
        loadEligibleOffersNextPageAction({ campaignId, shownProductIds }),
      );
      if (outcome.stale) {
        stale = true;
        return;
      }
      const result = outcome.value;

      if (!result.ok) {
        // No message means the offer is gone: retrying cannot help, so stop paging.
        if (result.error) setError(result.error);
        else {
          setHasNextPage(false);
          setDrainedKey(`${totalCount}|${cards.length + passed.length}`);
        }
        return;
      }

      const shown = new Set(shownProductIds);
      const fresh = result.cards.filter((card) => !shown.has(card.id));
      const drawn = new Set(result.cards.map((card) => card.id));
      setCards((prev) => {
        const known = new Set(prev.map((card) => card.id));
        return [...prev, ...fresh.filter((card) => !known.has(card.id))];
      });
      const nowPassed = result.consumedProductIds.filter((id) => !drawn.has(id) && !shown.has(id));
      setPassed((prev) => [...prev, ...nowPassed]);
      setCurrentPage((page) => page + 1);
      setHasNextPage(result.hasNext);
      if (!result.hasNext) setDrainedKey(`${totalCount}|${cards.length + fresh.length + passed.length + nowPassed.length}`);
      setAnnouncement(
        `Đã tải thêm ${fresh.length} sản phẩm ưu đãi. Đang hiển thị ${cards.length + fresh.length} trên tổng số ${totalCount} sản phẩm.`,
      );
    } catch {
      setError("Đã xảy ra lỗi khi tải thêm sản phẩm. Nàng thử lại nhé.");
    } finally {
      if (!stale) setIsLoadingMore(false);
    }
  }, [campaignId, canLoadMore, cards, isLoadingMore, passed, totalCount]);

  // Auto-load near the bottom. Paused while an error is shown: the sentinel is still on screen after a failure, so
  // observing again would retry in a tight loop and burn the rate-limit budget; the shopper retries with the button.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore || isLoadingMore || error !== null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "300px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, error, isLoadingMore, loadMore]);

  return { cards, currentPage, hasNextPage: canLoadMore, isLoadingMore, announcement, error, sentinelRef, loadMore };
}
