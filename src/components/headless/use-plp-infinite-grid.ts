"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadCategoryNextPageAction } from "@/commerce/storefront-category-actions";
import type { ProductCardModel } from "./build-product-card-model";
import type { PlpFilterState } from "./plp-filter-model";

export type UsePlpInfiniteGridOptions = {
  initialProducts: readonly ProductCardModel[];
  totalCount: number;
  initialPage: number;
  categoryKey: string;
  categoryPath: string;
  activeFilters: PlpFilterState;
  hasNext: boolean;
  nextHref: string | null;
};

export function usePlpInfiniteGrid({
  initialProducts,
  totalCount,
  initialPage,
  categoryKey,
  categoryPath,
  activeFilters,
  hasNext,
  nextHref,
}: UsePlpInfiniteGridOptions) {
  const [products, setProducts] = useState<ProductCardModel[]>([...initialProducts]);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [hasNextPage, setHasNextPage] = useState(hasNext);
  const [nextPageHref, setNextPageHref] = useState<string | null>(nextHref);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // Sync state if initialProducts change from server (e.g. filter navigation)
  const [prevInitialProducts, setPrevInitialProducts] = useState(initialProducts);
  if (initialProducts !== prevInitialProducts) {
    setPrevInitialProducts(initialProducts);
    setProducts([...initialProducts]);
    setCurrentPage(initialPage);
    setHasNextPage(hasNext);
    setNextPageHref(nextHref);
    setIsLoadingMore(false);
    setError(null);
  }

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasNextPage) return;

    setIsLoadingMore(true);
    setError(null);

    try {
      const nextPage = currentPage + 1;
      const result = await loadCategoryNextPageAction({
        categoryKey,
        categoryPath,
        page: nextPage,
        color: activeFilters.color,
        size: activeFilters.size,
        minPriceVnd: activeFilters.minPriceVnd,
        maxPriceVnd: activeFilters.maxPriceVnd,
        sale: activeFilters.sale,
        sort: activeFilters.sort,
      });

      setProducts((prev) => [...prev, ...result.products]);
      setCurrentPage(result.page);
      setHasNextPage(result.hasNext);
      setNextPageHref(result.nextHref);

      const totalLoaded = products.length + result.products.length;
      setAnnouncement(
        `Đã tải thêm ${result.products.length} sản phẩm. Tổng cộng ${totalLoaded} trên ${totalCount} sản phẩm.`,
      );

      if (result.currentHref && typeof window !== "undefined") {
        window.history.replaceState(null, "", result.currentHref);
      }
    } catch {
      setError("Không thể tải thêm sản phẩm. Vui lòng thử lại.");
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    activeFilters,
    categoryKey,
    categoryPath,
    currentPage,
    hasNextPage,
    isLoadingMore,
    products.length,
    totalCount,
  ]);

  // IntersectionObserver for infinite scroll
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

  return {
    products,
    currentPage,
    hasNextPage,
    nextPageHref,
    isLoadingMore,
    announcement,
    error,
    sentinelRef,
    loadMore,
  };
}
