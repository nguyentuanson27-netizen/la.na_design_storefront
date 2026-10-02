import type { PrismaClient } from "../generated/prisma/client.ts";
import type { SearchStorefrontFinder } from "./storefront-search-actions.ts";

const MAX_SUGGESTIONS = 6;

const currency = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

/** The search overlay's product suggestions for one shop, newest-updated first. */
export function createStorefrontSearchSuggestionFinder(
  client: PrismaClient,
  shopId: number,
): SearchStorefrontFinder {
  return async (trimmed) => {
    const records = await client.productMirror.findMany({
      where: {
        pancakeShopId: shopId,
        isPresent: true,
        isActive: true,
        OR: [
          { name: { contains: trimmed, mode: "insensitive" } },
          // The mirrored name drops the Pancake product code ("SV605"), so a shopper who
          // types the code still finds the product through that code or its variant display ids.
          { productCode: { contains: trimmed, mode: "insensitive" } },
          {
            variants: {
              some: {
                isPresent: true,
                isActive: true,
                pancakeDisplayId: { contains: trimmed, mode: "insensitive" },
              },
            },
          },
        ],
      },
      take: MAX_SUGGESTIONS,
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
  };
}
