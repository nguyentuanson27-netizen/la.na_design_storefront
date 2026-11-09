import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  EMPTY_PRODUCT_TRANSLATION,
  isEmptyProductTranslation,
  type ProductTranslation,
  type ProductTranslationLocale,
} from "./product-translation.ts";

type Db = Pick<PrismaClient, "productTranslation">;

function toTranslation(row: {
  name: string | null;
  editorialDescription: string | null;
  material: string | null;
  craftDetails: string[];
  careInstructions: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}): ProductTranslation {
  return {
    name: row.name,
    editorialDescription: row.editorialDescription,
    material: row.material,
    craftDetails: row.craftDetails,
    careInstructions: row.careInstructions,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}

const SELECT = {
  productId: true,
  name: true,
  editorialDescription: true,
  material: true,
  craftDetails: true,
  careInstructions: true,
  seoTitle: true,
  seoDescription: true,
} as const;

export function createProductTranslationRepository(db: Db) {
  return {
    /** One product's translation, or the empty one (every field falls back). */
    async read(productId: string, locale: ProductTranslationLocale): Promise<ProductTranslation> {
      const row = await db.productTranslation.findUnique({
        where: { productId_locale: { productId, locale } },
        select: SELECT,
      });
      return row === null ? EMPTY_PRODUCT_TRANSLATION : toTranslation(row);
    },

    /** Translations for many products in one query; a product without one is simply absent. */
    async readMany(
      productIds: readonly string[],
      locale: ProductTranslationLocale,
    ): Promise<ReadonlyMap<string, ProductTranslation>> {
      const ids = [...new Set(productIds)];
      if (ids.length === 0) return new Map();
      const rows = await db.productTranslation.findMany({
        where: { productId: { in: ids }, locale },
        select: SELECT,
      });
      return new Map(rows.map((row) => [row.productId, toTranslation(row)]));
    },

    /** Translated names keyed by the product's slug, for lines that carry a slug and no id (the cart). */
    async readNamesBySlug(
      slugs: readonly string[],
      locale: ProductTranslationLocale,
    ): Promise<ReadonlyMap<string, string>> {
      const unique = [...new Set(slugs)];
      if (unique.length === 0) return new Map();
      const rows = await db.productTranslation.findMany({
        where: { locale, name: { not: null }, product: { slug: { in: unique } } },
        select: { name: true, product: { select: { slug: true } } },
      });
      return new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.product.slug, row.name] as const])));
    },

    /** Saves a translation; one with nothing in it deletes the row, so "cleared" and "never set" agree. */
    async save(
      productId: string,
      locale: ProductTranslationLocale,
      translation: ProductTranslation,
    ): Promise<void> {
      if (isEmptyProductTranslation(translation)) {
        await db.productTranslation.deleteMany({ where: { productId, locale } });
        return;
      }
      const data = {
        name: translation.name,
        editorialDescription: translation.editorialDescription,
        material: translation.material,
        craftDetails: [...translation.craftDetails],
        careInstructions: translation.careInstructions,
        seoTitle: translation.seoTitle,
        seoDescription: translation.seoDescription,
      };
      await db.productTranslation.upsert({
        where: { productId_locale: { productId, locale } },
        create: { productId, locale, ...data },
        update: data,
      });
    },
  };
}
