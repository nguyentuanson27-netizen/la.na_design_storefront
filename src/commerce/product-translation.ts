/**
 * A product's name and editorial copy in another language.
 *
 * The Vietnamese is the source of truth and lives where it always did (`ProductMirror.name`, which
 * the Pancake sync owns, and `ProductContent`, which the editorial form owns). A translation is an
 * overlay: it fills only the fields an admin wrote, and a field left empty falls back to the
 * Vietnamese rather than leaving a hole. So a half-translated product still renders completely.
 *
 * Pure -- no database, no request -- so the overlay can be tested and so the storefront runtime, the
 * admin form and the SEO builders share one definition of what a translation may contain.
 */

export const PRODUCT_TRANSLATION_LOCALES = ["en"] as const;
export type ProductTranslationLocale = (typeof PRODUCT_TRANSLATION_LOCALES)[number];

export const PRODUCT_TRANSLATION_LIMITS = {
  name: 300,
  editorialField: 50_000,
  craftDetailCount: 30,
  craftDetail: 500,
  seoTitle: 500,
  seoDescription: 2_000,
} as const;

export type ProductTranslation = Readonly<{
  name: string | null;
  editorialDescription: string | null;
  material: string | null;
  craftDetails: readonly string[];
  careInstructions: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}>;

export const EMPTY_PRODUCT_TRANSLATION: ProductTranslation = Object.freeze({
  name: null,
  editorialDescription: null,
  material: null,
  craftDetails: Object.freeze([]) as readonly string[],
  careInstructions: null,
  seoTitle: null,
  seoDescription: null,
});

/** The fields of a product the storefront carries and a translation may replace. */
export type TranslatableProduct = Readonly<{
  name: string;
  editorialDescription?: string | null;
  material?: string | null;
  craftDetails?: readonly string[];
  careInstructions?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
}>;

function filled(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().length > 0 ? value : null;
}

/** The name alone, for listings, cards and cart lines. */
export function overlayProductName<T extends Readonly<{ name: string }>>(
  product: T,
  translation: Pick<ProductTranslation, "name"> | undefined,
): T {
  const name = filled(translation?.name);
  return name === null ? product : { ...product, name };
}

/** The whole page's worth: the name, the editorial blocks and the SEO fields. */
export function overlayProductTranslation<T extends TranslatableProduct>(
  product: T,
  translation: ProductTranslation | undefined,
): T {
  if (translation === undefined) return product;
  const craftDetails = translation.craftDetails.filter((detail) => detail.trim().length > 0);
  return {
    ...product,
    name: filled(translation.name) ?? product.name,
    ...(product.editorialDescription === undefined
      ? {}
      : { editorialDescription: filled(translation.editorialDescription) ?? product.editorialDescription }),
    ...(product.material === undefined ? {} : { material: filled(translation.material) ?? product.material }),
    ...(product.craftDetails === undefined
      ? {}
      : { craftDetails: craftDetails.length > 0 ? craftDetails : product.craftDetails }),
    ...(product.careInstructions === undefined
      ? {}
      : { careInstructions: filled(translation.careInstructions) ?? product.careInstructions }),
    ...(product.seoTitle === undefined ? {} : { seoTitle: filled(translation.seoTitle) ?? product.seoTitle }),
    ...(product.seoDescription === undefined
      ? {}
      : { seoDescription: filled(translation.seoDescription) ?? product.seoDescription }),
  };
}

export type ProductTranslationInput = Readonly<{
  name: unknown;
  editorialDescription: unknown;
  material: unknown;
  craftDetails: unknown;
  careInstructions: unknown;
  seoTitle: unknown;
  seoDescription: unknown;
}>;

export type ProductTranslationParseResult =
  | Readonly<{ ok: true; value: ProductTranslation }>
  | Readonly<{ ok: false; field: keyof ProductTranslationInput }>;

function parseText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return null;
  return text.length <= max ? text : undefined;
}

/**
 * What the admin form submitted, validated. Empty text becomes `null` (no overlay for that field);
 * `craftDetails` is one entry per non-empty line. Anything over a limit is refused with the field
 * named, never silently cut.
 */
export function parseProductTranslationInput(input: ProductTranslationInput): ProductTranslationParseResult {
  const name = parseText(input.name, PRODUCT_TRANSLATION_LIMITS.name);
  if (name === undefined) return { ok: false, field: "name" };
  const editorialDescription = parseText(input.editorialDescription, PRODUCT_TRANSLATION_LIMITS.editorialField);
  if (editorialDescription === undefined) return { ok: false, field: "editorialDescription" };
  const material = parseText(input.material, PRODUCT_TRANSLATION_LIMITS.editorialField);
  if (material === undefined) return { ok: false, field: "material" };
  const careInstructions = parseText(input.careInstructions, PRODUCT_TRANSLATION_LIMITS.editorialField);
  if (careInstructions === undefined) return { ok: false, field: "careInstructions" };
  const seoTitle = parseText(input.seoTitle, PRODUCT_TRANSLATION_LIMITS.seoTitle);
  if (seoTitle === undefined) return { ok: false, field: "seoTitle" };
  const seoDescription = parseText(input.seoDescription, PRODUCT_TRANSLATION_LIMITS.seoDescription);
  if (seoDescription === undefined) return { ok: false, field: "seoDescription" };

  let craftDetails: string[] = [];
  if (input.craftDetails !== null && input.craftDetails !== undefined) {
    if (typeof input.craftDetails !== "string") return { ok: false, field: "craftDetails" };
    craftDetails = input.craftDetails
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (
      craftDetails.length > PRODUCT_TRANSLATION_LIMITS.craftDetailCount ||
      craftDetails.some((line) => line.length > PRODUCT_TRANSLATION_LIMITS.craftDetail)
    ) {
      return { ok: false, field: "craftDetails" };
    }
  }

  return {
    ok: true,
    value: { name, editorialDescription, material, craftDetails, careInstructions, seoTitle, seoDescription },
  };
}

/** True when a translation has nothing in it, so saving it can delete the row instead. */
export function isEmptyProductTranslation(translation: ProductTranslation): boolean {
  return (
    translation.name === null &&
    translation.editorialDescription === null &&
    translation.material === null &&
    translation.craftDetails.length === 0 &&
    translation.careInstructions === null &&
    translation.seoTitle === null &&
    translation.seoDescription === null
  );
}
