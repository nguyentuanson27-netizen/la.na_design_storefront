import type { Metadata } from "next";

import {
  SITE_LOCALE,
  SITE_NAME,
  SOCIAL_FALLBACK_ALT,
  SOCIAL_FALLBACK_PATH,
} from "./social-identity.ts";
import { BRAND } from "../brand/index.ts";

/**
 * Kept as a named export because the product metadata HTTP smoke imports it from here. The value
 * itself now comes from the shared social identity, so the PDP card and the root fallback cannot
 * drift apart.
 */
export const PRODUCT_SOCIAL_FALLBACK_PATH = SOCIAL_FALLBACK_PATH;

type ProductMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
  product: Readonly<{
    slug: string;
    name: string;
    seoTitle: string | null;
    seoDescription: string | null;
    media: Readonly<{
      primary: Readonly<{
        url: string;
        alt: string;
      }> | null;
    }>;
  }>;
}>;

function buildProductTitle(product: ProductMetadataInput["product"]): string {
  return `${product.seoTitle ?? product.name} — ${product.slug}`;
}

function buildProductDescription(product: ProductMetadataInput["product"]): string {
  if (product.seoDescription) {
    return `${product.seoDescription} — /shop/${product.slug}.`;
  }

  return `Thông tin sản phẩm ${product.name} tại ${BRAND.identity.name} — /shop/${product.slug}.`;
}

export function buildStorefrontProductMetadata({
  origin,
  indexingEnabled,
  product,
}: ProductMetadataInput): Metadata {
  const title = buildProductTitle(product);
  const description = buildProductDescription(product);
  const productUrl = new URL(`/shop/${product.slug}`, origin).href;
  const image = product.media.primary
    ? {
        url: product.media.primary.url,
        alt: product.media.primary.alt,
      }
    : {
        url: new URL(PRODUCT_SOCIAL_FALLBACK_PATH, origin).href,
        alt: SOCIAL_FALLBACK_ALT,
      };

  return {
    title,
    description,
    alternates: indexingEnabled ? { canonical: productUrl } : undefined,
    openGraph: {
      type: "website",
      locale: SITE_LOCALE,
      siteName: SITE_NAME,
      title,
      description,
      url: productUrl,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
