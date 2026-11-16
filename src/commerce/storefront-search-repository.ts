import type { PrismaClient } from "../generated/prisma/client.ts";
import { parseTrustedProductImageUrl, resolveStorefrontProductMedia } from "./product-media.ts";
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
    const orderedVariantById = new Map(orderedVariants.map((variant) => [variant.id, variant]));
    const orderedProductIds = new Set(orderedProducts.map((record) => record.id));
    const variantOrder = orderedProducts.flatMap((record) =>
      orderProductVariants(
        orderedVariants.filter((variant) => variant.productId === record.id),
        record.variantColorOrder?.colors,
      ).map((variant) => variant.id),
    );

    const mediaCandidates =
      records.length === 0
        ? []
        : await client.$queryRaw<StorefrontSearchMediaCandidateRow[]>(
            storefrontSearchMediaCandidatesSql(
              records.map((record) => record.id),
              variantOrder,
            ),
          );
    const mediaCandidatesByProductId = new Map<string, StorefrontSearchMediaCandidateRow[]>();
    for (const candidate of mediaCandidates) {
      const candidates = mediaCandidatesByProductId.get(candidate.productId) ?? [];
      candidates.push(candidate);
      mediaCandidatesByProductId.set(candidate.productId, candidates);
    }

    return records.map((record) => {
      const candidates = mediaCandidatesByProductId.get(record.id) ?? [];
      const media = resolveStorefrontProductMedia({
        productName: record.name,
        primaryImageUrl: null,
        variantImageUrls: [candidates.map((candidate) => candidate.url)],
      });
      // The price is the first Pancake variant's, as before -- except for a product with a stored
      // color order, where it is the price of the variant whose photo is actually shown, so a
      // suggestion never pairs one color's photo with another color's price. The shown photo is the
      // first candidate the resolver accepts. If it belongs to no variant (the product's own photo)
      // or nothing is shown, the first Pancake variant prices it, as it does for a product with no order.
      let variant = record.variants[0];
      if (orderedProductIds.has(record.id)) {
        const shown = candidates.find(
          (candidate) => parseTrustedProductImageUrl(candidate.url) !== null,
        );
        variant =
          (shown?.variantId ? orderedVariantById.get(shown.variantId) : undefined) ?? variant;
      }
      const price =
        variant?.pancakeRetailPriceAfterDiscount ?? variant?.pancakeRetailPrice ?? null;
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
