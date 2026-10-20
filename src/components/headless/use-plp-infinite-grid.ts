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
  nextCursor?: string | null;
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
  nextCursor,
}: UsePlpInfiniteGridOptions) {
  const [products, setProducts] = useState<ProductCardModel[]>([...initialProducts]);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [cursor, setCursor] = useState<string | null>(nextCursor ?? null);
  const [hasNextPage, setHasNextPage] = useState(hasNext);
  const [nextPageHref, setNextPageHref] = useState<string | null>(nextHref);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement>(null);
  // The product list the grid currently belongs to. A page request started for one list must not
  // land on another: changing size, sort or price while a page is loading would otherwise append
  // the old filter's products to the new filter's grid.
  const listIdentityRef = useRef(initialProducts);
  useEffect(() => {
    listIdentityRef.current = initialProducts;
  }, [initialProducts]);

  // Sync state if initialProducts change from server (e.g. filter navigation)
  const [prevInitialProducts, setPrevInitialProducts] = useState(initialProducts);
  if (initialProducts !== prevInitialProducts) {
    setPrevInitialProducts(initialProducts);
    setProducts([...initialProducts]);
    setCurrentPage(initialPage);
    setCursor(nextCursor ?? null);
    setHasNextPage(hasNext);
    setNextPageHref(nextHref);
    setIsLoadingMore(false);
    setError(null);
  }

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasNextPage) return;

    const startedFor = listIdentityRef.current;
    let stale = false;
    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const result = await loadCategoryNextPageAction({
        categoryKey,
        categoryPath,
        cursor: cursor,
        page: cursor ? undefined : currentPage + 1,
        color: activeFilters.color,
        size: activeFilters.size,
        availability: activeFilters.availability,
        minPriceVnd: activeFilters.minPriceVnd,
        maxPriceVnd: activeFilters.maxPriceVnd,
        sale: activeFilters.sale,
        sort: activeFilters.sort,
      });

      if (listIdentityRef.current !== startedFor) {
        // The shopper moved to another filter; the grid was already reset for it.
        stale = true;
        return;
      }

      setProducts((prev) => [...prev, ...result.products]);
      setCurrentPage(result.page);
      setCursor(result.nextCursor);
      setHasNextPage(result.hasNext);
      setNextPageHref(result.nextHref);

      const totalLoaded = products.length + result.products.length;
      setAnnouncement(
        `Đã tải thêm ${result.products.length} sản phẩm. Tổng cộng ${totalLoaded} trên ${totalCount} sản phẩm.`,
      );
    } catch {
      if (listIdentityRef.current !== startedFor) {
        stale = true;
        return;
      }
      const errorMessage = "Chưa tải thêm được sản phẩm. Nàng thử lại nhé.";
      setError(errorMessage);
      setAnnouncement(errorMessage);
    } finally {
      if (!stale) setIsLoadingMore(false);
    }
  }, [
    activeFilters,
    categoryKey,
    categoryPath,
    currentPage,
    cursor,
    hasNextPage,
    isLoadingMore,
    products.length,
    totalCount,
  ]);

  // IntersectionObserver for infinite scroll - guarded against error !== null to prevent retry loops
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || isLoadingMore || error !== null) return;

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
