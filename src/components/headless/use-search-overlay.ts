"use client";

import { useCallback, useEffect, useState } from "react";

import { searchStorefrontSuggestionsAction } from "@/commerce/storefront-search-actions";
import {
  buildSearchAnnouncement,
  matchTaxonomyCategories,
  type SearchSuggestionsResult,
} from "./search-overlay-model";

export function useSearchOverlay(isOpen: boolean) {
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SearchSuggestionsResult>({
    query: "",
    categories: matchTaxonomyCategories(""),
    products: [],
  });
  const [announcement, setAnnouncement] = useState("");

  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setQuery("");
      setAnnouncement("");
    }
  }

  const defaultResult: SearchSuggestionsResult = {
    query: "",
    categories: matchTaxonomyCategories(""),
    products: [],
  };

  const isBlank = query.trim().length === 0;
  const effectiveResult = isBlank ? defaultResult : result;

  // Debounced search
  useEffect(() => {
    if (!isOpen) return;

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setIsLoading(true);
      setAnnouncement("Đang tìm kiếm...");
      try {
        const data = await searchStorefrontSuggestionsAction(trimmed);
        if (!cancelled) {
          setResult(data);
          if (data.error) {
            setAnnouncement(data.error);
          } else {
            setAnnouncement(
              buildSearchAnnouncement(trimmed, false, data.products.length, data.categories.length),
            );
          }
        }
      } catch {
        if (!cancelled) {
          setResult({
            query: trimmed,
            categories: [],
            products: [],
            error: "Không thể kết nối đến hệ thống tìm kiếm lúc này.",
          });
          setAnnouncement(`Không thể tìm kiếm cho "${trimmed}".`);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query, isOpen]);

  const clearQuery = useCallback(() => {
    setQuery("");
  }, []);

  return {
    query,
    setQuery,
    clearQuery,
    isLoading,
    result: effectiveResult,
    announcement,
  };
}
