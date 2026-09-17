"use client";

import Link from "next/link";

import type { ProductCardModel } from "@/components/headless/build-product-card-model";
import { ProductCard, type ProductCardTone } from "@/components/brand/product-card";
import type { PlpFilterState } from "@/components/headless/plp-filter-model";
import { usePlpInfiniteGrid } from "@/components/headless/use-plp-infinite-grid";

const tones: readonly ProductCardTone[] = ["stone", "olive", "ink", "sand"];

export type PlpInfiniteGridProps = {
  initialProducts: readonly ProductCardModel[];
  totalCount: number;
  totalPages: number;
  initialPage: number;
  categoryKey: string;
  categoryPath: string;
  activeFilters: PlpFilterState;
  hasNext: boolean;
  nextHref: string | null;
  nextCursor: string | null;
};

export function PlpInfiniteGrid(props: PlpInfiniteGridProps) {
  const { totalCount, totalPages, categoryPath } = props;
  const {
    products,
    currentPage,
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
      <div className="py-20 text-center">
        <p className="font-serif text-2xl text-[#2A1810]">Không tìm thấy sản phẩm phù hợp</p>
        <p className="mt-2 text-xs text-[#3B2219]/70">
          Vui lòng thử điều chỉnh bộ lọc hoặc xóa các tùy chọn đã chọn.
        </p>
        <div className="mt-6">
          <Link
            href={categoryPath}
            className="inline-flex items-center rounded-full border border-[#3B2219] bg-[#3B2219] px-6 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#FAF7F2] transition hover:bg-[#2A1810]"
          >
            Xóa tất cả bộ lọc
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8">
      {/* Screen reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {/* Product grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 sm:gap-y-10 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-8 lg:gap-y-12">
        {products.map((model, idx) => (
          <ProductCard
            key={`${model.href}-${idx}`}
            model={model}
            tone={tones[idx % tones.length]!}
          />
        ))}

        {/* Loading skeleton placeholders */}
        {isLoadingMore ? (
          <>
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                aria-hidden="true"
                className="aspect-[4/5] animate-pulse rounded bg-[#FAF7F2]/80 border border-[#3B2219]/10"
              />
            ))}
          </>
        ) : null}
      </div>

      {/* Error state with retry */}
      {error ? (
        <div className="mt-8 text-center text-xs text-[#70584B]">
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

      {/* Manual "Xem thêm" button & Crawler Fallback */}
      {hasNextPage && !isLoadingMore ? (
        <div className="mt-12 text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            className="inline-flex items-center rounded-full border border-[#3B2219]/30 px-8 py-3 text-xs font-semibold uppercase tracking-widest text-[#3B2219] transition hover:border-[#2A1810] hover:bg-[#2A1810] hover:text-[#FAF7F2]"
          >
            Xem thêm ({products.length}/{totalCount})
          </button>
        </div>
      ) : null}

      {/* Non-JS Crawler fallback link */}
      {nextPageHref ? (
        <noscript>
          <div className="mt-8 text-center">
            <Link
              href={nextPageHref}
              className="text-xs font-semibold uppercase tracking-wider text-[#3B2219] underline"
            >
              Trang tiếp theo ({currentPage + 1}/{totalPages})
            </Link>
          </div>
        </noscript>
      ) : null}
    </div>
  );
}
