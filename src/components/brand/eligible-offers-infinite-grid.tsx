"use client";

import Link from "@/i18n/link";

import { ListingProductGrid } from "@/components/brand/listing-chrome";
import { PRODUCT_CARD_EAGER_COUNT, ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import {
  useEligibleOffersInfiniteGrid,
  type EligibleOffersCardItem,
} from "@/components/headless/use-eligible-offers-infinite-grid";
import { useT } from "@/i18n/client";

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

export type EligibleOffersInfiniteGridProps = {
  initialCards: readonly EligibleOffersCardItem[];
  totalCount: number;
  totalPages: number;
  initialPage: number;
  campaignId: string;
  toneOffset?: number;
  /** The products ahead of a deep-linked page; `null` when there are too many to continue in place. */
  precedingProductIds?: readonly string[] | null;
  /** The server-rendered next page, for shoppers and crawlers without JavaScript. */
  nextHref?: string | null;
};

export function EligibleOffersInfiniteGrid({ toneOffset = 0, nextHref = null, ...options }: EligibleOffersInfiniteGridProps) {
  const t = useT();
  const { totalCount, totalPages } = options;
  const { cards, currentPage, hasNextPage, isLoadingMore, announcement, error, sentinelRef, loadMore } =
    useEligibleOffersInfiniteGrid(options);

  return (
    <div className="mt-8">
      {/* Screen reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

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
          <button type="button" onClick={() => void loadMore()} className="mt-2 text-xs font-semibold uppercase underline">
            {t("Thử lại")}
          </button>
        </div>
      ) : null}

      {/* Sentinel for IntersectionObserver */}
      {hasNextPage ? <div ref={sentinelRef} className="h-4 w-full" /> : null}

      {/* Manual "Xem thêm" button */}
      {hasNextPage && !isLoadingMore && !error ? (
        <div className="mt-12 text-center">
          <button type="button" onClick={() => void loadMore()} className="btn btn--outline px-8">
            Xem thêm ({cards.length}/{totalCount})
          </button>
        </div>
      ) : null}

      {/* Too far into the list to continue in place: the next page is a link. */}
      {nextHref && options.precedingProductIds === null ? (
        <div className="mt-8 text-center">
          <Link href={nextHref} className="text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline">
            Trang tiếp theo ({currentPage + 1}/{totalPages})
          </Link>
        </div>
      ) : null}

      {/* Non-JS fallback: the next page is server-rendered at ?page=N */}
      {nextHref ? (
        <noscript>
          <div className="mt-8 text-center">
            <Link href={nextHref} className="text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline">
              Trang tiếp theo ({currentPage + 1}/{totalPages})
            </Link>
          </div>
        </noscript>
      ) : null}
    </div>
  );
}
