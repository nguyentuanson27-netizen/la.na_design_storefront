"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { loadCategoryNextPageAction } from "@/commerce/storefront-category-actions";
import { loadCollectionNextPageAction } from "@/commerce/storefront-collection-actions";
import { loadNewArrivalsNextPageAction } from "@/commerce/storefront-new-arrivals-actions";
import { loadSaleNextPageAction } from "@/commerce/storefront-sale-actions";
import { loadShopNextPageAction } from "@/commerce/storefront-shop-actions";
import type { SaleListingKind } from "@/brand/sale.config";
import type { TrackingEvent } from "@/tracking/commerce-events";
import { publishBrowserTrackingEvent } from "@/tracking/data-layer";
import type { ProductCardModel } from "./build-product-card-model";
import type { PlpFilterState } from "./plp-filter-model";
import { createPageRequestGuard, settleIfCurrent } from "./plp-page-request-guard";

/**
 * Which listing the grid pages through. Each has its own server action because each validates its
 * own scope (a taxonomy key, a published collection, a sale campaign kind), but all take the same
 * filter state.
 */
export type PlpGridSource =
  | Readonly<{ kind: "category"; categoryKey: string; categoryPath: string }>
  | Readonly<{ kind: "collection"; slug: string }>
  /** `/sale` (`saleKind: null`, every active discount) or one of its sub-listings. */
  | Readonly<{ kind: "sale"; saleKind: SaleListingKind | null }>
  /** `/shop`: the free-text query and the collection ride along because the filter state has no field for them. */
  | Readonly<{ kind: "shop"; query: string | null; collection: string | null }>
  /** `/new-arrivals`: the admin-selected list, which has no filters at all. */
  | Readonly<{ kind: "new-arrivals" }>;

export type UsePlpInfiniteGridOptions = {
  initialProducts: readonly ProductCardModel[];
  totalCount: number;
  initialPage: number;
  source: PlpGridSource;
  activeFilters: PlpFilterState;
  hasNext: boolean;
  nextHref: string | null;
  nextCursor?: string | null;
};

export function usePlpInfiniteGrid({
  initialProducts,
  totalCount,
  initialPage,
  source,
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
  // A page request started for one list must not land on another: changing size, sort or price
  // while a page is loading would otherwise append the old filter's products to the new grid.
  const guardRef = useRef(createPageRequestGuard(initialProducts));
  useEffect(() => {
    guardRef.current.setList(initialProducts);
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

    let stale = false;
    setIsLoadingMore(true);
    setError(null);
    setAnnouncement("");

    try {
      const request = {
        cursor: cursor,
        page: cursor ? undefined : currentPage + 1,
        color: activeFilters.color,
        size: activeFilters.size,
        availability: activeFilters.availability,
        minPriceVnd: activeFilters.minPriceVnd,
        maxPriceVnd: activeFilters.maxPriceVnd,
        sale: activeFilters.sale,
        sort: activeFilters.sort,
      };
      const outcome = await settleIfCurrent(guardRef.current, () => {
        switch (source.kind) {
          case "collection":
            return loadCollectionNextPageAction({ slug: source.slug, ...request });
          case "sale":
            // Sale listings page by number only and have no availability or Sale toggle to send.
            return loadSaleNextPageAction({
              kind: source.saleKind,
              page: currentPage + 1,
              color: request.color,
              size: request.size,
              minPriceVnd: request.minPriceVnd,
              maxPriceVnd: request.maxPriceVnd,
              sort: request.sort,
            });
          case "shop":
            return loadShopNextPageAction({
              page: currentPage + 1,
              query: source.query,
              collection: source.collection,
              color: request.color,
              size: request.size,
              availability: request.availability,
              minPriceVnd: request.minPriceVnd,
              maxPriceVnd: request.maxPriceVnd,
              sale: request.sale,
              sort: request.sort,
            });
          case "new-arrivals":
            return loadNewArrivalsNextPageAction({ page: currentPage + 1 });
          default:
            return loadCategoryNextPageAction({
              categoryKey: source.categoryKey,
              categoryPath: source.categoryPath,
              ...request,
            });
        }
      });
      if (outcome.stale) {
        // The shopper moved to another filter; the grid was already reset for it.
        stale = true;
        return;
      }
      const result = outcome.value;

      // The page is accepted, so its cards are about to be shown: report them once, in the list and
      // numbering the server built. A stale response returned above and an error never reach here.
      // The collection, sale, shop and new-arrivals actions carry one; the publisher never throws.
      const listEvent = "listEvent" in result ? (result.listEvent as TrackingEvent | null) : null;
      if (listEvent) publishBrowserTrackingEvent(listEvent);

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
      const errorMessage = "Chưa tải thêm được sản phẩm. Nàng thử lại nhé.";
      setError(errorMessage);
      setAnnouncement(errorMessage);
    } finally {
      if (!stale) setIsLoadingMore(false);
    }
  }, [
    activeFilters,
    source,
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
