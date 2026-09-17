"use server";

import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
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

export async function searchStorefrontSuggestionsAction(
  query: string,
): Promise<SearchSuggestionsResult> {
  const trimmed = query.trim();
  const matchedCategories = matchTaxonomyCategories(trimmed);

  if (trimmed.length === 0) {
    return {
      query: "",
      categories: matchedCategories,
      products: [],
    };
  }

  try {
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

    const products: SearchSuggestionProduct[] = records.map((record) => {
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

    return {
      query: trimmed,
      categories: matchedCategories,
      products,
    };
  } catch {
    // If DB is offline or throws in test environment, return matched categories and empty products
    return {
      query: trimmed,
      categories: matchedCategories,
      products: [],
    };
  }
}
