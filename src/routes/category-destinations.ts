import { FLATTENED_CATEGORIES } from "../brand/category.config.ts";

export type CategoryDestination = Readonly<{ key: string; href: string; label: string }>;

/**
 * Every category route's destination, keyed by the stable code name the brand config declares.
 *
 * Derived from `CATEGORY_NAVIGATION` rather than restated: the slugs and labels are brand
 * vocabulary and exist once, in `src/brand`. A page module selects its own destination by key.
 *
 * This is a `.ts` module on purpose, separate from `category.tsx`. The data carries no JSX, and the
 * domain tests run under `node --experimental-strip-types`, which cannot load a `.tsx` module — so
 * a test that wants the destinations would otherwise have to import the renderer to reach them.
 */
export const CATEGORY_DESTINATIONS: Readonly<Record<string, CategoryDestination>> = Object.freeze(
  Object.fromEntries(
    FLATTENED_CATEGORIES.map((category) => [
      category.key,
      Object.freeze({ key: category.key, href: category.href, label: category.label }),
    ]),
  ),
);
