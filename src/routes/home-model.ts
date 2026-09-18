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
 * domain test runner can load.
 *
 * Master spec §16 fixes the section order, and two of those sections are product grids that must
 * stay separate reads all the way through: `Hàng mới về` is a recency read, Featured (§20) is a
 * manual list whose emptiness is meaningful. They are two fields here rather than one merged list
 * precisely so an empty Featured section cannot quietly inherit new arrivals.
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
  newArrivals: readonly HomeCard[];
  featured: readonly HomeCard[];
  /** The brand-story photograph (§23). Null when the catalog carries no trusted photography. */
  storyPanel: HomeEditorialPanel;
  collections: readonly HomeCollectionLink[];
}>;

type CardGridInput = Readonly<{
  products: readonly HomeProduct[];
  pricingRule?: StorefrontPricingRule;
  /** Prebuilt on the server, so a click handler never reassembles a payload from the DOM. */
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

export type HomeViewModelInput = Readonly<{
  newArrivals: CardGridInput;
  featured: CardGridInput;
  collections: readonly HomeCollectionLink[];
}>;

export function buildHomeCards({
  products,
  pricingRule,
  selectEventBySlug,
}: CardGridInput): readonly HomeCard[] {
  return Object.freeze(
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
  );
}

export function buildHomeViewModel({
  newArrivals,
  featured,
  collections,
}: HomeViewModelInput): HomeViewModel {
  // One panel, for the brand story's photograph. The hero is no longer one of these: §17 makes it
  // campaign media with its own destination, decided by `buildHomeHeroSlides`.
  const [storyPanel] = selectEditorialPanels(newArrivals.products, 1);

  return Object.freeze({
    newArrivals: buildHomeCards(newArrivals),
    featured: buildHomeCards(featured),
    storyPanel: storyPanel ?? null,
    collections: Object.freeze([...collections]),
  });
}
