import { requireAdminSession } from "../auth/authorization.ts";
import {
  isApprovedSizeGuideId,
  type ApprovedSizeGuideId,
} from "../brand/size-guide.config.ts";
import {
  readPublishMetadataReadiness,
  type PublishMetadataRequirement,
} from "../seo/product-metadata-uniqueness.ts";

export const PRODUCT_CONTENT_LIMITS = {
  productId: 128,
  editorialField: 50_000,
  seoTitle: 500,
  seoDescription: 2_000,
  collectionCount: 8,
  collectionSlug: 48,
} as const;

export const PRODUCT_CONTENT_BULK_STATUS_LIMIT = 100;
export const PRODUCT_CONTENT_BULK_COLLECTION_LIMIT = 100;
export const PRODUCT_CONTENT_STATUSES = ["DRAFT", "REVIEWED", "PUBLISHED"] as const;
export const PRODUCT_CONTENT_COLLECTION_OPERATIONS = ["add", "remove"] as const;
export type ProductContentStatus = (typeof PRODUCT_CONTENT_STATUSES)[number];
export type ProductContentCollectionOperation =
  (typeof PRODUCT_CONTENT_COLLECTION_OPERATIONS)[number];

const COLLECTION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type AdminSessionCandidate =
  | {
      user: {
        id: string;
        role?: string | null;
      };
      session: {
        id: string;
      };
    }
  | null
  | undefined;

export type ProductContentSnapshot = {
  productId: string;
  status: ProductContentStatus;
  editorialDescription: string | null;
  careInstructions: string | null;
  sizeGuide: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  collectionSlugs: string[];
};

export type BulkProductContentStatusUpdate = {
  productIds: string[];
  status: ProductContentStatus;
};

/**
 * B5: why a `PUBLISHED` write was refused.
 *
 * `SEO_PAIR_CONFLICT` carries the slugs already holding the pair so the editor can open the other
 * product instead of guessing which one it collided with. The two requirement reasons carry an
 * empty list: nothing else owns the copy, the product's own fields are simply incomplete.
 */
export type ProductContentPublishBlock = {
  reason: PublishMetadataRequirement | "SEO_PAIR_CONFLICT";
  conflictingSlugs: readonly string[];
};

export type SaveProductContentOutcome =
  | { ok: true; content: ProductContentSnapshot }
  | { ok: false; block: ProductContentPublishBlock };

export type BulkProductContentStatusResult =
  | { ok: true; updatedCount: number }
  | { ok: false; reason: "PRODUCT_NOT_FOUND" }
  | {
      ok: false;
      reason: "SEO_INCOMPLETE" | "SEO_PAIR_CONFLICT";
      blockedSlugs: readonly string[];
    };

export type BulkProductCollectionUpdate = {
  productIds: string[];
  collectionSlug: string;
  operation: ProductContentCollectionOperation;
};

export type BulkProductCollectionResult =
  | { ok: true; matchedCount: number; changedCount: number }
  | { ok: false; reason: "PRODUCT_NOT_FOUND" | "COLLECTION_LIMIT_REACHED" };

type ProductContentAdminDependencies = {
  productExists(productId: string): Promise<boolean>;
  resolveCollectionSlugs(collectionSlugs: string[]): Promise<string[] | null>;
  saveContent(content: ProductContentSnapshot): Promise<SaveProductContentOutcome>;
};

type ProductContentBulkStatusAdminDependencies = {
  updateStatusesAtomically(
    input: BulkProductContentStatusUpdate,
  ): Promise<BulkProductContentStatusResult>;
};

type ProductContentBulkCollectionAdminDependencies = {
  resolveCollectionSlugs(collectionSlugs: string[]): Promise<string[] | null>;
  updateCollectionMembershipAtomically(
    input: BulkProductCollectionUpdate,
  ): Promise<BulkProductCollectionResult>;
};

type ParsedTextField = { ok: true; value: string | null } | { ok: false };
type ParsedCollectionSlugs = { ok: true; value: string[] } | { ok: false };

function parseTextField(value: unknown, maxLength: number): ParsedTextField {
  if (typeof value !== "string" || value.length > maxLength) {
    return { ok: false };
  }

  const normalized = value.trim();
  return { ok: true, value: normalized.length > 0 ? normalized : null };
}

