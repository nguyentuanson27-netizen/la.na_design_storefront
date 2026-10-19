import { requireAdminSession } from "../auth/authorization.ts";
import {
  COLLECTION_DEFINITION_LIMITS,
  CollectionDefinitionError,
  parseCollectionDefinition,
  type CollectionDefinition,
} from "./collection-definition.ts";

const MAX_INTEGER_ID = 2_147_483_647;
const CATEGORY_ID_PATTERN = /^[0-9]+$/;
const HOMEPAGE_POSITION_PATTERN = /^[1-6]$/;
const INDEX_POSITION_PATTERN = /^[1-9][0-9]?$/;
const MAX_CATEGORY_CSV_LENGTH = COLLECTION_DEFINITION_LIMITS.pancakeCategoryCount * 12;
const INVALID_HOMEPAGE_POSITION = Symbol("invalid-homepage-position");
const INVALID_INDEX_POSITION = Symbol("invalid-index-position");

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

type LegacyCollectionDefinitionAdminDependencies = {
  saveDefinition(definition: CollectionDefinition): Promise<CollectionDefinition>;
};

type ExplicitCollectionDefinitionAdminDependencies = {
  createDefinition(definition: CollectionDefinition): Promise<CollectionDefinition | null>;
  updateExistingDefinition(
    targetSlug: unknown,
    fields: Omit<CollectionDefinition, "slug">,
  ): Promise<CollectionDefinition | null>;
};

type CollectionDefinitionAdminDependencies =
  | LegacyCollectionDefinitionAdminDependencies
  | ExplicitCollectionDefinitionAdminDependencies;

type SlugOverride = { value: unknown };

function hasExplicitPersistence(
  dependencies: CollectionDefinitionAdminDependencies,
): dependencies is ExplicitCollectionDefinitionAdminDependencies {
  return (
    "createDefinition" in dependencies &&
    typeof dependencies.createDefinition === "function" &&
    "updateExistingDefinition" in dependencies &&
    typeof dependencies.updateExistingDefinition === "function"
  );
}

function parsePublicationCheckbox(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return false;
  return value === "on" ? true : null;
}

function parseHomepagePosition(value: unknown): number | null | typeof INVALID_HOMEPAGE_POSITION {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !HOMEPAGE_POSITION_PATTERN.test(value)) {
    return INVALID_HOMEPAGE_POSITION;
  }
  return Number(value);
}

function parseIndexPosition(value: unknown): number | null | typeof INVALID_INDEX_POSITION {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID_INDEX_POSITION;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return INDEX_POSITION_PATTERN.test(trimmed) ? Number(trimmed) : INVALID_INDEX_POSITION;
}

function parseCategoryIdsCsv(value: unknown): number[] | null {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || value.length > MAX_CATEGORY_CSV_LENGTH) return null;

  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > COLLECTION_DEFINITION_LIMITS.pancakeCategoryCount ||
    entries.some((entry) => entry.length === 0 || !CATEGORY_ID_PATTERN.test(entry))
  ) {
    return null;
  }

  const ids = entries.map((entry) => Number(entry));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1 || id > MAX_INTEGER_ID)) {
    return null;
  }

  return new Set(ids).size === ids.length ? ids : null;
}

function parseAdminInput(input: unknown, slugOverride?: SlugOverride): CollectionDefinition | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  const isPublished = parsePublicationCheckbox(record.isPublished);
  const homepagePosition = parseHomepagePosition(record.homepagePosition);
  const indexPosition = parseIndexPosition(record.indexPosition);
  const pancakeCategoryIds = parseCategoryIdsCsv(record.pancakeCategoryIds);
  if (
    isPublished === null ||
    homepagePosition === INVALID_HOMEPAGE_POSITION ||
    indexPosition === INVALID_INDEX_POSITION ||
    pancakeCategoryIds === null
  ) {
    return null;
  }

  try {
    return parseCollectionDefinition({
      slug: slugOverride ? slugOverride.value : record.slug,
      title: record.title,
      description: record.description,
      seoTitle: record.seoTitle,
      seoDescription: record.seoDescription,
      isPublished,
      homepagePosition,
      indexPosition,
      pancakeCategoryIds,
    });
  } catch (error) {
    if (error instanceof CollectionDefinitionError) return null;
    throw error;
  }
}

function invalidInputResult() {
  return { ok: false, reason: "INVALID_INPUT" } as const;
}

export function createCollectionDefinitionAdminService(
  dependencies: CollectionDefinitionAdminDependencies,
) {
  async function create(session: AdminSessionCandidate, input: unknown) {
    requireAdminSession(session);

    const definition = parseAdminInput(input);
    if (!definition) return invalidInputResult();

    try {
      const persisted = hasExplicitPersistence(dependencies)
        ? await dependencies.createDefinition(definition)
        : await dependencies.saveDefinition(definition);
      if (!persisted) return invalidInputResult();

      return {
        ok: true,
        definition: persisted,
      } as const;
    } catch (error) {
      if (error instanceof CollectionDefinitionError) return invalidInputResult();
      throw error;
    }
  }

  async function update(session: AdminSessionCandidate, targetSlug: unknown, input: unknown) {
    requireAdminSession(session);

    const definition = parseAdminInput(input, { value: targetSlug });
    if (!definition || !hasExplicitPersistence(dependencies)) return invalidInputResult();

    const { slug: _slug, ...fields } = definition;
    try {
      const persisted = await dependencies.updateExistingDefinition(targetSlug, fields);
      if (!persisted) return invalidInputResult();

      return {
        ok: true,
        definition: persisted,
      } as const;
    } catch (error) {
      if (error instanceof CollectionDefinitionError) return invalidInputResult();
      throw error;
    }
  }

  return {
    save: create,
    create,
    update,
  };
}
