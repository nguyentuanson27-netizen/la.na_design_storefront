import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import { selectEditorialPanels, type EditorialPanel } from "./editorial-panels.ts";

/**
 * Everything the home route decides, as one pure function.
 *
 * The loader fetches; this turns what came back into what the page renders. It is separate from
 * `home.ts` because that file reaches the catalog runtime and `next/server`, neither of which the
 * domain test runner can load -- and the editorial picks below are the part worth testing, because
 * their fallback chain is the kind of thing that silently degrades to a blank panel.
 *
 * No pricing is decided here: every card comes from `buildProductCardModel`, which is where the
 * money rules live.
 */

/** The fields of a catalog product this route actually reads. */
export type HomeProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  media?: StorefrontProductMedia | null;
  variants: StorefrontVariantFacts[];
}>;

export type HomeCollectionLink = Readonly<{ slug: string; title: string }>;

/** One editorial panel. See `selectEditorialPanels` for the fallback rule it follows. */
export type HomeEditorialPanel = EditorialPanel;

export type HomeCard = Readonly<{ id: string; model: ProductCardModel }>;

export type HomeViewModel = Readonly<{
  cards: readonly HomeCard[];
  hero: HomeEditorialPanel;
  lookbookLarge: HomeEditorialPanel;
  lookbookSmall: HomeEditorialPanel;
  collections: readonly HomeCollectionLink[];
}>;

export type HomeViewModelInput = Readonly<{
  products: readonly HomeProduct[];
  pricingRule?: StorefrontPricingRule;
  collections: readonly HomeCollectionLink[];
  /** Prebuilt on the server, so a click handler never reassembles a payload from the DOM. */
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

export function buildHomeViewModel({
  products,
  pricingRule,
  collections,
  selectEventBySlug,
}: HomeViewModelInput): HomeViewModel {
  // Three panels: hero, then the two lookbook slots.
  const [hero, lookbookLarge, lookbookSmall] = selectEditorialPanels(products, 3);

  return Object.freeze({
    cards: Object.freeze(
      products.map((product) =>
        Object.freeze({
          id: product.id,
          model: buildProductCardModel({
            slug: product.slug,
            name: product.name,
            media: product.media,
            variants: product.variants,
            pricingRule,
            selectEvent: selectEventBySlug.get(product.slug) ?? null,
          }),
        }),
      ),
    ),
    hero: hero ?? null,
    lookbookLarge: lookbookLarge ?? null,
    lookbookSmall: lookbookSmall ?? null,
    collections: Object.freeze([...collections]),
  });
}
