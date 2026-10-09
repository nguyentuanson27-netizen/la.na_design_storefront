/**
 * Parent-level product feed for Google Merchant Center and Meta Commerce Manager (Facebook Catalog).
 *
 * Maps one catalog item per Pancake product rather than per variation/SKU.
 * Eliminates variation-level blockers (such as missing variation colors and composite combo deferrals)
 * so that all active storefront products can be published reliably to Google Shopping and Meta Catalog.
 */
import { BRAND } from "../brand/index.ts";
import {
  BoundedXmlWriter,
  MerchantFeedSerializationError,
  assertMerchantOfferCount,
  xml,
} from "./merchant-feed-serializer.ts";
import {
  classifyExternalIdentifier,
  classifyMerchantText,
} from "./merchant-identity-audit.ts";
import { MAX_MERCHANT_FEED_BYTES } from "./merchant-feed-limits.ts";
import {
  type MerchantCandidateProduct,
  type MerchantMarketPolicy,
} from "./merchant-offer-mapper.ts";
import {
  resolveEffectiveApparelFacts,
  MERCHANT_SHOP_APPAREL_DEFAULTS,
  type MerchantGender,
  type MerchantAgeGroup,
} from "./merchant-apparel-facts.ts";

export const PRODUCT_ID_MAX_LENGTH = 100;
export const MERCHANT_TITLE_MAX_LENGTH = 150;
export const MERCHANT_DESCRIPTION_MAX_LENGTH = 5_000;
const CANONICAL_PRODUCT_PATH = /^\/shop\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ParentFeedAvailability = "in_stock" | "out_of_stock" | "backorder";
export type FacebookAvailability = "in stock" | "out of stock" | "available for order";

export type MerchantParentFeedItem = Readonly<{
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: readonly string[];
  availability: ParentFeedAvailability;
  priceVnd: number;
  brand: string;
  condition: "new" | "refurbished" | "used";
  gender: MerchantGender;
  ageGroup: MerchantAgeGroup;
}>;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function resolveBoundedMerchantText(value: string | null, maxLength: number): string | null {
  if (classifyMerchantText(value) !== "READY" || value === null) return null;
  return codePointLength(value) <= maxLength ? value : null;
}

function isMerchantIdentifier(
  value: string | null,
  maxLength: number,
  allowWhitespace: boolean,
): value is string {
  return classifyExternalIdentifier(value, { maxLength, allowWhitespace }) === "PRESENT";
}

/**
 * Builds parent feed items from raw candidate products.
 *
 * Implements Option B: Uses editorial published description when available,
 * otherwise provides an approved brand default fallback description so products are not withheld.
 */
export function buildMerchantParentItems(
  products: readonly MerchantCandidateProduct[],
  origin: string,
): readonly MerchantParentFeedItem[] {
  const trustedOrigin = new URL(origin);
  const items: MerchantParentFeedItem[] = [];

  for (const product of products) {
    const id = product.pancakeProductId?.trim();
    if (!id || !isMerchantIdentifier(id, PRODUCT_ID_MAX_LENGTH, false)) {
      continue;
    }

    const title = resolveBoundedMerchantText(product.name, MERCHANT_TITLE_MAX_LENGTH);
    if (title === null) continue;

    const slug = product.slug?.trim();
    if (!slug) continue;
    const path = `/shop/${slug}`;
    if (!CANONICAL_PRODUCT_PATH.test(path)) continue;
    const link = new URL(path, trustedOrigin).href;

    const imageLink = product.media.primary?.url ?? null;
    if (imageLink === null) continue;

    const additionalImageLinks = product.media.gallery
      .slice(1, 11)
      .map((img) => img.url)
      .filter((url) => url !== imageLink);

    // Resolve price across relevant options (preferring parent set options for composite)
    const options = product.projection.options;
    const relevantOptions =
      product.projection.mode === "composite"
        ? options.filter((o) => o.kindKey === "parent" || o.kindKey === null)
        : options;
    const candidateOptions = relevantOptions.length > 0 ? relevantOptions : options;

    const prices = candidateOptions
      .map((o) => o.price)
      .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);

    if (prices.length === 0) continue;
    const priceVnd = Math.min(...prices);

    // Resolve availability
    let availability: ParentFeedAvailability = "out_of_stock";
    for (const opt of candidateOptions) {
      if (opt.purchasable && opt.availability.published && opt.availability.merchant === "in_stock") {
        availability = "in_stock";
        break;
      }
      if (opt.purchasable && opt.availability.published && opt.availability.merchant === "backorder") {
        availability = "backorder";
      }
    }

    // Option B description: published editorial description if present, else brand fallback
    const rawDesc = product.publishedDescription?.trim();
    const fallbackDesc = `${title} — Thiết kế cao cấp độc quyền từ thương hiệu ${BRAND.merchant.feedBrand}.`;
    const resolvedDesc =
      rawDesc && rawDesc.length > 0
        ? resolveBoundedMerchantText(rawDesc, MERCHANT_DESCRIPTION_MAX_LENGTH) ?? fallbackDesc
        : fallbackDesc;

    const description = resolveBoundedMerchantText(resolvedDesc, MERCHANT_DESCRIPTION_MAX_LENGTH);
    if (description === null) continue;

    const apparel = resolveEffectiveApparelFacts(product.apparelOverrides);
    const gender = apparel.ok ? apparel.facts.gender : MERCHANT_SHOP_APPAREL_DEFAULTS.gender;
    const ageGroup = apparel.ok ? apparel.facts.ageGroup : MERCHANT_SHOP_APPAREL_DEFAULTS.ageGroup;
    const condition = apparel.ok ? apparel.facts.condition : MERCHANT_SHOP_APPAREL_DEFAULTS.condition;

    items.push(
      Object.freeze({
        id,
        title,
        description,
        link,
        imageLink,
        additionalImageLinks: Object.freeze(additionalImageLinks),
        availability,
        priceVnd,
        brand: BRAND.merchant.feedBrand,
        condition,
        gender,
        ageGroup,
      }),
    );
  }

  assertMerchantOfferCount(items.length);
  return Object.freeze(items.sort((a, b) => a.id.localeCompare(b.id, "en")));
}