export type ParsedSizeGuideField =
  | { ok: true; value: ApprovedSizeGuideId | null }
  | { ok: false };

export function parseSizeGuideField(value: unknown): ParsedSizeGuideField {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }

  if (isApprovedSizeGuideId(trimmed)) {
    return { ok: true, value: trimmed };
  }

  return { ok: false };
}

function parseCollectionSlugs(value: unknown): ParsedCollectionSlugs {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: [] };
  }
  if (typeof value !== "string") return { ok: false };

  const rawSlugs = value.split(",").map((entry) => entry.trim());
  if (
    rawSlugs.length > PRODUCT_CONTENT_LIMITS.collectionCount ||
    rawSlugs.some(
      (slug) =>
        slug.length === 0 ||
        slug.length > PRODUCT_CONTENT_LIMITS.collectionSlug ||
        !COLLECTION_SLUG_PATTERN.test(slug),
    )
  ) {
    return { ok: false };
  }

  const unique = new Set(rawSlugs);
  if (unique.size !== rawSlugs.length) return { ok: false };
  return { ok: true, value: rawSlugs };
}

function parseStatus(value: unknown): ProductContentStatus | null {
  if (value === undefined || value === null) return "DRAFT";
  if (typeof value !== "string") return null;
  return PRODUCT_CONTENT_STATUSES.find((status) => status === value) ?? null;
}

function parseExplicitStatus(value: unknown): ProductContentStatus | null {
  if (typeof value !== "string") return null;
  return PRODUCT_CONTENT_STATUSES.find((status) => status === value) ?? null;
}

function parseProductId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PRODUCT_CONTENT_LIMITS.productId ||
    value !== value.trim()
  ) {
    return null;
  }
  return value;
}

function parseProductContentInput(input: unknown): ProductContentSnapshot | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const productId = parseProductId(record.productId);
  if (productId === null) {
    return null;
  }

  const status = parseStatus(record.status);
  const editorialDescription = parseTextField(
    record.editorialDescription,
    PRODUCT_CONTENT_LIMITS.editorialField,
  );
  const careInstructions = parseTextField(
    record.careInstructions,
    PRODUCT_CONTENT_LIMITS.editorialField,
  );
  const sizeGuide = parseSizeGuideField(record.sizeGuide);
  const seoTitle = parseTextField(record.seoTitle, PRODUCT_CONTENT_LIMITS.seoTitle);
  const seoDescription = parseTextField(
    record.seoDescription,
    PRODUCT_CONTENT_LIMITS.seoDescription,
  );
  const collectionSlugs = parseCollectionSlugs(record.collectionSlugs);

  if (
    status === null ||
    !editorialDescription.ok ||
    !careInstructions.ok ||
    !sizeGuide.ok ||
    !seoTitle.ok ||
    !seoDescription.ok ||
    !collectionSlugs.ok
  ) {
    return null;
  }

  return {
    productId,
    status,
    editorialDescription: editorialDescription.value,
    careInstructions: careInstructions.value,
    sizeGuide: sizeGuide.value,
    seoTitle: seoTitle.value,
    seoDescription: seoDescription.value,
    collectionSlugs: collectionSlugs.value,
  };
}

function parseBulkProductContentStatusInput(
  input: unknown,
): BulkProductContentStatusUpdate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const productIds = record.productIds;
  const status = parseExplicitStatus(record.status);
  if (
    !Array.isArray(productIds) ||
    productIds.length < 1 ||
    productIds.length > PRODUCT_CONTENT_BULK_STATUS_LIMIT ||
    status === null
  ) {
    return null;
  }

  const parsedProductIds = productIds.map(parseProductId);
  if (parsedProductIds.some((productId) => productId === null)) {
    return null;
  }

  const canonicalProductIds = parsedProductIds as string[];
  if (new Set(canonicalProductIds).size !== canonicalProductIds.length) {
    return null;
  }

  return { productIds: canonicalProductIds, status };
}


function parseCollectionOperation(value: unknown): ProductContentCollectionOperation | null {
  if (typeof value !== "string") return null;
  return PRODUCT_CONTENT_COLLECTION_OPERATIONS.find((operation) => operation === value) ?? null;
}

