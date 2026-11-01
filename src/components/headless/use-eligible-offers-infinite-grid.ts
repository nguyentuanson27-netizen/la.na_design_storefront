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
}: UseEligibleOffersInfiniteGridOptions) {
  const [cards, setCards] = useState<readonly EligibleOffersCardItem[]>([...initialCards]);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [hasNextPage, setHasNextPage] = useState(initialPage < totalPages);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  // A page requested for one listing must not land on another (the shopper navigated to a different page or offer).
  const guardRef = useRef(createPageRequestGuard(initialCards));
  useEffect(() => {
    guardRef.current.setList(initialCards);
  }, [initialCards]);

  // Sync state if the server sends a different first page.
  const [prevInitialCards, setPrevInitialCards] = useState(initialCards);
  if (initialCards !== prevInitialCards) {
    setPrevInitialCards(initialCards);
    setCards([...initialCards]);
    setCurrentPage(initialPage);
    setHasNextPage(initialPage < totalPages);
    setIsLoadingMore(false);
    setError(null);
  }

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasNextPage) return;

    let stale = false;
    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const outcome = await settleIfCurrent(guardRef.current, () =>
        loadEligibleOffersNextPageAction({ campaignId, page: currentPage + 1 }),
      );
      if (outcome.stale) {
        stale = true;
        return;
      }
      const result = outcome.value;

      if (!result.ok) {
        // No message means the offer is gone or the page does not exist: retrying cannot help, so stop paging.
        if (result.error) setError(result.error);
        else setHasNextPage(false);
        return;
      }

      const shown = new Set(cards.map((card) => card.id));
      const fresh = result.cards.filter((card) => !shown.has(card.id));
      setCards((prev) => {
        const known = new Set(prev.map((card) => card.id));
        return [...prev, ...fresh.filter((card) => !known.has(card.id))];
      });
      setCurrentPage(result.page);
      setHasNextPage(result.hasNext);
      setAnnouncement(
        `Đã tải thêm ${fresh.length} sản phẩm ưu đãi. Đang hiển thị ${cards.length + fresh.length} trên tổng số ${totalCount} sản phẩm.`,
      );
    } catch {
      setError("Đã xảy ra lỗi khi tải thêm sản phẩm. Nàng thử lại nhé.");
    } finally {
      if (!stale) setIsLoadingMore(false);
    }
  }, [campaignId, cards, currentPage, hasNextPage, isLoadingMore, totalCount]);

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
