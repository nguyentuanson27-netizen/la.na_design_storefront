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
        setError(result.error ?? "Không thể tải thêm sản phẩm ưu đãi.");
        setIsLoadingMore(false);
        return;
      }

      setCards((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const fresh = result.cards.filter((c) => !existingIds.has(c.id));
        return [...prev, ...fresh];
      });
      setCurrentPage(result.page);
      setHasNextPage(result.hasNext);

      const totalLoaded = cards.length + result.cards.length;
      setAnnouncement(`Đã tải thêm ${result.cards.length} sản phẩm ưu đãi. Đang hiển thị ${totalLoaded} trên tổng số ${totalCount} sản phẩm.`);
    } catch {
      setError("Đã xảy ra lỗi khi tải thêm sản phẩm. Nàng thử lại nhé.");
    } finally {
      setIsLoadingMore(false);
    }
  }, [campaignId, cards.length, currentPage, hasNextPage, isLoadingMore, totalCount]);

  // IntersectionObserver for auto loading when near bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || isLoadingMore) return;

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
  }, [hasNextPage, isLoadingMore, loadMore]);

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
            key={`${card.id}-${idx}`}
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
      {hasNextPage && !isLoadingMore ? (
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
