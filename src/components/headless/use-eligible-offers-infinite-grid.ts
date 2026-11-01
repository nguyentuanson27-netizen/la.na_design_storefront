"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadEligibleOffersNextPageAction } from "@/commerce/eligible-offers-actions";
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
  /** Products ahead of the first server-rendered card: nonzero when the listing was opened at `?page=N`. */
  skip?: number;
};

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
  skip = 0,
}: UseEligibleOffersInfiniteGridOptions) {
  const [cards, setCards] = useState<readonly EligibleOffersCardItem[]>([...initialCards]);
  // Products a page covered that the catalog would not draw: still "seen", so the next request does not ask for them again.
  const [undrawn, setUndrawn] = useState<readonly string[]>([]);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [hasNextPage, setHasNextPage] = useState(initialPage < totalPages);
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
    setUndrawn([]);
    setCurrentPage(initialPage);
    setHasNextPage(initialPage < totalPages);
    setIsLoadingMore(false);
    setError(null);
  } else if (initialCards !== prevInitialCards) {
    // The same listing, revalidated: take the fresh prices and stock for the cards already shown, and keep every page
    // the shopper has loaded.
    setPrevInitialCards(initialCards);
    const fresh = new Map(initialCards.map((card) => [card.id, card]));
    setCards((prev) => prev.map((card) => fresh.get(card.id) ?? card));
  }

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasNextPage) return;

    let stale = false;
    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const shownProductIds = [...cards.map((card) => card.id), ...undrawn];
      const outcome = await settleIfCurrent(guardRef.current, () =>
        loadEligibleOffersNextPageAction({ campaignId, shownProductIds, skip }),
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
      setUndrawn((prev) => [...prev, ...result.consumedProductIds.filter((id) => !drawn.has(id) && !shown.has(id))]);
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
  }, [campaignId, cards, hasNextPage, isLoadingMore, skip, totalCount, undrawn]);

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
