import { parseTrustedProductImageUrl } from "./product-media.ts";

/**
 * Customer reviews the shop enters by hand from real feedback (Zalo, Messenger, Facebook, in
 * person), and how the storefront reads them.
 *
 * Pure and storage-free, so every rule here is testable without a database:
 *
 * - what an admin may save (`parseProductReviewInput`): a star count in 1..5, a display name that is
 *   not a phone number, trusted Pancake CDN photographs only, a review date that is not in the
 *   future, and the admin's statement that the customer agreed to publication;
 * - what the page may say about them (`summarizeProductReviews`): the average is computed from the
 *   rows, never typed, and the summary stays hidden until there are enough reviews to mean
 *   something;
 * - how a row is worded (`buildProductReviewView`): where it came from, and "Đã mua hàng" only when
 *   the review is linked to a confirmed order.
 */

export const PRODUCT_REVIEW_LIMITS = Object.freeze({
  authorName: 40,
  body: 1200,
  shopReply: 600,
  label: 40,
  orderPublicCode: 64,
  images: 6,
});

/**
 * Fewer reviews than this show each review but no average, histogram or size breakdown: four
 * friendly reviews would otherwise read as a precise "5,0 / 5".
 */
export const MIN_REVIEWS_FOR_SUMMARY = 5;

/** Reviews rendered on the product page; the summary still counts every published one. */
export const PRODUCT_REVIEW_PAGE_LIMIT = 50;

/** Review photographs offered as the product's own customer photographs, newest review first. */
export const PRODUCT_REVIEW_PHOTO_LIMIT = 12;

/** A photograph strip under the price needs at least this many photographs to look earned. */
export const MIN_REVIEW_PHOTOS_FOR_STRIP = 3;

export const PRODUCT_REVIEW_SOURCES = ["ZALO", "MESSENGER", "FACEBOOK", "DIRECT"] as const;
export type ProductReviewSourceKey = (typeof PRODUCT_REVIEW_SOURCES)[number];

export const PRODUCT_REVIEW_FITS = ["SMALL", "TRUE_TO_SIZE", "LARGE"] as const;
export type ProductReviewFitKey = (typeof PRODUCT_REVIEW_FITS)[number];

export const PRODUCT_REVIEW_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type ProductReviewStatusKey = (typeof PRODUCT_REVIEW_STATUSES)[number];

export const PRODUCT_REVIEW_SOURCE_LABELS: Readonly<Record<ProductReviewSourceKey, string>> = Object.freeze({
  ZALO: "Gửi qua Zalo",
  MESSENGER: "Gửi qua Messenger",
  FACEBOOK: "Bình luận trên Facebook",
  DIRECT: "Gửi trực tiếp cho shop",
});

export const PRODUCT_REVIEW_FIT_LABELS: Readonly<Record<ProductReviewFitKey, string>> = Object.freeze({
  SMALL: "Hơi chật",
  TRUE_TO_SIZE: "Vừa vặn",
  LARGE: "Hơi rộng",
});

/** A value an admin form may hand the domain: anything, because `FormData` is untrusted text. */
type RawFields = Readonly<Record<string, unknown>>;

export type ProductReviewValue = Readonly<{
  status: ProductReviewStatusKey;
  rating: number;
  authorName: string;
  body: string | null;
  source: ProductReviewSourceKey;
  fit: ProductReviewFitKey | null;
  sizeLabel: string | null;
  colorLabel: string | null;
  heightCm: number | null;
  weightKg: number | null;
  imageUrls: readonly string[];
  orderPublicCode: string | null;
  shopReply: string | null;
  reviewedAt: Date;
}>;

export type ProductReviewInputField =
  | "rating"
  | "authorName"
  | "body"
  | "source"
  | "fit"
  | "sizeLabel"
  | "colorLabel"
  | "heightCm"
  | "weightKg"
  | "imageUrls"
  | "orderPublicCode"
  | "shopReply"
  | "reviewedAt"
  | "consent"
  | "status"
  | "content";

