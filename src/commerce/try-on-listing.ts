import { prisma } from "../db/prisma.ts";
import { readTryOnRuntimeConfig } from "../integrations/try-on/config.ts";
import type { StorefrontProductMedia } from "./product-media.ts";
import { resolveTryOnEligibility } from "./try-on-eligibility.ts";

/**
 * Which of the products on a listing page offer virtual try-on, so a card can carry the small mark
 * (amendment 2026-11-09).
 *
 * The same authority the product page uses — `resolveTryOnEligibility` over the product's category
 * membership and first trusted photograph — asked once for the whole page with a single query
 * instead of once per card. It is decided on the server so the browser learns no rule, and it is a
 * presentation hint only: the product page and the endpoint decide again, from their own reads.
 *
 * Never throws and never blocks a listing: with the kill switch off it returns before touching the
 * database, and any failure reading membership simply shows no marks.
 */
export async function resolveTryOnListingSlugs(
  products: readonly Readonly<{ id: string; slug: string; media?: StorefrontProductMedia | null }>[],
): Promise<ReadonlySet<string>> {
  const none: ReadonlySet<string> = new Set();
  if (products.length === 0) return none;
  try {
    if (!readTryOnRuntimeConfig().available) return none;
    const candidates = products.filter(
      (product): product is typeof product & { media: StorefrontProductMedia } =>
        product.media !== null && product.media !== undefined,
    );
    if (candidates.length === 0) return none;

    const rows = await prisma.productCategoryMembership.findMany({
      where: { productId: { in: candidates.map((product) => product.id) } },
      select: { productId: true, categoryKey: true },
    });
    const keysByProduct = new Map<string, string[]>();
    for (const row of rows) {
      const keys = keysByProduct.get(row.productId);
      if (keys) keys.push(row.categoryKey);
      else keysByProduct.set(row.productId, [row.categoryKey]);
    }

    const eligible = new Set<string>();
    for (const product of candidates) {
      const eligibility = resolveTryOnEligibility({
        categoryKeys: keysByProduct.get(product.id) ?? [],
        media: product.media,
      });
      if (eligibility.eligible) eligible.add(product.slug);
    }
    return eligible;
  } catch {
    return none;
  }
}
