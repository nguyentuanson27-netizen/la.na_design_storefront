import { prisma } from "../db/prisma.ts";
import { getLocale } from "../i18n/server.ts";
import { createProductTranslationRepository } from "./product-translation-repository.ts";
import {
  overlayProductName,
  overlayProductTranslation,
  type TranslatableProduct,
} from "./product-translation.ts";

/**
 * Puts the request's language on products read from the catalog.
 *
 * Applied by the route loaders to what the catalog returned, never inside the catalog's own
 * caches: those hold the Vietnamese source and serve every visitor, so a translated name written
 * into one would reach the next Vietnamese shopper. For Vietnamese this does nothing and costs
 * nothing -- no query, the same objects back. For English it is one query for the whole list.
 * A failed read degrades to the Vietnamese rather than failing the page.
 */

const repository = createProductTranslationRepository(prisma);

/** Listings, cards and cart lines: the name only. */
export async function localizeProductNames<T extends Readonly<{ id: string; name: string }>>(
  products: readonly T[],
): Promise<readonly T[]> {
  if (products.length === 0 || (await getLocale()) !== "en") return products;
  try {
    const translations = await repository.readMany(
      products.map((product) => product.id),
      "en",
    );
    return products.map((product) => overlayProductName(product, translations.get(product.id)));
  } catch {
    return products;
  }
}

/** A product page: the name, the editorial blocks and the SEO fields. */
export async function localizeProduct<T extends TranslatableProduct & Readonly<{ id: string }>>(
  product: T,
): Promise<T> {
  if ((await getLocale()) !== "en") return product;
  try {
    const translations = await repository.readMany([product.id], "en");
    return overlayProductTranslation(product, translations.get(product.id));
  } catch {
    return product;
  }
}

/**
 * A cart view's line names. Cart lines carry a slug rather than a product id, and the view -- not the
 * lines the quote and its proof are computed from -- is what is translated, so no price, proof or
 * order input ever sees an English name.
 */
export async function localizeCartViewNames<
  V extends Readonly<{
    lines: readonly Readonly<{ productName: string; productSlug: string | null }>[];
  }>,
>(view: V): Promise<V> {
  if (view.lines.length === 0 || (await getLocale()) !== "en") return view;
  try {
    const names = await repository.readNamesBySlug(
      view.lines.flatMap((line) => (line.productSlug === null ? [] : [line.productSlug])),
      "en",
    );
    if (names.size === 0) return view;
    return {
      ...view,
      lines: view.lines.map((line) => {
        const name = line.productSlug === null ? undefined : names.get(line.productSlug);
        return name === undefined ? line : { ...line, productName: name };
      }),
    };
  } catch {
    return view;
  }
}

/** A listing result shaped `{ products, ...rest }`, with its products translated. */
export async function localizeListing<
  P extends Readonly<{ id: string; name: string }>,
  R extends Readonly<{ products: readonly P[] }>,
>(result: R): Promise<R> {
  const products = await localizeProductNames(result.products);
  return products === result.products ? result : { ...result, products: products as R["products"] };
}