export type ProductReviewInputResult =
  | Readonly<{ ok: true; value: ProductReviewValue }>
  | Readonly<{ ok: false; field: ProductReviewInputField }>;

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** `null` for an empty field, `undefined` for one over its limit. */
function optionalText(raw: unknown, maxLength: number): string | null | undefined {
  const value = text(raw);
  if (value.length === 0) return null;
  return value.length > maxLength ? undefined : value;
}

function optionalInteger(raw: unknown, min: number, max: number): number | null | undefined {
  const value = text(raw);
  if (value.length === 0) return null;
  if (!/^[0-9]{1,4}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  const value = text(raw);
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const NAME_WORD = /^\p{L}[\p{L}'’-]*$/u;
const NAME_INITIAL = /^\p{L}\.?$/u;

/**
 * The form a review's display name must take: a given name, or one or two words and the initial of
 * the family name ("Lan", "Lan A.", "Thu Hà T."). `null` when it is anything else.
 *
 * Reviews print the name as stored, so the shop's rule is enforced here and not left to the form's
 * hint: a full name such as "Nguyen Thi Mai" (the last word is not an initial), a phone number, an
 * e-mail address, digits or brackets are all refused. A bare initial is normalised to carry its
 * period ("Lan A" becomes "Lan A.").
 */
export function normalizeReviewAuthorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > PRODUCT_REVIEW_LIMITS.authorName) return null;

  const words = name.split(" ");
  if (words.length > 3) return null;

  if (words.length === 1) {
    // A given name alone; a lone initial says nothing.
    const only = words[0]!;
    return NAME_WORD.test(only) && Array.from(only).length >= 2 ? only : null;
  }

  const initial = words[words.length - 1]!;
  const given = words.slice(0, -1);
  if (!NAME_INITIAL.test(initial)) return null;
  if (!given.every((word) => NAME_WORD.test(word) && Array.from(word).length >= 2)) return null;
  const letter = Array.from(initial)[0]!.toLocaleUpperCase("vi");
  return `${given.join(" ")} ${letter}.`;
}

export function isSafeReviewAuthorName(name: string): boolean {
  return normalizeReviewAuthorName(name) !== null;
}

/** Today's calendar date in Vietnam (UTC+7, no daylight saving) as `YYYY-MM-DD`. */
export function vietnamToday(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` as the shop's local noon (Vietnam, UTC+7), so the printed day never shifts. A day
 * after today in Vietnam is refused by comparing calendar dates, not instants: an instant test
 * lets tomorrow through in the evening, when noon tomorrow is under a day away.
 */
export function parseReviewDate(raw: unknown, now: Date): Date | null {
  const value = text(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day, 5, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  if (year < 2020) return null;
  return value > vietnamToday(now) ? null : date;
}

function parseImageUrls(raw: unknown): readonly string[] | null {
  const lines = text(raw)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const urls: string[] = [];
  for (const line of lines) {
    const trusted = parseTrustedProductImageUrl(line);
    // A present but untrusted link is a refusal, not a silent drop: dropping it would hide the typo.
    if (trusted === null) return null;
    if (!urls.includes(trusted)) urls.push(trusted);
  }
  return urls.length > PRODUCT_REVIEW_LIMITS.images ? null : urls;
}

export function parseProductReviewInput(raw: RawFields, now: Date): ProductReviewInputResult {
  const fail = (field: ProductReviewInputField): ProductReviewInputResult => ({ ok: false, field });

  const rating = optionalInteger(raw.rating, 1, 5);
  if (rating === null || rating === undefined) return fail("rating");

  const authorName = normalizeReviewAuthorName(raw.authorName);
  if (authorName === null) return fail("authorName");

  const body = optionalText(raw.body, PRODUCT_REVIEW_LIMITS.body);
  if (body === undefined) return fail("body");

  const source = oneOf(raw.source, PRODUCT_REVIEW_SOURCES);
  if (source === null) return fail("source");

  const fitText = text(raw.fit);
  const fit = fitText.length === 0 ? null : oneOf(fitText, PRODUCT_REVIEW_FITS);
  if (fitText.length > 0 && fit === null) return fail("fit");

  const sizeLabel = optionalText(raw.sizeLabel, PRODUCT_REVIEW_LIMITS.label);
  if (sizeLabel === undefined) return fail("sizeLabel");
  const colorLabel = optionalText(raw.colorLabel, PRODUCT_REVIEW_LIMITS.label);
  if (colorLabel === undefined) return fail("colorLabel");

  const heightCm = optionalInteger(raw.heightCm, 100, 220);
  if (heightCm === undefined) return fail("heightCm");
  const weightKg = optionalInteger(raw.weightKg, 25, 200);
  if (weightKg === undefined) return fail("weightKg");

  const imageUrls = parseImageUrls(raw.imageUrls);
  if (imageUrls === null) return fail("imageUrls");

  // A review with neither words nor a photograph is just a number, which proves nothing.
  if (body === null && imageUrls.length === 0) return fail("content");

  const orderPublicCode = optionalText(raw.orderPublicCode, PRODUCT_REVIEW_LIMITS.orderPublicCode);
  if (orderPublicCode === undefined) return fail("orderPublicCode");

  const shopReply = optionalText(raw.shopReply, PRODUCT_REVIEW_LIMITS.shopReply);
  if (shopReply === undefined) return fail("shopReply");

  const reviewedAt = parseReviewDate(raw.reviewedAt, now);
  if (reviewedAt === null) return fail("reviewedAt");

  const status = oneOf(raw.status, PRODUCT_REVIEW_STATUSES);
  if (status === null) return fail("status");

  // The admin states the customer agreed to publication; nothing is saved without it.
  const consent = text(raw.consent);
  if (consent !== "on" && consent !== "true") return fail("consent");

  return {
    ok: true,
    value: Object.freeze({
      status,
      rating,
      authorName,
      body,
      source,
      fit,
      sizeLabel,
      colorLabel,
      heightCm,
      weightKg,
      imageUrls: Object.freeze(imageUrls),
      orderPublicCode,
      shopReply,
      reviewedAt,
    }),
  };
}

/* ------------------------------------------------------------------------- reading */

export type ProductReviewRow = Readonly<{
  id: string;
  rating: number;
  authorName: string;
  body: string | null;
  source: ProductReviewSourceKey;
  fit: ProductReviewFitKey | null;
  sizeLabel: string | null;
  colorLabel: string | null;
  heightCm: number | null;
  weightKg: number | null;
  imageUrls: readonly string[];
  orderPublicCode: string | null;
  shopReply: string | null;
  reviewedAt: Date;
}>;

export type ProductReviewSummary = Readonly<{
  count: number;
  /** One decimal, computed from the rows. */
  average: number;
  /** Index 0 is five stars, index 4 is one star. */
  distribution: readonly [number, number, number, number, number];
  photoReviewCount: number;
  /** `null` until enough reviewers said how the size fit. */
  fit: Readonly<{ count: number; small: number; trueToSize: number; large: number }> | null;
}>;

/** Counts only: the caller decides, with `MIN_REVIEWS_FOR_SUMMARY`, whether to show them. */
export function summarizeProductReviews(
  rows: readonly Pick<ProductReviewRow, "rating" | "fit" | "imageUrls">[],
): ProductReviewSummary | null {
  if (rows.length === 0) return null;
  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  let photoReviewCount = 0;
  const fit = { count: 0, small: 0, trueToSize: 0, large: 0 };
  for (const row of rows) {
    const stars = Math.min(5, Math.max(1, Math.round(row.rating)));
    distribution[5 - stars] += 1;
    sum += stars;
    if (row.imageUrls.length > 0) photoReviewCount += 1;
    if (row.fit !== null) {
      fit.count += 1;
      if (row.fit === "SMALL") fit.small += 1;
      else if (row.fit === "LARGE") fit.large += 1;
      else fit.trueToSize += 1;
    }
  }
  return Object.freeze({
    count: rows.length,
    average: Math.round((sum / rows.length) * 10) / 10,
    distribution: Object.freeze(distribution) as ProductReviewSummary["distribution"],
    photoReviewCount,
    fit: fit.count >= MIN_REVIEWS_FOR_SUMMARY ? Object.freeze(fit) : null,
  });
}

/** `4.8` as `4,8`, the way the storefront writes decimals. */
export function formatReviewAverage(average: number): string {
  return average.toFixed(1).replace(".", ",");
}

export type ProductReviewView = Readonly<{
  id: string;
  rating: number;
  authorName: string;
  body: string | null;
  /** Where the review reached the shop from, so a reader can tell it from one left on the site. */
  sourceLabel: string;
  /** True only for a review linked to a confirmed order that contains this product. */
  verifiedPurchase: boolean;
  fit: ProductReviewFitKey | null;
  fitLabel: string | null;
  /** "Size M · Hồng phấn · cao 1m60, 52kg", from whatever the reviewer shared. */
  detailLine: string | null;
  images: readonly Readonly<{ src: string; alt: string }>[];
  shopReply: string | null;
  /** `dd/mm/yyyy` in Vietnam time. */
  dateLabel: string;
  reviewedAtIso: string;
}>;

function formatHeight(heightCm: number): string {
  const meters = Math.floor(heightCm / 100);
  const rest = String(heightCm % 100).padStart(2, "0");
  return `cao ${meters}m${rest}`;
}

export function formatReviewDate(date: Date): string {
  // UTC+7, no daylight saving: add seven hours and read the UTC fields.
  const local = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${local.getUTCFullYear()}`;
}

export function buildProductReviewView(row: ProductReviewRow): ProductReviewView {
  const body: string[] = [];
  if (row.heightCm !== null) body.push(formatHeight(row.heightCm));
  if (row.weightKg !== null) body.push(`${row.weightKg}kg`);
  const detail = [
    row.sizeLabel === null ? null : `Size ${row.sizeLabel}`,
    row.colorLabel,
    body.length > 0 ? body.join(", ") : null,
  ].filter((part): part is string => part !== null);

  return Object.freeze({
    id: row.id,
    rating: row.rating,
    authorName: row.authorName,
    body: row.body,
    sourceLabel: PRODUCT_REVIEW_SOURCE_LABELS[row.source],
    verifiedPurchase: row.orderPublicCode !== null,
    fit: row.fit,
    fitLabel: row.fit === null ? null : PRODUCT_REVIEW_FIT_LABELS[row.fit],
    detailLine: detail.length > 0 ? detail.join(" · ") : null,
    images: Object.freeze(
      row.imageUrls.map((src) => Object.freeze({ src, alt: `Ảnh trong đánh giá của ${row.authorName}` })),
    ),
    shopReply: row.shopReply,
    dateLabel: formatReviewDate(row.reviewedAt),
    reviewedAtIso: row.reviewedAt.toISOString(),
  });
}

/** What the product page renders; `null` summary means "too few reviews to average". */
export type ProductReviewSection = Readonly<{
  /** Published reviews, all of them. */
  count: number;
  summary: ProductReviewSummary | null;
  items: readonly ProductReviewView[];
  /** The product's own customer photographs, newest review first, for the rail and the strip. */
  photos: readonly Readonly<{ src: string; alt: string }>[];
  photoCount: number;
}>;

/**
 * The section from published rows, already ordered newest first. Returns `null` for a product with
 * no published review, so the page renders nothing rather than an empty "Đánh giá" heading.
 */
export function buildProductReviewSection(
  rows: readonly ProductReviewRow[],
): ProductReviewSection | null {
  if (rows.length === 0) return null;
  const summary = summarizeProductReviews(rows);
  const views = rows.map(buildProductReviewView);
  const allPhotos = views.flatMap((view) => view.images);
  return Object.freeze({
    count: rows.length,
    summary: summary !== null && summary.count >= MIN_REVIEWS_FOR_SUMMARY ? summary : null,
    items: Object.freeze(views.slice(0, PRODUCT_REVIEW_PAGE_LIMIT)),
    photos: Object.freeze(allPhotos.slice(0, PRODUCT_REVIEW_PHOTO_LIMIT)),
    photoCount: allPhotos.length,
  });
}
