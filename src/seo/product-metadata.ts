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

/**
 * Cap the total number of images emitted in Open Graph tags.
 * The primary hero image is always first (index 0), followed by up to 7 gallery images (total 8),
 * avoiding metadata bloat while giving social scrapers (e.g. Meta Ads creative highlighting)
 * a rich multi-angle album of the product.
 */
export const MAX_OPEN_GRAPH_IMAGES = 8;

type ProductMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
  product: Readonly<{
    slug: string;
    name: string;
    /** The Pancake product code ("SV605"), when the product has one. */
    productCode?: string | null;
    seoTitle: string | null;
    seoDescription: string | null;
    media: Readonly<{
      primary: Readonly<{
        url: string;
        alt: string;
      }> | null;
      gallery?: readonly Readonly<{
        url: string;
        alt: string;
      }>[];
    }>;
  }>;
}>;

/**
 * An editor often types the brand into the SEO title ("... | La.na Design"), and the site title
 * template appends it again, so the result read "... | La.na Design — La.na Design". Only a
 * trailing brand is removed; a brand name inside the title is part of the copy and stays.
 */
function withoutTrailingBrand(title: string): string {
  const brand = BRAND.identity.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`\\s*[|·–—-]\\s*${brand}\\s*$`, "iu"), "").trim();
}

function cleanProductCode(product: ProductMetadataInput["product"]): string | null {
  const code = product.productCode?.normalize("NFC").trim();
  return code && code.length > 0 ? code : null;
}

/**
 * What keeps two products with the same copy apart. The product code is short, readable in a search
 * result and, unlike the slug (which ends in a content hash), something a shopper recognises. A
 * product without one keeps the slug, which is unique by construction, so no product ever loses its
 * discriminator: see docs/audits/seo-metadata-uniqueness-w2a.md.
 */
function buildProductTitle(product: ProductMetadataInput["product"]): string {
  const base = withoutTrailingBrand(product.seoTitle ?? product.name);
  const code = cleanProductCode(product);
  if (code === null) return `${base} — ${product.slug}`;
  // Published copy usually carries the code already ("Set Váy SV605 ..."); never say it twice.
  return base.toLowerCase().includes(code.toLowerCase()) ? base : `${base} ${code}`;
}

function buildProductDescription(product: ProductMetadataInput["product"]): string {
  const code = cleanProductCode(product);
  // Without a code the path is still the discriminator, as before.
  const path = code === null ? ` — /shop/${product.slug}.` : "";
  if (product.seoDescription) return `${product.seoDescription}${path}`;

  const named = code === null ? product.name : `${product.name} (mã ${code})`;
  return `Thông tin sản phẩm ${named} tại ${BRAND.identity.name}${path || "."}`;
}

export function buildStorefrontProductMetadata({
  origin,
  indexingEnabled,
  product,
}: ProductMetadataInput): Metadata {
  const title = buildProductTitle(product);
  const description = buildProductDescription(product);
  const productUrl = new URL(`/shop/${product.slug}`, origin).href;

  const images: Array<{ url: string; alt: string }> = [];
  if (product.media.primary) {
    images.push({
      url: product.media.primary.url,
      alt: product.media.primary.alt,
    });
  }

  if (product.media.gallery) {
    for (const item of product.media.gallery) {
      if (images.length >= MAX_OPEN_GRAPH_IMAGES) break;
      if (!images.some((existing) => existing.url === item.url)) {
        images.push({
          url: item.url,
          alt: item.alt,
        });
      }
    }
  }

  const primaryOrFallbackImage =
    images[0] ?? {
      url: new URL(PRODUCT_SOCIAL_FALLBACK_PATH, origin).href,
      alt: SOCIAL_FALLBACK_ALT,
    };

  const openGraphImages = images.length > 0 ? images : [primaryOrFallbackImage];

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
      images: openGraphImages,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [primaryOrFallbackImage],
    },
  };
}