/**
 * Serializes parent items into Google Merchant Center RSS 2.0 XML.
 */
export function serializeGoogleMerchantParentFeed({
  items,
  market,
  origin,
  maxBytes = MAX_MERCHANT_FEED_BYTES,
}: Readonly<{
  items: readonly MerchantParentFeedItem[];
  market: MerchantMarketPolicy;
  origin: string;
  maxBytes?: number;
}>): Readonly<{ body: string; byteLength: number; offerCount: number }> {
  assertMerchantOfferCount(items.length);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MERCHANT_FEED_BYTES) {
    throw new MerchantFeedSerializationError("Merchant byte ceiling must be a positive bounded integer");
  }

  const writer = new BoundedXmlWriter(maxBytes);
  writer.append('<?xml version="1.0" encoding="UTF-8"?>\n');
  writer.append('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>\n');
  writer.append(`<title>${xml(BRAND.merchant.feedBrand)} Google Merchant Feed</title>\n`);
  writer.append(`<link>${xml(origin)}</link>\n`);
  writer.append(`<description>${xml(BRAND.merchant.feedBrand)} product data</description>\n`);

  for (const item of items) {
    const additionalImages = item.additionalImageLinks
      .map((url) => `<g:additional_image_link>${xml(url)}</g:additional_image_link>\n`)
      .join("");

    writer.append(
      "<item>\n" +
      `<g:id>${xml(item.id)}</g:id>\n` +
      `<g:title>${xml(item.title)}</g:title>\n` +
      `<g:description>${xml(item.description)}</g:description>\n` +
      `<g:link>${xml(item.link)}</g:link>\n` +
      `<g:image_link>${xml(item.imageLink)}</g:image_link>\n` +
      additionalImages +
      `<g:availability>${xml(item.availability)}</g:availability>\n` +
      `<g:price>${xml(String(item.priceVnd))} ${xml(market.currency)}</g:price>\n` +
      `<g:brand>${xml(item.brand)}</g:brand>\n` +
      `<g:condition>${xml(item.condition)}</g:condition>\n` +
      `<g:gender>${xml(item.gender)}</g:gender>\n` +
      `<g:age_group>${xml(item.ageGroup)}</g:age_group>\n` +
      "</item>\n",
    );
  }
  writer.append("</channel></rss>\n");
  return Object.freeze({ ...writer.finish(), offerCount: items.length });
}

/**
 * Serializes parent items into Facebook Catalog / Live RSS 2.0 XML.
 */
export function serializeFacebookParentFeed({
  items,
  market,
  origin,
  maxBytes = MAX_MERCHANT_FEED_BYTES,
}: Readonly<{
  items: readonly MerchantParentFeedItem[];
  market: MerchantMarketPolicy;
  origin: string;
  maxBytes?: number;
}>): Readonly<{ body: string; byteLength: number; offerCount: number }> {
  assertMerchantOfferCount(items.length);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MERCHANT_FEED_BYTES) {
    throw new MerchantFeedSerializationError("Facebook feed byte ceiling must be a positive bounded integer");
  }

  const writer = new BoundedXmlWriter(maxBytes);
  writer.append('<?xml version="1.0" encoding="UTF-8"?>\n');
  writer.append('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>\n');
  writer.append(`<title>${xml(BRAND.merchant.feedBrand)} Facebook Live Catalog</title>\n`);
  writer.append(`<link>${xml(origin)}</link>\n`);
  writer.append(`<description>${xml(BRAND.merchant.feedBrand)} livestream products</description>\n`);

  for (const item of items) {
    const metaAvailability: FacebookAvailability =
      item.availability === "in_stock"
        ? "in stock"
        : item.availability === "backorder"
          ? "available for order"
          : "out of stock";

    const additionalImages = item.additionalImageLinks
      .map((url) => `<g:additional_image_link>${xml(url)}</g:additional_image_link>\n`)
      .join("");

    writer.append(
      "<item>\n" +
      `<g:id>${xml(item.id)}</g:id>\n` +
      `<g:title>${xml(item.title)}</g:title>\n` +
      `<g:description>${xml(item.description)}</g:description>\n` +
      `<g:link>${xml(item.link)}</g:link>\n` +
      `<g:image_link>${xml(item.imageLink)}</g:image_link>\n` +
      additionalImages +
      `<g:availability>${xml(metaAvailability)}</g:availability>\n` +
      `<g:price>${xml(String(item.priceVnd))} ${xml(market.currency)}</g:price>\n` +
      `<g:brand>${xml(item.brand)}</g:brand>\n` +
      `<g:condition>${xml(item.condition)}</g:condition>\n` +
      `<g:gender>${xml(item.gender)}</g:gender>\n` +
      `<g:age_group>${xml(item.ageGroup)}</g:age_group>\n` +
      "</item>\n",
    );
  }
  writer.append("</channel></rss>\n");
  return Object.freeze({ ...writer.finish(), offerCount: items.length });
}
