/**
 * Fail-closed validation for the website-owned merchandising writes (ADR 0013 §3, §5, §6, §7).
 *
 * Every admin submission is parsed here before any database access, the same way
 * `parseCategoryMembership()` already guards §4.6. Nothing in this module touches Prisma, so the
 * rules can be tested exhaustively without a database and cannot drift between call sites.
 *
 * Three of the four surfaces — homepage Featured, category PLP order, related-product overrides —
 * are the *same* shape: a bounded, duplicate-free, ordered list of products whose index becomes a
 * `position`. They share one parser rather than three near-identical ones, because three copies is
 * how the bound on one of them quietly stops matching the others.
 */

import {
  categoryByKey,
  type CategoryKey,
} from "./category-taxonomy.ts";
import { parseTrustedProductImageUrl } from "./product-media.ts";

/**
 * Master spec §20 does not fix a count, so this is an operational bound rather than an approved
 * fact: it exists to stop an unbounded admin write, not to encode a homepage design.
 */
export const MAX_HOMEPAGE_FEATURED_PRODUCTS = 12;

/** One PLP's manual ranking. Products beyond it fall to the documented tail order (ADR §5). */
export const MAX_CATEGORY_PRODUCT_ORDER = 60;

/** Manual related picks for one product (ADR §7 stage 1). */
export const MAX_RELATED_PRODUCT_OVERRIDES = 8;

/** Product ids are `cuid`s from `ProductMirror.id`; this bounds the string, not its alphabet. */
const MAX_PRODUCT_ID_LENGTH = 64;

export type MerchandisingErrorReason =
  | "merchandising-shape"
  | "merchandising-too-many"
  | "merchandising-invalid-product"
  | "merchandising-duplicate-product"
  | "merchandising-unknown-category"
  | "merchandising-self-reference"
  | "merchandising-invalid-media-url";

export class MerchandisingError extends Error {
  readonly reason: MerchandisingErrorReason;

  constructor(reason: MerchandisingErrorReason) {
    super(reason);
    this.name = "MerchandisingError";
    this.reason = reason;
  }
}

/**
 * A bounded, duplicate-free, ordered list of product ids.
 *
 * The returned order *is* the ranking: callers persist index `i` as `position: i`, 0-based, which is
 * what the `position >= 0` CHECK in the migration expects. Returning ids rather than
 * `{ productId, position }` pairs keeps the position a derived fact with exactly one producer, so a
 * caller cannot invent a gap or a collision the unique index would then reject at runtime.
 *
 * An empty list is valid and means "clear this surface" — not a rejected submission. That matters
 * for homepage Featured in particular: master spec §20 requires an empty selection to render an
 * empty section, never a silent fallback to newest/bestseller logic.
 */
export function parseOrderedProductSelection(
  input: unknown,
  { max }: { max: number },
): readonly string[] {
  if (!Array.isArray(input)) throw new MerchandisingError("merchandising-shape");
  if (input.length > max) throw new MerchandisingError("merchandising-too-many");

  const seen = new Set<string>();
  const productIds: string[] = [];

  for (const candidate of input) {
    if (typeof candidate !== "string") {
      throw new MerchandisingError("merchandising-invalid-product");
    }
    const productId = candidate.trim();
    if (productId.length === 0 || productId.length > MAX_PRODUCT_ID_LENGTH) {
      throw new MerchandisingError("merchandising-invalid-product");
    }
    if (seen.has(productId)) throw new MerchandisingError("merchandising-duplicate-product");
    seen.add(productId);
    productIds.push(productId);
  }

  return Object.freeze(productIds);
}

/** Resolves a submitted category key against the taxonomy, or refuses. */
function requireCategoryKey(candidate: unknown): CategoryKey {
  const node = categoryByKey(candidate);
  if (!node) throw new MerchandisingError("merchandising-unknown-category");
  return node.key;
}

export type HomepageFeaturedSelection = Readonly<{
  productIds: readonly string[];
}>;

