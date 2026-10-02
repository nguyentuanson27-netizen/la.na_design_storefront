"use server";

import { STOREFRONT_DISCOVERY_LIMITS } from "./storefront-discovery.ts";
import {
  matchTaxonomyCategories,
  type SearchSuggestionProduct,
  type SearchSuggestionsResult,
} from "../components/headless/search-overlay-model.ts";

export type SearchStorefrontFinder = (trimmedQuery: string) => Promise<SearchSuggestionProduct[]>;

export async function searchStorefrontSuggestionsWithFinder(
  query: string,
  finder: SearchStorefrontFinder,
): Promise<SearchSuggestionsResult> {
  const trimmed = query.trim();

  if (trimmed.length > STOREFRONT_DISCOVERY_LIMITS.query) {
    return {
      query: trimmed,
      categories: [],
      products: [],
      error: `Từ khóa tìm kiếm vượt quá giới hạn cho phép (tối đa ${STOREFRONT_DISCOVERY_LIMITS.query} ký tự).`,
    };
  }

  const matchedCategories = matchTaxonomyCategories(trimmed);

  if (trimmed.length === 0) {
    return {
      query: "",
      categories: matchedCategories,
      products: [],
    };
  }

  try {
    const products = await finder(trimmed);
    return {
      query: trimmed,
      categories: matchedCategories,
      products,
    };
  } catch {
    return {
      query: trimmed,
      categories: matchedCategories,
      products: [],
      error: "Không thể kết nối đến hệ thống tìm kiếm lúc này.",
    };
  }
}

export async function searchStorefrontSuggestionsAction(
  query: string,
): Promise<SearchSuggestionsResult> {
  return searchStorefrontSuggestionsWithFinder(query, async (trimmed) => {
    const { prisma } = await import("../db/prisma.ts");
    const { readPancakeShopId } = await import("../integrations/pancake/config.ts");
    const { createStorefrontSearchSuggestionFinder } = await import(
      "./storefront-search-repository.ts"
    );
    return createStorefrontSearchSuggestionFinder(prisma, readPancakeShopId())(trimmed);
  });
}
