"use client";

import { useLocalizedHref, useT } from "@/i18n/client";
import type { ProductCardModel } from "@/components/headless/build-product-card-model";
import {
  ListingEmptyState,
  ListingProductGrid,
} from "@/components/brand/listing-chrome";
import { PRODUCT_CARD_EAGER_COUNT, ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import type { PlpFilterState } from "@/components/headless/plp-filter-model";
import { usePlpInfiniteGrid, type PlpGridSource } from "@/components/headless/use-plp-infinite-grid";

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

export type PlpInfiniteGridProps = {
  initialProducts: readonly ProductCardModel[];
  totalCount: number;
  totalPages: number;
  initialPage: number;
  source: PlpGridSource;
  /** Where "Xóa tất cả bộ lọc" leads from the empty state: the listing without any filter. */
  clearHref: string;
  activeFilters: PlpFilterState;
  hasNext: boolean;
  nextHref: string | null;
  nextCursor: string | null;
  /** Card tone cycle offset, so a page opened by its URL continues the cycle of the pages before it. */
  toneOffset?: number;
  /**
   * Whether the empty state carries the `#san-pham`/`#products` anchors. A listing that already
   * placed them above the grid (a collection) turns this off, so no id appears twice.
   */
  emptyStateAnchors?: boolean;
};

export function PlpInfiniteGrid(props: PlpInfiniteGridProps) {
  const t = useT();
  const localizedHref = useLocalizedHref();
  const { totalCount, clearHref, toneOffset = 0, emptyStateAnchors = true } = props;
  const {
    products,
    hasNextPage,
    nextPageHref,
    isLoadingMore,
    announcement,
    error,
    sentinelRef,
    loadMore,
  } = usePlpInfiniteGrid(props);

  // Empty state
  if (products.length === 0) {
    return (
      <div id={emptyStateAnchors ? "san-pham" : undefined} className="collection-products-anchor">
        {emptyStateAnchors ? (
          <span id="products" className="pointer-events-none absolute h-0 w-0" aria-hidden="true" />
        ) : null}
        <ListingEmptyState
          titleId="category-empty-title"
          eyebrow={t("Không tìm thấy")}
          title={t("Không tìm thấy sản phẩm phù hợp")}
          copy={t("Nàng thử đổi bộ lọc hoặc bỏ bớt lựa chọn nhé.")}
          action={{ href: localizedHref(clearHref), label: "Xóa tất cả bộ lọc" }}
        />
      </div>
    );
  }

  return (
    <div className="mt-4">
      {/* Screen reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {t(announcement)}
      </div>

      {/* Product grid */}
      <ListingProductGrid>
        {products.map((model, idx) => (
          <ProductCard
            key={`${model.href}-${idx}`}
            model={model}
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
          <p>{t(error)}</p>
          <button
            type="button"
            onClick={() => void loadMore()}
            className="mt-2 text-xs font-semibold uppercase underline"
          >
            {t("Thử lại")}
          </button>
        </div>
      ) : null}

      {/* Sentinel for IntersectionObserver */}
      {hasNextPage ? <div ref={sentinelRef} className="h-4 w-full" /> : null}

      {/* "Xem thêm": a real link to the next page, so a crawler and a reader without script both find
          it in the page itself; with script it loads that page in place instead of navigating. */}
      {hasNextPage && !isLoadingMore ? (
        <div className="mt-12 text-center">
          {nextPageHref ? (
            <a
              href={localizedHref(nextPageHref)}
              rel="next"
              className="btn btn--outline px-8"
              onClick={(event) => {
                // Only a plain primary click loads in place. Ctrl/Cmd/Shift/Alt-click and middle
                // click keep the link's own behaviour (a new tab or window on the next page).
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                void loadMore();
              }}
            >
              {t("Xem thêm ({loaded}/{total})", { loaded: products.length, total: totalCount })}
            </a>
          ) : (
            <button type="button" onClick={() => void loadMore()} className="btn btn--outline px-8">
              {t("Xem thêm ({loaded}/{total})", { loaded: products.length, total: totalCount })}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
