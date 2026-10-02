import type { PrismaClient } from "../generated/prisma/client.ts";
import { resolveStorefrontProductMedia } from "./product-media.ts";
import type { SearchStorefrontFinder } from "./storefront-search-actions.ts";
import {
  storefrontSearchMediaCandidatesSql,
  type StorefrontSearchMediaCandidateRow,
} from "./storefront-search-media.ts";

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
        variants: {
          where: { isPresent: true, isActive: true },
          orderBy: [{ pancakeVariationId: "asc" }],
          take: 1,
          select: {
            pancakeRetailPrice: true,
            pancakeRetailPriceAfterDiscount: true,
          },
        },
      },
    });

    const mediaCandidates =
      records.length === 0
        ? []
        : await client.$queryRaw<StorefrontSearchMediaCandidateRow[]>(
            storefrontSearchMediaCandidatesSql(records.map((record) => record.id)),
          );
    const mediaCandidatesByProductId = new Map<string, string[]>();
    for (const candidate of mediaCandidates) {
      const candidates = mediaCandidatesByProductId.get(candidate.productId) ?? [];
      candidates.push(candidate.url);
      mediaCandidatesByProductId.set(candidate.productId, candidates);
    }

    return records.map((record) => {
      const variant = record.variants[0];
      const price =
        variant?.pancakeRetailPriceAfterDiscount ?? variant?.pancakeRetailPrice ?? null;
      const media = resolveStorefrontProductMedia({
        productName: record.name,
        primaryImageUrl: null,
        variantImageUrls: [mediaCandidatesByProductId.get(record.id) ?? []],
      });
      return {
        id: record.id,
        slug: record.slug,
        name: record.name,
        primaryImageUrl: media.primary?.url ?? null,
        priceText: price !== null ? currency.format(price) : null,
      };
    });
  };
}
