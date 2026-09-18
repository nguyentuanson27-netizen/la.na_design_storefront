import type { MerchantMarketPolicy, MerchantOffer } from "./merchant-offer-mapper.ts";
import { MAX_MERCHANT_FEED_BYTES, MAX_MERCHANT_OFFERS } from "./merchant-feed-limits.ts";
import { BRAND } from "../brand/index.ts";

const encoder = new TextEncoder();

export class MerchantFeedSerializationError extends Error {}
export class MerchantFeedOfferOverflowError extends MerchantFeedSerializationError {}
export class MerchantFeedByteOverflowError extends MerchantFeedSerializationError {}

function assertXmlText(value: string): void {
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const allowed =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!allowed) {
      throw new MerchantFeedSerializationError("Merchant text contains a forbidden XML 1.0 code point");
    }
    offset += codePoint > 0xffff ? 2 : 1;
  }
}

function xml(value: string): string {
  assertXmlText(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

class BoundedXmlWriter {
  readonly #chunks: string[] = [];
  readonly #maxBytes: number;
  #byteLength = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: string): void {
    const chunkBytes = encoder.encode(chunk).byteLength;
    if (this.#byteLength + chunkBytes > this.#maxBytes) {
      throw new MerchantFeedByteOverflowError(
        `Merchant feed exceeds the UTF-8 byte ceiling of ${this.#maxBytes}`,
      );
    }
    this.#chunks.push(chunk);
    this.#byteLength += chunkBytes;
  }

  finish(): Readonly<{ body: string; byteLength: number }> {
    return Object.freeze({ body: this.#chunks.join(""), byteLength: this.#byteLength });
  }
}

function merchantAvailabilityDate(value: string): string {
  // The persisted authority is a Vietnam calendar day. Google Merchant requires date + time +
  // timezone, so serialize that day at local midnight rather than relying on UTC defaults.
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(value);
  if (match === null) {
    throw new MerchantFeedSerializationError("Merchant availability date must be YYYY-MM-DD");
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(asUtc.getTime()) ||
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    throw new MerchantFeedSerializationError("Merchant availability date must be a real calendar day");
  }
  return `${value}T00:00+0700`;
}

export function assertMerchantOfferCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MerchantFeedSerializationError("Merchant offer count must be a non-negative integer");
  }
  if (count > MAX_MERCHANT_OFFERS) {
    throw new MerchantFeedOfferOverflowError(
      `Merchant feed exceeds the offer ceiling of ${MAX_MERCHANT_OFFERS.toLocaleString("en-US")}`,
    );
  }
}

function itemXml(offer: MerchantOffer, market: MerchantMarketPolicy): string {
  const additionalImages = offer.additionalImageLinks
    .map((url) => `<g:additional_image_link>${xml(url)}</g:additional_image_link>\n`)
    .join("");

  return (
    "<item>\n" +
    `<g:id>${xml(offer.id)}</g:id>\n` +
    `<g:item_group_id>${xml(offer.itemGroupId)}</g:item_group_id>\n` +
    `<g:title>${xml(offer.title)}</g:title>\n` +
    `<g:description>${xml(offer.description)}</g:description>\n` +
    `<g:link>${xml(offer.link)}</g:link>\n` +
    `<g:image_link>${xml(offer.imageLink)}</g:image_link>\n` +
    additionalImages +
    `<g:availability>${xml(offer.availability)}</g:availability>\n` +
    // I9 — Google requires `availability_date` beside `backorder` and accepts it nowhere else on
    // this feed, so the element is emitted exactly when the mapper resolved one. ADR 0011 forbids
    // fabricating it, which is why there is no fallback branch here.
    (offer.availabilityDate === null
      ? ""
      : `<g:availability_date>${xml(merchantAvailabilityDate(offer.availabilityDate))}</g:availability_date>\n`) +
    `<g:price>${xml(String(offer.priceVnd))} ${xml(market.currency)}</g:price>\n` +
    `<g:brand>${xml(offer.brand)}</g:brand>\n` +
    `<g:mpn>${xml(offer.mpn)}</g:mpn>\n` +
    `<g:condition>${xml(offer.condition)}</g:condition>\n` +
    `<g:gender>${xml(offer.gender)}</g:gender>\n` +
    `<g:age_group>${xml(offer.ageGroup)}</g:age_group>\n` +
    `<g:color>${xml(offer.color)}</g:color>\n` +
    `<g:size>${xml(offer.size)}</g:size>\n` +
    "</item>\n"
  );
}

export function serializeMerchantFeed({
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
  assertMerchantOfferCount(offers.length);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MERCHANT_FEED_BYTES) {
    throw new MerchantFeedSerializationError("Merchant byte ceiling must be a positive bounded integer");
  }

  const ordered = [...offers].sort(
    (left, right) =>
      left.id.localeCompare(right.id, "en") || left.itemGroupId.localeCompare(right.itemGroupId, "en"),
  );
  const writer = new BoundedXmlWriter(maxBytes);
  writer.append('<?xml version="1.0" encoding="UTF-8"?>\n');
  writer.append('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>\n');
  writer.append(`<title>${xml(BRAND.merchant.feedBrand)} Google Merchant Feed</title>\n`);
  writer.append(`<link>${xml(origin)}</link>\n`);
  writer.append(`<description>${xml(BRAND.merchant.feedBrand)} product data</description>\n`);

  for (const offer of ordered) {
    const nextItem = itemXml(offer, market);
    // The next complete item is measured before it becomes part of the retained output.
    writer.append(nextItem);
  }
  writer.append("</channel></rss>\n");

  return Object.freeze({ ...writer.finish(), offerCount: offers.length });
}
