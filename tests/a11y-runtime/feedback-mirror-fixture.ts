import type { prisma as PrismaClient } from "../../src/db/prisma.ts";

/**
 * The feedback rail and `/feedback` read their photographs from the shop's mirrored
 * `ANH-FEEDBACK-*` variants (src/commerce/feedback-repository.ts), so a runtime spec that expects
 * the rail must write those rows. The product is inactive and has no published content, so it never
 * shows up in a listing, a search or the sitemap; only the feedback read selects it. It belongs to
 * the spec's own `shopId`, so the spec's existing shop cleanup removes it too.
 */
export async function seedFeedbackMirror(
  prisma: typeof PrismaClient,
  { shopId, runId, urls }: { shopId: number; runId: string; urls: readonly string[] },
) {
  const syncedAt = new Date("2026-10-05T00:00:00.000Z");
  const slug = `anh-feedback-fixture-${shopId}-${runId}`;
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: slug,
      slug,
      name: "ANH FEEDBACK fixture",
      isPresent: true,
      isActive: false,
      syncedAt,
    },
  });

  for (const [index, url] of urls.entries()) {
    const ordinal = String(index + 1).padStart(2, "0");
    await prisma.variantMirror.create({
      data: {
        pancakeVariationId: `${slug}-variant-${ordinal}`,
        productId: product.id,
        pancakeDisplayId: `ANH-FEEDBACK-${ordinal}`,
        pancakeImageUrls: [url],
        isPresent: true,
        isActive: true,
        pancakeRetailPrice: 0,
        pancakeRetailPriceAfterDiscount: 0,
        syncedAt,
      },
    });
  }
}
