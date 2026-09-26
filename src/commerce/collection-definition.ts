const COLLECTION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_INTEGER_ID = 2_147_483_647;

export const COLLECTION_DEFINITION_LIMITS = {
  slug: 48,
  title: 500,
  description: 50_000,
  seoTitle: 500,
  seoDescription: 2_000,
  pancakeCategoryCount: 100,
  homepagePosition: 6,
} as const;

export type CollectionDefinitionReason =
  | "collection-shape"
  | "collection-slug"
  | "collection-title"
  | "collection-description"
  | "collection-seo-title"
  | "collection-seo-description"
  | "collection-publish-state"
  | "collection-homepage-position"
  | "collection-pos-category";

export class CollectionDefinitionError extends Error {
  readonly reason: CollectionDefinitionReason;

  constructor(reason: CollectionDefinitionReason) {
    super("Collection definition is invalid");
    this.name = "CollectionDefinitionError";
    this.reason = reason;
  }
}

export type CollectionDefinition = {
  slug: string;
  title: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  isPublished: boolean;
  homepagePosition: number | null;
  pancakeCategoryIds: number[];
};

function parseRequiredText(value: unknown, maxLength: number, reason: CollectionDefinitionReason) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new CollectionDefinitionError(reason);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new CollectionDefinitionError(reason);
  return normalized;
}

function parseOptionalText(value: unknown, maxLength: number, reason: CollectionDefinitionReason) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new CollectionDefinitionError(reason);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseHomepagePosition(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > COLLECTION_DEFINITION_LIMITS.homepagePosition
  ) {
    throw new CollectionDefinitionError("collection-homepage-position");
  }
  return value as number;
}

function parsePancakeCategoryIds(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > COLLECTION_DEFINITION_LIMITS.pancakeCategoryCount) {
    throw new CollectionDefinitionError("collection-pos-category");
  }
  const ids = value.map((id) => {
    if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > MAX_INTEGER_ID) {
      throw new CollectionDefinitionError("collection-pos-category");
    }
    return id as number;
  });
  return [...new Set(ids)].sort((left, right) => left - right);
}

export function parseCollectionSlug(value: unknown): string {
  const slug = parseRequiredText(value, COLLECTION_DEFINITION_LIMITS.slug, "collection-slug");
  if (!COLLECTION_SLUG_PATTERN.test(slug)) {
    throw new CollectionDefinitionError("collection-slug");
  }
  return slug;
}

export function parseCollectionDefinition(input: unknown): CollectionDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CollectionDefinitionError("collection-shape");
  }
  const record = input as Record<string, unknown>;
  const slug = parseCollectionSlug(record.slug);

  const title = parseRequiredText(record.title, COLLECTION_DEFINITION_LIMITS.title, "collection-title");
  const description = parseOptionalText(record.description, COLLECTION_DEFINITION_LIMITS.description, "collection-description");
  const seoTitle = parseOptionalText(record.seoTitle, COLLECTION_DEFINITION_LIMITS.seoTitle, "collection-seo-title");
  const seoDescription = parseOptionalText(record.seoDescription, COLLECTION_DEFINITION_LIMITS.seoDescription, "collection-seo-description");
  const isPublished = record.isPublished ?? false;
  if (typeof isPublished !== "boolean") throw new CollectionDefinitionError("collection-publish-state");
  if (isPublished && description === null) throw new CollectionDefinitionError("collection-description");

  return {
    slug,
    title,
    description,
    seoTitle,
    seoDescription,
    isPublished,
    homepagePosition: parseHomepagePosition(record.homepagePosition),
    pancakeCategoryIds: parsePancakeCategoryIds(record.pancakeCategoryIds),
  };
}

/**
 * The title a shopper reads. Merchandisers name collections "BST <tên>" (bộ sưu tập) in admin, but
 * every storefront surface already says it is a collection, so the prefix is dropped on the way
 * out. Admin keeps the stored title untouched; a title that is only the prefix is kept as is.
 */
export function toStorefrontCollectionTitle(title: string): string {
  const stripped = title.replace(/^\s*BST(?:\s*[:\-–—.]\s*|\s+)/iu, "").trim();
  return stripped.length > 0 ? stripped : title;
}
