"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ListingProductGrid } from "@/components/brand/listing-chrome";
import { PRODUCT_CARD_EAGER_COUNT, ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import type { ProductCardModel } from "@/components/headless/build-product-card-model";
import { loadEligibleOffersNextPageAction } from "@/commerce/eligible-offers-actions";

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

export type EligibleOffersCardItem = Readonly<{
  id: string;
  model: ProductCardModel;
}>;

export type EligibleOffersInfiniteGridProps = {
  initialCards: readonly EligibleOffersCardItem[];
  totalCount: number;
  totalPages: number;
  initialPage: number;
  campaignId: string;
  toneOffset?: number;
};

export function EligibleOffersInfiniteGrid({
  initialCards,
  totalCount,
  totalPages,
  initialPage,
  campaignId,
  toneOffset = 0,
}: EligibleOffersInfiniteGridProps) {
  const [cards, setCards] = useState<readonly EligibleOffersCardItem[]>([...initialCards]);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [hasNextPage, setHasNextPage] = useState(initialPage < totalPages);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // Sync state if initialCards changes from server
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

    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const nextPage = currentPage + 1;
      const result = await loadEligibleOffersNextPageAction({
        campaignId,
        page: nextPage,
      });

      if (!result.ok) {
        // No message means the offer is gone or the page does not exist: retrying cannot help, so stop paging.
        if (result.error) setError(result.error);
        else setHasNextPage(false);
        return;
      }

      const existingIds = new Set(cards.map((c) => c.id));
      const fresh = result.cards.filter((c) => !existingIds.has(c.id));
      setCards((prev) => {
        const known = new Set(prev.map((c) => c.id));
        return [...prev, ...fresh.filter((c) => !known.has(c.id))];
      });
      setCurrentPage(result.page);
      setHasNextPage(result.hasNext);
      setAnnouncement(`Đã tải thêm ${fresh.length} sản phẩm ưu đãi. Đang hiển thị ${cards.length + fresh.length} trên tổng số ${totalCount} sản phẩm.`);
    } catch {
      setError("Đã xảy ra lỗi khi tải thêm sản phẩm. Nàng thử lại nhé.");
    } finally {
      setIsLoadingMore(false);
    }
  }, [campaignId, cards, currentPage, hasNextPage, isLoadingMore, totalCount]);

  // IntersectionObserver for auto loading when near bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // After a failure the sentinel is still on screen, so observing again would retry in a tight loop and burn the
    // rate-limit budget; the shopper retries with the button instead.
    if (!sentinel || !hasNextPage || isLoadingMore || error) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "300px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, hasNextPage, isLoadingMore, loadMore]);

  return (
    <div className="mt-8">
      {/* Screen reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {/* Product grid */}
      <ListingProductGrid>
        {cards.map((card, idx) => (
          <ProductCard
            key={card.id}
            model={card.model}
            tone={tones[(toneOffset + idx) % tones.length]!}
            eager={idx < PRODUCT_CARD_EAGER_COUNT}
          />
        ))}

        {/* Loading skeleton placeholders */}
        {isLoadingMore ? (
          <>
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                aria-hidden="true"
                className="aspect-[2/3] animate-pulse rounded bg-[#FAF7F2]/80 border border-[#3B2219]/10"
              />
            ))}
          </>
        ) : null}
      </ListingProductGrid>

      {/* Error state with retry */}
      {error ? (
        <div role="alert" aria-live="assertive" className="mt-8 text-center text-xs text-[#70584B]">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void loadMore()}
            className="mt-2 text-xs font-semibold uppercase underline"
          >
            Thử lại
          </button>
        </div>
      ) : null}

      {/* Sentinel for IntersectionObserver */}
      {hasNextPage ? <div ref={sentinelRef} className="h-4 w-full" /> : null}

      {/* Manual "Xem thêm" button */}
      {hasNextPage && !isLoadingMore && !error ? (
        <div className="mt-12 text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            className="btn btn--outline px-8"
          >
            Xem thêm ({cards.length}/{totalCount})
          </button>
        </div>
      ) : null}
    </div>
  );
}
