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

/** Cards per refresh call (the server's cap), and the calls one revalidation makes, so a very long list stays cheap. */
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

  // The server re-renders the first page only, so the cards loaded since would keep the price, sale badge and stock label
  // they were drawn with, and one the offer dropped would stay. After a revalidation they are asked for again, by id:
  // the answer replaces each card in place, and a product the offer no longer lists for this cart is removed. Only an
  // answer that is known counts: when the cart, the offer or the read is unavailable nothing changes.
  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const revalidatedRef = useRef(initialCards);
  useEffect(() => {
    if (revalidatedRef.current === initialCards) return;
    revalidatedRef.current = initialCards;
    const onServerPage = new Set(initialCards.map((card) => card.id));
    const appended = cardsRef.current.map((card) => card.id).filter((id) => !onServerPage.has(id));
    if (appended.length === 0) return;
    const request = guardRef.current.begin();
    void (async () => {
      for (let call = 0; call < REFRESH_MAX_CALLS && call * REFRESH_CHUNK < appended.length; call += 1) {
        const asked = appended.slice(call * REFRESH_CHUNK, (call + 1) * REFRESH_CHUNK);
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
    if (isLoadingMore || !hasNextPage) return;

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
        else setHasNextPage(false);
        return;
      }

      const shown = new Set(shownProductIds);
      const fresh = result.cards.filter((card) => !shown.has(card.id));
      const drawn = new Set(result.cards.map((card) => card.id));
      setCards((prev) => {
        const known = new Set(prev.map((card) => card.id));
        return [...prev, ...fresh.filter((card) => !known.has(card.id))];
      });
      setPassed((prev) => [...prev, ...result.consumedProductIds.filter((id) => !drawn.has(id) && !shown.has(id))]);
      setCurrentPage((page) => page + 1);
      setHasNextPage(result.hasNext);
      setAnnouncement(
        `Đã tải thêm ${fresh.length} sản phẩm ưu đãi. Đang hiển thị ${cards.length + fresh.length} trên tổng số ${totalCount} sản phẩm.`,
      );
    } catch {
      setError("Đã xảy ra lỗi khi tải thêm sản phẩm. Nàng thử lại nhé.");
    } finally {
      if (!stale) setIsLoadingMore(false);
    }
  }, [campaignId, cards, hasNextPage, isLoadingMore, passed, totalCount]);

  // Auto-load near the bottom. Paused while an error is shown: the sentinel is still on screen after a failure, so
  // observing again would retry in a tight loop and burn the rate-limit budget; the shopper retries with the button.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || isLoadingMore || error !== null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "300px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, hasNextPage, isLoadingMore, loadMore]);

  return { cards, currentPage, hasNextPage, isLoadingMore, announcement, error, sentinelRef, loadMore };
}