export function parseHomepageFeaturedSelection(input: unknown): HomepageFeaturedSelection {
  return Object.freeze({
    productIds: parseOrderedProductSelection(input, { max: MAX_HOMEPAGE_FEATURED_PRODUCTS }),
  });
}

export type CategoryProductOrderSelection = Readonly<{
  categoryKey: CategoryKey;
  productIds: readonly string[];
}>;

/**
 * A category's manual PLP ranking.
 *
 * The category key is validated against the taxonomy here, but membership is **not** checked: that
 * needs the database and belongs to the repository, which validates the ranked set against the
 * category's listing keys inside the same transaction that writes it.
 */
export function parseCategoryProductOrder(input: unknown): CategoryProductOrderSelection {
  if (typeof input !== "object" || input === null) {
    throw new MerchandisingError("merchandising-shape");
  }
  const record = input as Record<string, unknown>;

  return Object.freeze({
    categoryKey: requireCategoryKey(record.categoryKey),
    productIds: parseOrderedProductSelection(record.productIds, {
      max: MAX_CATEGORY_PRODUCT_ORDER,
    }),
  });
}

export type RelatedProductOverrideSelection = Readonly<{
  productId: string;
  relatedProductIds: readonly string[];
}>;

/**
 * Manual related picks for one product.
 *
 * Self-reference is refused here *and* by the `RelatedProductOverride_no_self_reference` CHECK
 * (ADR §7). Two gates rather than one because this predicate is intra-row, which is the narrow class
 * of invariant the database can genuinely enforce — unlike top-level exclusivity, which ADR §4.5
 * records as application-enforced precisely because it is not.
 */
export function parseRelatedProductOverrides(input: unknown): RelatedProductOverrideSelection {
  if (typeof input !== "object" || input === null) {
    throw new MerchandisingError("merchandising-shape");
  }
  const record = input as Record<string, unknown>;

  const productId = typeof record.productId === "string" ? record.productId.trim() : "";
  if (productId.length === 0 || productId.length > MAX_PRODUCT_ID_LENGTH) {
    throw new MerchandisingError("merchandising-invalid-product");
  }

  const relatedProductIds = parseOrderedProductSelection(record.relatedProductIds, {
    max: MAX_RELATED_PRODUCT_OVERRIDES,
  });
  if (relatedProductIds.includes(productId)) {
    throw new MerchandisingError("merchandising-self-reference");
  }

  return Object.freeze({ productId, relatedProductIds });
}

export type CategoryEditorialMediaInput = Readonly<{
  categoryKey: CategoryKey;
  heroImageUrl: string | null;
  megaMenuImageUrl: string | null;
}>;

/**
 * Category editorial and mega-menu media (ADR §6).
 *
 * Both URLs go through `parseTrustedProductImageUrl`, the same reviewed host contract the rest of
 * the storefront media uses, so an admin cannot put an untrusted origin in front of a shopper. An
 * absent or empty value is `null` — meaning "no editorial image", which the UI answers with its
 * approved no-image behaviour — while a *present but untrusted* URL is a refusal. Silently nulling
 * a bad URL would look identical to clearing the field and would hide the mistake.
 */
export function parseCategoryEditorialMedia(input: unknown): CategoryEditorialMediaInput {
  if (typeof input !== "object" || input === null) {
    throw new MerchandisingError("merchandising-shape");
  }
  const record = input as Record<string, unknown>;

  const parseOptionalImage = (value: unknown): string | null => {
    if (value === undefined || value === null || value === "") return null;
    const url = parseTrustedProductImageUrl(value);
    if (!url) throw new MerchandisingError("merchandising-invalid-media-url");
    return url;
  };

  return Object.freeze({
    categoryKey: requireCategoryKey(record.categoryKey),
    heroImageUrl: parseOptionalImage(record.heroImageUrl),
    megaMenuImageUrl: parseOptionalImage(record.megaMenuImageUrl),
  });
}
