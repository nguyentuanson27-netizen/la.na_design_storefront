import type { PrismaClient } from "../generated/prisma/client.ts";
import { resolveStorefrontProductMedia } from "./product-media.ts";
import { orderProductVariants } from "./product-variant-order.ts";
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
        variantColorOrder: { select: { colors: true } },
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

    // A product with a stored color order shows that order's photos first, here as everywhere else.
    // Only those products need their variants read again, and only to learn the order.
    const orderedProducts = records.filter((record) => record.variantColorOrder !== null);
    const orderedVariants =
      orderedProducts.length === 0
        ? []
        : await client.variantMirror.findMany({
            where: {
              productId: { in: orderedProducts.map((record) => record.id) },
              isPresent: true,
              isActive: true,
            },
            orderBy: [{ pancakeVariationId: "asc" }],
            select: {
              id: true,
              productId: true,
              color: true,
              size: true,
              pancakeRetailPrice: true,
              pancakeRetailPriceAfterDiscount: true,
            },
          });
    // The variant that leads is the one whose photo the suggestion shows, so it also supplies the
    // price: a suggestion never pairs one color's photo with another color's price.
    const leadVariantByProductId = new Map<string, (typeof orderedVariants)[number]>();
    const variantOrder = orderedProducts.flatMap((record) => {
      const ordered = orderProductVariants(
        orderedVariants.filter((variant) => variant.productId === record.id),
        record.variantColorOrder?.colors,
      );
      if (ordered[0]) leadVariantByProductId.set(record.id, ordered[0]);
      return ordered.map((variant) => variant.id);
    });

    const mediaCandidates =
      records.length === 0
        ? []
        : await client.$queryRaw<StorefrontSearchMediaCandidateRow[]>(
            storefrontSearchMediaCandidatesSql(
              records.map((record) => record.id),
              variantOrder,
            ),
          );
    const mediaCandidatesByProductId = new Map<string, string[]>();
    for (const candidate of mediaCandidates) {
      const candidates = mediaCandidatesByProductId.get(candidate.productId) ?? [];
      candidates.push(candidate.url);
      mediaCandidatesByProductId.set(candidate.productId, candidates);
    }

    return records.map((record) => {
      // No stored order: the first variant in Pancake order, as before.
      const variant = leadVariantByProductId.get(record.id) ?? record.variants[0];
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
