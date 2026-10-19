import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  COLLECTION_DEFINITION_LIMITS,
  CollectionDefinitionError,
  parseCollectionDefinition,
  parseCollectionSlug,
  toStorefrontCollectionTitle,
  type CollectionDefinition,
} from "./collection-definition.ts";

const MAX_COLLECTION_LIST = 100;

const collectionSelect = {
  slug: true,
  title: true,
  description: true,
  seoTitle: true,
  seoDescription: true,
  isPublished: true,
  homepagePosition: true,
  indexPosition: true,
  pancakeCategoryIds: true,
} as const;

const publicCollectionSelect = {
  slug: true,
  title: true,
  description: true,
  seoTitle: true,
  seoDescription: true,
  heroImageUrl: true,
  heroImageMobileUrl: true,
  galleryImageUrls: true,
  videoSrcUrl: true,
  videoPosterUrl: true,
  featuredProductSlugs: true,
} as const;

function withStorefrontTitle<T extends { title: string }>(definition: T): T {
  return { ...definition, title: toStorefrontCollectionTitle(definition.title) };
}

function parseCollectionListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COLLECTION_LIST) {
    throw new RangeError(`Collection list limit must be between 1 and ${MAX_COLLECTION_LIST}`);
  }
  return limit;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function parseMutableDefinition(
  targetSlug: unknown,
  input: unknown,
): CollectionDefinition {
  const slug = parseCollectionSlug(targetSlug);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CollectionDefinitionError("collection-shape");
  }

  return parseCollectionDefinition({
    ...(input as Record<string, unknown>),
    slug,
  });
}

export function createCollectionDefinitionRepository(client: PrismaClient) {
  async function saveDefinition(input: unknown): Promise<CollectionDefinition> {
    const definition = parseCollectionDefinition(input);
    const { slug, ...fields } = definition;

    try {
      return await client.collectionDefinition.upsert({
        where: { slug },
        create: { slug, ...fields },
        update: fields,
        select: collectionSelect,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new CollectionDefinitionError("collection-homepage-position");
      }
      throw error;
    }
  }

  async function createDefinition(input: unknown): Promise<CollectionDefinition | null> {
    const definition = parseCollectionDefinition(input);
    const result = await client.collectionDefinition.createMany({
      data: [definition],
      skipDuplicates: true,
    });

    return result.count === 1 ? definition : null;
  }

  async function updateExistingDefinition(
    targetSlug: unknown,
    input: unknown,
  ): Promise<CollectionDefinition | null> {
    const definition = parseMutableDefinition(targetSlug, input);
    const { slug, ...fields } = definition;

    try {
      const result = await client.collectionDefinition.updateMany({
        where: { slug },
        data: fields,
      });

      return result.count === 1 ? definition : null;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new CollectionDefinitionError("collection-homepage-position");
      }
      throw error;
    }
  }

  async function listForAdmin(limit: number) {
    return client.collectionDefinition.findMany({
      take: parseCollectionListLimit(limit),
      orderBy: [{ title: "asc" }, { slug: "asc" }],
      select: collectionSelect,
    });
  }

  /**
   * Published definitions in the `/collections` index order, up to `limit` of them.
   *
   * The page's exclusions never use up the cap: filtering one capped read would let excluded rows
   * ahead of position `limit` push real collections off the end. `excludeSlugs` are excluded in
   * the query. `withStory` means a description with a non-whitespace character, which a published
   * definition needs for its own route to render; Prisma's filters cannot express that (admin
   * trims on save, but a legacy or hand-written row of spaces may exist), so it is decided in SQL:
   * one query picks the page's slugs, already ordered and capped, and a second reads their fields.
   * Two reads however many blank rows there are, and `limit` bounds both.
   */
  async function listPublished(
    limit: number,
    options: Readonly<{ excludeSlugs?: readonly string[]; withStory?: boolean }> = {},
  ) {
    const take = parseCollectionListLimit(limit);
    const { excludeSlugs = [], withStory = false } = options;

    if (!withStory) {
      const definitions = await client.collectionDefinition.findMany({
        where: {
          isPublished: true,
          ...(excludeSlugs.length > 0 ? { slug: { notIn: [...excludeSlugs] } } : {}),
        },
        take,
        // The merchandiser's order first; collections with no position follow, alphabetically.
        orderBy: [{ indexPosition: { sort: "asc", nulls: "last" } }, { slug: "asc" }],
        select: publicCollectionSelect,
      });
      return definitions.map(withStorefrontTitle);
    }

    // The same order as above, in SQL. `~ '\S'` is "has a non-whitespace character"; NULL fails it.
    const page = await client.$queryRaw<{ slug: string }[]>`
      SELECT "slug" FROM "CollectionDefinition"
      WHERE "isPublished" = true
        AND "slug" <> ALL(${[...excludeSlugs]}::text[])
        AND "description" ~ '\\S'
      ORDER BY "indexPosition" ASC NULLS LAST, "slug" ASC
      LIMIT ${take}
    `;
    if (page.length === 0) return [];

    const slugs = page.map(({ slug }) => slug);
    const definitions = await client.collectionDefinition.findMany({
      where: { isPublished: true, slug: { in: slugs } },
      select: publicCollectionSelect,
    });
    const bySlug = new Map(definitions.map((definition) => [definition.slug, definition]));
    // A row unpublished between the two reads is simply left out.
    return slugs.flatMap((slug) => {
      const definition = bySlug.get(slug);
      return definition ? [withStorefrontTitle(definition)] : [];
    });
  }

  async function listHomepageMerchandising() {
    const definitions = await client.collectionDefinition.findMany({
      where: {
        isPublished: true,
        homepagePosition: { not: null },
      },
      take: COLLECTION_DEFINITION_LIMITS.homepagePosition,
      orderBy: { homepagePosition: "asc" },
      select: publicCollectionSelect,
    });
    return definitions.map(withStorefrontTitle);
  }

  async function findPublishedBySlug(slug: unknown) {
    const parsedSlug = parseCollectionSlug(slug);
    const definition = await client.collectionDefinition.findFirst({
      where: {
        slug: parsedSlug,
        isPublished: true,
      },
      select: publicCollectionSelect,
    });
    return definition ? withStorefrontTitle(definition) : null;
  }

  async function resolveMembershipSlugs(slugs: string[]): Promise<string[] | null> {
    if (slugs.length === 0) return [];
    if (slugs.length > MAX_COLLECTION_LIST) {
      throw new RangeError(`Collection membership cannot exceed ${MAX_COLLECTION_LIST} entries`);
    }

    const parsed = slugs.map((slug) => parseCollectionSlug(slug));
    const unique = new Set(parsed);
    if (unique.size !== parsed.length) {
      return null;
    }
    const canonical = [...unique].sort();
    const existing = await client.collectionDefinition.findMany({
      where: { slug: { in: canonical } },
      select: { slug: true },
      orderBy: { slug: "asc" },
    });

    if (existing.length !== canonical.length) return null;
    return existing.map(({ slug }) => slug);
  }

  return {
    saveDefinition,
    createDefinition,
    updateExistingDefinition,
    listForAdmin,
    listPublished,
    listHomepageMerchandising,
    findPublishedBySlug,
    resolveMembershipSlugs,
  };
}