function parseSingleCollectionSlug(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PRODUCT_CONTENT_LIMITS.collectionSlug ||
    !COLLECTION_SLUG_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function parseBulkProductIds(value: unknown, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) {
    return null;
  }

  const parsed = value.map(parseProductId);
  if (parsed.some((productId) => productId === null)) {
    return null;
  }

  const canonical = parsed as string[];
  return new Set(canonical).size === canonical.length ? canonical : null;
}

function parseBulkProductCollectionInput(input: unknown): BulkProductCollectionUpdate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const productIds = parseBulkProductIds(record.productIds, PRODUCT_CONTENT_BULK_COLLECTION_LIMIT);
  const collectionSlug = parseSingleCollectionSlug(record.collectionSlug);
  const operation = parseCollectionOperation(record.operation);
  if (productIds === null || collectionSlug === null || operation === null) {
    return null;
  }

  return { productIds, collectionSlug, operation };
}

export function createProductContentAdminService({
  productExists,
  resolveCollectionSlugs,
  saveContent,
}: ProductContentAdminDependencies) {
  async function update(session: AdminSessionCandidate, input: unknown) {
    requireAdminSession(session);

    const content = parseProductContentInput(input);
    if (!content) {
      return { ok: false, reason: "INVALID_INPUT" } as const;
    }

    if (!(await productExists(content.productId))) {
      return { ok: false, reason: "PRODUCT_NOT_FOUND" } as const;
    }

    // B5: a product's own SEO copy has to be complete before it can be published, and that is
    // answerable from this one row, so it is refused here rather than after a round trip. The
    // cross-product pair collision needs the published catalog and is settled inside the write.
    if (content.status === "PUBLISHED") {
      const readiness = readPublishMetadataReadiness(content);
      if (!readiness.ok) {
        return { ok: false, reason: readiness.reason, conflictingSlugs: [] } as const;
      }
    }

    const resolvedCollectionSlugs =
      content.collectionSlugs.length === 0
        ? []
        : await resolveCollectionSlugs(content.collectionSlugs);
    if (resolvedCollectionSlugs === null) {
      return { ok: false, reason: "COLLECTION_NOT_FOUND" } as const;
    }

    const saved = await saveContent({
      ...content,
      collectionSlugs: resolvedCollectionSlugs,
    });
    if (!saved.ok) {
      return {
        ok: false,
        reason: saved.block.reason,
        conflictingSlugs: saved.block.conflictingSlugs,
      } as const;
    }

    return { ok: true, content: saved.content } as const;
  }

  return { update };
}

export function createProductContentBulkStatusAdminService({
  updateStatusesAtomically,
}: ProductContentBulkStatusAdminDependencies) {
  async function update(session: AdminSessionCandidate, input: unknown) {
    requireAdminSession(session);

    const parsed = parseBulkProductContentStatusInput(input);
    if (!parsed) {
      return { ok: false, reason: "INVALID_INPUT" } as const;
    }

    try {
      return await updateStatusesAtomically(parsed);
    } catch {
      return { ok: false, reason: "UNAVAILABLE" } as const;
    }
  }

  return { update };
}

/**
 * Bulk membership is an explicit add/remove of exactly one validated collection. It never
 * reconstructs a full `ProductContent` snapshot from browser data, so unrelated memberships,
 * editorial text, SEO and mirrored fields cannot be overwritten by a stale directory page.
 */
export function createProductContentBulkCollectionAdminService({
  resolveCollectionSlugs,
  updateCollectionMembershipAtomically,
}: ProductContentBulkCollectionAdminDependencies) {
  async function update(session: AdminSessionCandidate, input: unknown) {
    requireAdminSession(session);

    const parsed = parseBulkProductCollectionInput(input);
    if (!parsed) {
      return { ok: false, reason: "INVALID_INPUT" } as const;
    }

    const resolved = await resolveCollectionSlugs([parsed.collectionSlug]);
    if (resolved === null || resolved.length !== 1 || resolved[0] !== parsed.collectionSlug) {
      return { ok: false, reason: "COLLECTION_NOT_FOUND" } as const;
    }

    try {
      return await updateCollectionMembershipAtomically(parsed);
    } catch {
      return { ok: false, reason: "UNAVAILABLE" } as const;
    }
  }

  return { update };
}
