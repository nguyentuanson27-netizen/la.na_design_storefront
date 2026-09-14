import type { Metadata } from "next";
import { connection } from "next/server";

import { getConfiguredStorefrontProductBySlug } from "@/commerce/storefront-catalog-runtime";
import { buildStorefrontProductMetadata } from "@/seo/product-metadata";
import { readSearchExposure } from "@/seo/search-exposure";

/**
 * The product page's metadata, declared in the layout because it needs the product before it can
 * build a title -- the one route whose metadata does not live on the page.
 *
 * A slug that is malformed or unknown yields empty metadata rather than throwing: the page itself
 * answers with `notFound()`, and metadata is not the place to decide a route's status.
 */

export type ProductMetadataProps = Readonly<{ params: Promise<{ slug: string }> }>;

export async function buildProductMetadata({ params }: ProductMetadataProps): Promise<Metadata> {
  await connection();
  const { slug } = await params;

  let product: Awaited<ReturnType<typeof getConfiguredStorefrontProductBySlug>>;
  try {
    product = await getConfiguredStorefrontProductBySlug(slug);
  } catch (error) {
    if (error instanceof RangeError) return {};
    throw error;
  }

  if (!product) return {};

  const exposure = readSearchExposure();
  return buildStorefrontProductMetadata({
    origin: exposure.origin,
    indexingEnabled: exposure.indexingEnabled,
    product,
  });
}
