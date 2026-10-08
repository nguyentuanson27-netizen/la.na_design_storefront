/**
 * Livestream catalog projection. One Pancake product is one Meta catalog item, regardless of
 * how many size/colour variants the canonical Merchant mapper validated.
 *
 * The Google Merchant offer mapper remains the fact authority; this module only collapses its
 * reviewed offers for a separate link-out catalog. It does not alter per-variant commerce rules.
 */
import type { MerchantMarketPolicy, MerchantOffer } from "./merchant-offer-mapper.ts";
import {
  BoundedXmlWriter,
  MerchantFeedOfferOverflowError,
  MerchantFeedSerializationError,
  assertMerchantOfferCount,
  xml,
} from "./merchant-feed-serializer.ts";
import { MAX_MERCHANT_CANDIDATE_VARIANTS, MAX_MERCHANT_FEED_BYTES } from "./merchant-feed-limits.ts";
import { BRAND } from "../brand/index.ts";

export type FacebookLiveAvailability = "in stock" | "available for order" | "out of stock";

export type FacebookLiveItem = Readonly<{
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: readonly string[];
  availability: FacebookLiveAvailability;
  priceVnd: number;
  brand: MerchantOffer["brand"];
  condition: MerchantOffer["condition"];
  gender: MerchantOffer["gender"];
  ageGroup: MerchantOffer["ageGroup"];
}>;

const PRODUCT_ID_MAX_LENGTH = 100; // Meta catalog field limit.
const CANONICAL_PRODUCT_PATH = /^\/shop\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function canonicalProductLink(offer: MerchantOffer, origin: URL): string | null {
  try {
    const url = new URL(offer.link);
    // The trusted Merchant mapper emits exactly one U12 variant query. Do not turn an unrelated
    // URL, path or injected query into a parent catalog destination.
    if (
      url.origin !== origin.origin ||
      !CANONICAL_PRODUCT_PATH.test(url.pathname) ||
      url.hash !== "" ||
      url.searchParams.size !== 1 ||
      url.searchParams.get("variant") !== offer.id
    ) {
      return null;
    }
    return new URL(url.pathname, origin).href;
  } catch {
    return null;
  }
}

function orderRank(availability: MerchantOffer["availability"]): number {
  switch (availability) {
    case "in_stock": return 0;
    case "backorder": return 1;
    case "out_of_stock": return 2;
  }
}

/** Pure projection; missing/ambiguous parent facts are withheld rather than guessed. */
export function buildFacebookLiveItems(
  offers: readonly MerchantOffer[],
  origin: string,
): readonly FacebookLiveItem[] {
  // A 7,000-variation catalog can collapse to fewer than 5,000 Live parent items.
  // Enforce the input candidate cap here; the output offer cap is checked after grouping.
  if (offers.length > MAX_MERCHANT_CANDIDATE_VARIANTS) {
    throw new MerchantFeedOfferOverflowError(
      `Facebook Live feed exceeds the ${MAX_MERCHANT_CANDIDATE_VARIANTS} source-variant ceiling`,
    );
  }
  const trustedOrigin = new URL(origin);
  const groups = new Map<string, MerchantOffer[]>();

  for (const offer of offers) {
    const id = offer.itemGroupId;
    if (id.length === 0 || id.length > PRODUCT_ID_MAX_LENGTH) continue;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [offer]);
    else group.push(offer);
  }

  const items: FacebookLiveItem[] = [];
  for (const [id, variants] of groups) {
    const links = variants.map((offer) => canonicalProductLink(offer, trustedOrigin));
    const link = links[0];
    const baseline = variants[0]!;
    if (
      link === null ||
      variants.some((offer, index) =>
        links[index] !== link ||
        offer.title !== baseline.title ||
        offer.description !== baseline.description ||
        offer.brand !== baseline.brand ||
        offer.condition !== baseline.condition ||
        offer.gender !== baseline.gender ||
        offer.ageGroup !== baseline.ageGroup
      )
    ) {
      // Same product ID pointing to two different products must not be silently coalesced.
      continue;
    }

    const ranked = [...variants].sort((a, b) =>
      orderRank(a.availability) - orderRank(b.availability) ||
      a.priceVnd - b.priceVnd ||
      a.id.localeCompare(b.id, "en"),
    );
    const chosen = ranked[0]!;
    const availability: FacebookLiveAvailability =
      chosen.availability === "in_stock"
        ? "in stock"
        : chosen.availability === "backorder"
          ? "available for order"
          : "out of stock";

    items.push(Object.freeze({
      id,
      title: chosen.title,
      description: chosen.description,
      link,
      imageLink: chosen.imageLink,
      additionalImageLinks: chosen.additionalImageLinks,
      availability,
      priceVnd: chosen.priceVnd,
      brand: chosen.brand,
      condition: chosen.condition,
      gender: chosen.gender,
      ageGroup: chosen.ageGroup,
    }));
  }

  assertMerchantOfferCount(items.length);
  return Object.freeze(items.sort((a, b) => a.id.localeCompare(b.id, "en")));
}

/** RSS XML for a dedicated Meta Live catalog. No variant-level identity/size claims are emitted. */
export function serializeFacebookLiveFeed({
  offers,
  market,
  origin,
  maxBytes = MAX_MERCHANT_FEED_BYTES,
}: Readonly<{
  offers: readonly MerchantOffer[];
  market: MerchantMarketPolicy;
  origin: string;
  maxBytes?: number;
}>): Readonly<{ body: string; byteLength: number; offerCount: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MERCHANT_FEED_BYTES) {
    throw new MerchantFeedSerializationError("Facebook Live feed byte budget is invalid");
  }

  const items = buildFacebookLiveItems(offers, origin);
  const writer = new BoundedXmlWriter(maxBytes);
  writer.append('<?xml version="1.0" encoding="UTF-8"?>\n');
  writer.append('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>\n');
  writer.append(`<title>${xml(BRAND.merchant.feedBrand)} Facebook Live Catalog</title>\n`);
  writer.append(`<link>${xml(origin)}</link>\n`);
  writer.append(`<description>${xml(BRAND.merchant.feedBrand)} livestream products</description>\n`);

  for (const item of items) {
    writer.append(
      "<item>\n" +
      `<g:id>${xml(item.id)}</g:id>\n` +
      `<g:title>${xml(item.title)}</g:title>\n` +
      `<g:description>${xml(item.description)}</g:description>\n` +
      `<g:link>${xml(item.link)}</g:link>\n` +
      `<g:image_link>${xml(item.imageLink)}</g:image_link>\n` +
      item.additionalImageLinks
        .map((url) => `<g:additional_image_link>${xml(url)}</g:additional_image_link>\n`)
        .join("") +
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
