"use server";

import { STOREFRONT_DISCOVERY_LIMITS } from "./storefront-discovery.ts";
import {
  matchTaxonomyCategories,
  type SearchSuggestionProduct,
  type SearchSuggestionsResult,
} from "../components/headless/search-overlay-model.ts";

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

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
    const shopId = readPancakeShopId();
    const records = await prisma.productMirror.findMany({
      where: {
        pancakeShopId: shopId,
        isPresent: true,
        isActive: true,
        name: {
          contains: trimmed,
          mode: "insensitive",
        },
      },
      take: 6,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
        primaryImageUrl: true,
        variants: {
          where: { isPresent: true, isActive: true },
          take: 1,
          select: {
            pancakeRetailPrice: true,
            pancakeRetailPriceAfterDiscount: true,
          },
        },
      },
    });

    return records.map((record) => {
      const variant = record.variants[0];
      const price =
        variant?.pancakeRetailPriceAfterDiscount ?? variant?.pancakeRetailPrice ?? null;
      return {
        id: record.id,
        slug: record.slug,
        name: record.name,
        primaryImageUrl: record.primaryImageUrl ?? null,
        priceText: price !== null ? currency.format(price) : null,
      };
    });
  });
}
